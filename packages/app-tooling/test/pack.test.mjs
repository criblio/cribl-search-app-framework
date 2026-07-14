import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectPack } from '../src/inspect.mjs';
import { packageApp } from '../src/pack.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cribl-app-tooling-'));
  await mkdir(join(root, 'dist', 'assets'), { recursive: true });
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(join(root, 'dist', 'index.html'), '<div id="root"></div>');
  await writeFile(join(root, 'dist', 'assets', 'app.js'), 'console.log("app")');
  await writeFile(join(root, 'config', 'proxies.yml'), '# no external proxies\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture-app',
    version: '1.2.3',
    displayName: 'Fixture',
    scripts: { unsafe: 'ignored' },
    dependencies: { unsafe: 'ignored' },
  }));
  return root;
}

test('package output is deterministic and contains only the app contract', async () => {
  const root = await fixture();
  try {
    const artifact = await packageApp(root);
    const first = await readFile(artifact);
    await packageApp(root);
    const second = await readFile(artifact);
    assert.equal(digest(first), digest(second));
    const report = await inspectPack(artifact, { root, requireEmptyProxies: true });
    assert.equal(report.manifest.name, 'fixture-app');
    assert.equal(report.manifest.version, '1.2.3');
    assert.equal('scripts' in report.manifest, false);
    assert.equal('dependencies' in report.manifest, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('empty-proxy policy is app-selectable and fails closed', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'config', 'proxies.yml'), 'api.example.com:\n  timeout: 1000\n');
    const artifact = await packageApp(root);
    await assert.rejects(
      inspectPack(artifact, { root, requireEmptyProxies: true }),
      /external proxy capability/,
    );
    await inspectPack(artifact, { root, requireEmptyProxies: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
