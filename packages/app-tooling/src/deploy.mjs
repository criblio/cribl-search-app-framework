import { access, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { loadDotEnv } from './dotenv.mjs';
import { inspectPack } from './inspect.mjs';
import { runCommand } from './process.mjs';

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
  if (requireNoPolicies && hasEntries(item.policies ?? {})) {
    throw new Error(`Preinstall check found undeclared policies: ${JSON.stringify(item.policies)}`);
  }
}

export async function installUploadedPack({ baseUrl, token, source, pkg }) {
  const apps = await apiJson({ baseUrl, token, path: '/apps' });
  const installed = (apps.items ?? []).find((item) => item.id === pkg.name || item.name === pkg.name);
  if (installed?.version === pkg.version) {
    return { items: [installed], count: 1, unchanged: true };
  }
  if (installed) {
    return apiJson({
      baseUrl,
      token,
      path: `/apps/${encodeURIComponent(pkg.name)}`,
      method: 'PATCH',
      body: { source, displayName: pkg.displayName, version: pkg.version },
    });
  }
  return apiJson({
    baseUrl,
    token,
    path: '/apps',
    method: 'POST',
    body: { source, displayName: pkg.displayName, version: pkg.version },
  });
}

/** Validate and install or upgrade one exact Cribl App candidate without force. */
export async function deployApp({
  root = process.cwd(),
  artifact,
  requireEmptyProxies = false,
  requireNoPolicies = false,
  provision = true,
} = {}) {
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
  await inspectPack(artifactPath, { root: rootDir, requireEmptyProxies });
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
    requireNoPolicies,
  });
  const installed = await installUploadedPack({ baseUrl, token, source, pkg });

  const provisionScript = join(rootDir, 'scripts', 'provision.ts');
  const hasProvisioner = provision && await access(provisionScript).then(() => true).catch(() => false);
  if (hasProvisioner) await runCommand('npx', ['tsx', 'scripts/provision.ts'], rootDir);
  return { artifact: artifactPath, source, installed };
}
