import { access, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { loadDotEnv } from './dotenv.mjs';
import { inspectPack } from './inspect.mjs';
import { runCommand } from './process.mjs';
import { diffProxies, parseProxiesYaml } from './proxies.mjs';

function oauthEndpoints(baseUrl) {
  const staging = /cribl-staging\.cloud/.test(baseUrl);
  return staging
    ? {
        tokenUrl: 'https://login.cribl-staging.cloud/oauth/token',
        audience: 'https://api.cribl-staging.cloud',
      }
    : {
        tokenUrl: 'https://login.cribl.cloud/oauth/token',
        audience: 'https://api.cribl.cloud',
      };
}

async function getBearerToken({ tokenUrl, audience, clientId, clientSecret }) {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience,
    }),
  });
  if (!response.ok) {
    throw new Error(`OAuth token exchange failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();
  if (!data.access_token) throw new Error('OAuth response is missing access_token');
  return data.access_token;
}

async function apiJson({ baseUrl, token, path, method = 'GET', body }) {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function uploadPack({ baseUrl, token, filename, bytes }) {
  const response = await fetch(
    `${baseUrl}/api/v1/apps?filename=${encodeURIComponent(filename)}`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        accept: 'application/json',
      },
      body: bytes,
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`Upload failed (${response.status}): ${text.slice(0, 500)}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Upload response was not JSON: ${text.slice(0, 200)}`);
  }
  const source = parsed.source ?? parsed.items?.[0]?.source ?? parsed.id ?? parsed.items?.[0]?.id;
  if (!source) throw new Error('Upload response is missing source/id');
  return source;
}

function hasEntries(value) {
  if (Array.isArray(value)) return value.length > 0;
  return !!value && typeof value === 'object' && Object.keys(value).length > 0;
}

async function preinstallCheck({
  baseUrl,
  token,
  source,
  requireEmptyProxies,
  expectedProxies,
  requireNoPolicies,
}) {
  const result = await apiJson({
    baseUrl,
    token,
    path: '/apps/preinstall-check',
    method: 'POST',
    body: { source },
  });
  const item = result.items?.[0] ?? result;
  const dangerous = item.dangerousFileTypes ?? item.dangerousFiles ?? [];
  if (hasEntries(dangerous)) {
    throw new Error(`Preinstall check found dangerous files: ${JSON.stringify(dangerous)}`);
  }
  if (requireEmptyProxies && hasEntries(item.proxies ?? {})) {
    throw new Error(`Preinstall check found proxy capability: ${JSON.stringify(item.proxies)}`);
  }
  if (expectedProxies !== undefined) {
    const differences = diffProxies(item.proxies ?? {}, expectedProxies, {
      actualLabel: 'server-reported proxies',
    });
    if (differences.length > 0) {
      throw new Error(
        'Preinstall check proxies do not match the expected manifest:\n' +
        differences.map((entry) => `  - ${entry}`).join('\n'),
      );
    }
  }
  if (requireNoPolicies && hasEntries(item.policies ?? {})) {
    throw new Error(`Preinstall check found undeclared policies: ${JSON.stringify(item.policies)}`);
  }
}

/** Read the installed record for this app, or null when absent. */
async function readInstalled({ baseUrl, token, pkg }) {
  const apps = await apiJson({ baseUrl, token, path: '/apps' });
  return (apps.items ?? []).find((item) => item.id === pkg.name || item.name === pkg.name) ?? null;
}

/**
 * Decide what an ambiguous install response actually did.
 *
 * `POST /api/v1/apps` has been observed returning HTTP 500
 * `{"status":"error","message":"UnknownError"}` AFTER committing the
 * installation — a GET of the app then returns 200. Two wrong reactions
 * follow from that, and this exists to prevent both:
 *
 *  - Treating any subsequent GET 200 as proof of success. A record that was
 *    already there before this deploy proves only that some version is
 *    installed, not that ours is.
 *  - Repeating the POST. It is a mutation whose first attempt may well have
 *    succeeded, so a blind retry is a second install of unknown effect.
 *
 * So reconciliation compares the installed VERSION against the one we meant
 * to install, and reports honest uncertainty when the version cannot settle
 * it: a same-version record that existed beforehand is indistinguishable
 * from one this deploy wrote, unless the platform exposes an artifact digest
 * or an operation receipt. It does not today — that gap is recorded for the
 * Cribl install API owner.
 */
async function reconcileAmbiguousInstall({ baseUrl, token, pkg, before, error }) {
  let after = null;
  try {
    after = await readInstalled({ baseUrl, token, pkg });
  } catch (readError) {
    throw new Error(
      `Install failed (${error.message}) and the follow-up read also failed ` +
      `(${readError.message}). The installation state is unknown; check the workspace before retrying.`,
    );
  }
  if (!after) {
    // Nothing installed, so the mutation definitively did not commit. The
    // one state where retrying is safe — and that is the caller's call.
    throw new Error(`Install failed and no app is installed: ${error.message}`);
  }
  if (after.version !== pkg.version) {
    throw new Error(
      `Install failed (${error.message}) and the workspace still has ` +
      `${pkg.name}@${after.version}, not ${pkg.version}. Nothing was installed by this run.`,
    );
  }
  // The expected version is present. Whether that PROVES this run installed
  // it depends on what was there beforehand:
  //
  //  - absent before      → this run created it. Proven.
  //  - a different version → this run upgraded it. Proven, because the
  //                          version changed and nothing else was running.
  //
  // A same-version record before and after cannot reach here: that case is
  // short-circuited as `unchanged` before any mutation. So the reconciliation
  // is always provable at this point, and the honest uncertainty lives in
  // that short-circuit instead — see installUploadedPack.
  return {
    items: [after],
    count: 1,
    reconciled: true,
    previousVersion: before?.version ?? null,
    warning:
      `${pkg.name}@${pkg.version} is installed, but the install call returned an error ` +
      `(${error.message}). Reconciled by reading the installed record back: it went from ` +
      `${before ? `${before.version} to ${pkg.version}` : `absent to ${pkg.version}`}. ` +
      'The install was NOT repeated.',
  };
}

export async function installUploadedPack({ baseUrl, token, source, pkg }) {
  const before = await readInstalled({ baseUrl, token, pkg });
  if (before?.version === pkg.version) {
    // Same version already installed, so there is nothing to do — but say
    // plainly that this does not prove the RUNNING artifact matches the one
    // just built. The platform exposes no installed artifact digest or
    // operation receipt, so same-version records are indistinguishable.
    // Bumping the version is the only way to be certain, and reinstalling
    // over it blind would be a mutation justified by an assumption.
    return {
      items: [before],
      count: 1,
      unchanged: true,
      warning:
        `${pkg.name}@${pkg.version} is already installed, so nothing was uploaded over it. ` +
        'The platform exposes no artifact digest, so this does not confirm the installed ' +
        'artifact is identical to the one just built — bump the version to be certain.',
    };
  }
  const request = before
    ? {
        path: `/apps/${encodeURIComponent(pkg.name)}`,
        method: 'PATCH',
      }
    : { path: '/apps', method: 'POST' };
  try {
    return await apiJson({
      baseUrl,
      token,
      ...request,
      body: { source, displayName: pkg.displayName, version: pkg.version },
    });
  } catch (error) {
    // Never retry here. The request may have committed; see
    // reconcileAmbiguousInstall.
    return reconcileAmbiguousInstall({ baseUrl, token, pkg, before, error });
  }
}

/** Validate and install or upgrade one exact Cribl App candidate without force. */
export async function deployApp({
  root = process.cwd(),
  artifact,
  requireEmptyProxies = false,
  proxiesManifest,
  requireNoPolicies = false,
  provision = true,
} = {}) {
  if (requireEmptyProxies && proxiesManifest) {
    throw new Error('--require-empty-proxies and --proxies-manifest are mutually exclusive');
  }
  const rootDir = resolve(root);
  const fileEnv = await loadDotEnv(join(rootDir, '.env')).catch(() => ({}));
  const env = { ...fileEnv, ...process.env };
  for (const key of ['CRIBL_BASE_URL', 'CRIBL_CLIENT_ID', 'CRIBL_CLIENT_SECRET']) {
    if (!env[key]) throw new Error(`${key} is not configured`);
  }
  const baseUrl = env.CRIBL_BASE_URL.replace(/\/$/, '');
  const pkg = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
  let artifactPath;
  if (artifact) {
    artifactPath = resolve(rootDir, artifact);
  } else {
    if (pkg.scripts?.verify) await runCommand('npm', ['run', 'verify'], rootDir);
    await runCommand('npm', ['run', 'package'], rootDir);
    artifactPath = join(rootDir, 'build', `${pkg.name}-${pkg.version}.tgz`);
  }
  await inspectPack(artifactPath, { root: rootDir, requireEmptyProxies, proxiesManifest });
  const expectedProxies = proxiesManifest
    ? parseProxiesYaml(await readFile(resolve(rootDir, proxiesManifest), 'utf8'))
    : undefined;
  const bytes = await readFile(artifactPath);
  const { tokenUrl, audience } = oauthEndpoints(baseUrl);
  const token = await getBearerToken({
    tokenUrl,
    audience,
    clientId: env.CRIBL_CLIENT_ID,
    clientSecret: env.CRIBL_CLIENT_SECRET,
  });
  const source = await uploadPack({ baseUrl, token, filename: basename(artifactPath), bytes });
  await preinstallCheck({
    baseUrl,
    token,
    source,
    requireEmptyProxies,
    expectedProxies,
    requireNoPolicies,
  });
  const installed = await installUploadedPack({ baseUrl, token, source, pkg });

  const provisionScript = join(rootDir, 'scripts', 'provision.ts');
  const hasProvisioner = provision && await access(provisionScript).then(() => true).catch(() => false);
  if (hasProvisioner) await runCommand('npx', ['tsx', 'scripts/provision.ts'], rootDir);
  return { artifact: artifactPath, source, installed };
}
