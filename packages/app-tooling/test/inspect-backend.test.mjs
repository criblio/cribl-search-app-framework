import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { backendScripts, inspectPack } from '../src/inspect.mjs';

const execFileAsync = promisify(execFile);

/**
 * Build an archive in the shape `apps package` emits.
 *
 * Deliberately not built with our own packer: the whole point of these is
 * that the archive is produced by the platform CLI now, so the fixture has
 * to model its layout rather than the one `cribl-app-package` used to make.
 */
async function archive({ backendYaml, bundles = [], extra = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cribl-inspect-backend-'));
  const stage = join(root, 'stage');
  await mkdir(join(stage, 'default'), { recursive: true });
  await mkdir(join(stage, 'static', 'assets'), { recursive: true });
  await writeFile(join(stage, 'static', 'index.html'), '<div id="root"></div>');
  await writeFile(join(stage, 'static', 'assets', 'app.js'), 'console.log(1)');
  await writeFile(join(stage, 'default', 'proxies.yml'), '# none\n');
  const identity = { name: 'fixture-app', version: '1.2.3' };
  await writeFile(join(stage, 'package.json'), JSON.stringify(identity));
  if (backendYaml !== undefined) {
    await writeFile(join(stage, 'default', 'backend.yml'), backendYaml);
  }
  if (bundles.length > 0) {
    await mkdir(join(stage, 'default', 'backend'), { recursive: true });
    for (const bundle of bundles) {
      await writeFile(join(stage, 'default', 'backend', bundle), '// bundle\n');
    }
  }
  for (const [rel, body] of Object.entries(extra)) {
    await mkdir(dirname(join(stage, rel)), { recursive: true });
    await writeFile(join(stage, rel), body);
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(identity));
  const artifact = join(root, 'app.tgz');
  await execFileAsync('tar', ['-czf', artifact, '-C', stage, '.']);
  return { root, artifact, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('backendScripts reads declared bundles and ignores commented caps', () => {
  const yaml = [
    'runtime: js',
    'endpoints:',
    '  - name: hello',
    '    script: backend/hello.js',
    '    # timeout: 30',
    '  - name: tick',
    '    script: "backend/tick.js"',
  ].join('\n');
  assert.deepEqual(backendScripts(yaml), ['backend/hello.js', 'backend/tick.js']);
});

test('backendScripts returns nothing for a manifest declaring no endpoints', () => {
  assert.deepEqual(backendScripts('runtime: js\nendpoints: []\n'), []);
});

test('accepts the four default/ config files and backend bundles', async () => {
  const fx = await archive({
    backendYaml: 'endpoints:\n  - name: hello\n    script: backend/hello.js\n',
    bundles: ['hello.js'],
    extra: { 'default/policies.yml': 'policies: []\n', 'default/schedules.yml': '# none\n' },
  });
  try {
    const report = await inspectPack(fx.artifact, { root: fx.root });
    assert.deepEqual(report.endpoints, ['backend/hello.js']);
  } finally {
    await fx.cleanup();
  }
});

test('an app with no backend at all still passes', async () => {
  const fx = await archive();
  try {
    const report = await inspectPack(fx.artifact, { root: fx.root });
    assert.deepEqual(report.endpoints, []);
  } finally {
    await fx.cleanup();
  }
});

test('rejects a manifest declaring a bundle that was never built', async () => {
  // `apps build` and `apps package` are separate steps, so this really does
  // drift — and the app installs fine, then 404s on its own endpoint.
  const fx = await archive({
    backendYaml: 'endpoints:\n  - name: hello\n    script: backend/hello.js\n',
    bundles: [],
  });
  try {
    await assert.rejects(
      () => inspectPack(fx.artifact, { root: fx.root }),
      /declares backend\/hello\.js but the pack has no default\/backend\/hello\.js/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('rejects a bundle no manifest declares', async () => {
  const fx = await archive({ backendYaml: 'endpoints: []\n', bundles: ['orphan.js'] });
  try {
    await assert.rejects(
      () => inspectPack(fx.artifact, { root: fx.root }),
      /ships backend bundles no manifest declares: default\/backend\/orphan\.js/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('accepts the README apps package copies into the archive root', async () => {
  // `apps package` copies <root>/README.md verbatim, and the platform's own
  // AGENTS.md calls it the customer-facing Marketplace overview — so it is
  // intended to ship. Rejecting it failed release:evidence for every app
  // that wrote one, with no opt-out in the packer or this gate.
  const fx = await archive({ extra: { 'README.md': '# My App\n' } });
  try {
    const report = await inspectPack(fx.artifact, { root: fx.root });
    assert.ok(report.files.includes('README.md'));
  } finally {
    await fx.cleanup();
  }
});

test('still rejects a file outside the known layout', async () => {
  const fx = await archive({ extra: { 'default/secrets.env': 'TOKEN=1\n' } });
  try {
    await assert.rejects(
      () => inspectPack(fx.artifact, { root: fx.root }),
      /unexpected files: default\/secrets\.env/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('still rejects an arbitrary root file', async () => {
  // The widened allow-list names README.md specifically. "Any file at the
  // root" would let a stray .env or notes.txt into a published archive.
  const fx = await archive({ extra: { 'notes.txt': 'scratch\n' } });
  try {
    await assert.rejects(
      () => inspectPack(fx.artifact, { root: fx.root }),
      /unexpected files: notes\.txt/,
    );
  } finally {
    await fx.cleanup();
  }
});
