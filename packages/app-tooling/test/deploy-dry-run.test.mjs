import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deployApp } from '../src/deploy.mjs';

const packModule = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pack.mjs');

/**
 * An app whose `npm run package` behaves like `apps package`: it bumps the
 * patch version in package.json, then packs under the NEW version.
 */
async function bumpingApp() {
  const root = await mkdtemp(join(tmpdir(), 'cribl-app-tooling-deploy-'));
  await mkdir(join(root, 'dist', 'assets'), { recursive: true });
  await writeFile(join(root, 'dist', 'assets', 'app.js'), 'console.log("app")');
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'dist', 'index.html'), '<div id="root"></div>');
  await writeFile(join(root, 'config', 'proxies.yml'), '# none\n');
  await writeFile(join(root, 'scripts', 'provision.ts'), '');
  await writeFile(join(root, 'bump-and-pack.mjs'), `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { packageApp } from ${JSON.stringify(packModule)};
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const [a, b, c] = pkg.version.split('.').map(Number);
    pkg.version = [a, b, c + 1].join('.');
    writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n');
    await packageApp(process.cwd());
  `);
  const pkgText = JSON.stringify({
    name: 'bumping-app',
    version: '1.0.0',
    scripts: { package: 'node bump-and-pack.mjs' },
  });
  await writeFile(join(root, 'package.json'), pkgText);
  return { root, pkgText };
}

function stubFetch(installed) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if (String(url).includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: installed }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const env = { CRIBL_BASE_URL: 'https://example.invalid', CRIBL_CLIENT_ID: 'id', CRIBL_CLIENT_SECRET: 's' };

test('dry run builds the artifact under the bumped version, reads only, and restores package.json', async () => {
  const { root, pkgText } = await bumpingApp();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const fetchStub = stubFetch([{ id: 'bumping-app', version: '1.0.0' }]);
  try {
    // Before the fix the artifact was named from the PRE-package version, so
    // this run would have looked for bumping-app-1.0.0.tgz — the previous
    // run's archive, already installed — and skipped it as unchanged.
    const result = await deployApp({ root, dryRun: true });
    assert.equal(result.artifact, join(root, 'build', 'bumping-app-1.0.1.tgz'));
    assert.equal(result.dryRun.pkg.version, '1.0.1');
    assert.equal(result.dryRun.installedVersion, '1.0.0');
    assert.equal(result.dryRun.action, 'upgrade');
    assert.equal(result.dryRun.provision, true);
    assert.equal(result.dryRun.restoredPackageJson, true);
    assert.match(result.dryRun.sha256, /^[0-9a-f]{64}$/);
    assert.equal('installed' in result, false);
    // Token exchange (a POST to the IdP) and a GET of /apps — no PUT upload,
    // no preinstall check, no install.
    assert.deepEqual(
      fetchStub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
      ['POST /oauth/token', 'GET /api/v1/apps'],
    );
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), pkgText);
  } finally {
    fetchStub.restore();
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  }
});

test('dry run with --artifact reports a same-version skip', async () => {
  const { root } = await bumpingApp();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const fetchStub = stubFetch([{ id: 'bumping-app', version: '1.0.0' }]);
  try {
    const { packageApp } = await import(packModule);
    const artifact = await packageApp(root);
    const result = await deployApp({ root, artifact, dryRun: true, provision: false });
    assert.equal(result.dryRun.action, 'skip (same version already installed)');
    assert.equal(result.dryRun.provision, false);
    assert.equal(result.dryRun.restoredPackageJson, false);
    assert.equal(fetchStub.calls.some((c) => c.method === 'PUT' || c.method === 'PATCH'), false);
  } finally {
    fetchStub.restore();
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  }
});
