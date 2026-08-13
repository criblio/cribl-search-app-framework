import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectPack } from '../src/inspect.mjs';
import { packageApp } from '../src/pack.mjs';
import { diffProxies, parseProxiesYaml } from '../src/proxies.mjs';

const FULL_PROXIES = `api.example.com:
  timeout: 10000
  paths:
    allowlist:
      - /v1/chat/
      - /v1/models
    blocklist:
      - /v1/admin/
  headers:
    inject:
      x-api-key: "'static-key'"
      Authorization: "'Bearer ' + kv.apiToken"
    allowlist:
      - content-type
      - accept
`;

async function fixture({ proxies = '# no external proxies\n', manifest } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cribl-app-tooling-'));
  await mkdir(join(root, 'dist', 'assets'), { recursive: true });
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(join(root, 'dist', 'index.html'), '<div id="root"></div>');
  await writeFile(join(root, 'dist', 'assets', 'app.js'), 'console.log("app")');
  await writeFile(join(root, 'config', 'proxies.yml'), proxies);
  if (manifest !== undefined) {
    await writeFile(join(root, 'config', 'proxies.expected.yml'), manifest);
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture-app',
    version: '1.2.3',
    displayName: 'Fixture',
  }));
  return root;
}

test('parseProxiesYaml reads the documented proxies.yml schema', () => {
  const parsed = parseProxiesYaml(`# leading comment

api.example.com:  # inline comment
  timeout: 10000
  paths:
    allowlist:
      - /v1/chat/
  headers:
    inject:
      Authorization: "'Bearer ' + kv.apiToken"
plain.example.com:8443:
  timeout: 5000
`);
  assert.deepEqual(parsed, {
    'api.example.com': {
      timeout: 10000,
      paths: { allowlist: ['/v1/chat/'] },
      headers: { inject: { Authorization: "'Bearer ' + kv.apiToken" } },
    },
    'plain.example.com:8443': { timeout: 5000 },
  });
  assert.deepEqual(parseProxiesYaml('# only comments\n\n'), {});
});

test('an identical committed manifest passes inspection', async () => {
  const root = await fixture({
    proxies: FULL_PROXIES,
    manifest: `# reviewed contract — comments and ordering may differ\n${FULL_PROXIES}`,
  });
  try {
    const artifact = await packageApp(root);
    await inspectPack(artifact, { root, proxiesManifest: 'config/proxies.expected.yml' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an extra domain in the pack fails against the manifest', async () => {
  const root = await fixture({
    proxies: `${FULL_PROXIES}exfil.example.net:\n  timeout: 1000\n`,
    manifest: FULL_PROXIES,
  });
  try {
    const artifact = await packageApp(root);
    await assert.rejects(
      inspectPack(artifact, { root, proxiesManifest: 'config/proxies.expected.yml' }),
      /exfil\.example\.net.*declared in packaged proxies\.yml but not in expected manifest/s,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an extra injected header in the pack fails against the manifest', async () => {
  const root = await fixture({
    proxies: FULL_PROXIES.replace(
      "      x-api-key: \"'static-key'\"\n",
      "      x-api-key: \"'static-key'\"\n      x-sneaky: kv.secretValue\n",
    ),
    manifest: FULL_PROXIES,
  });
  try {
    const artifact = await packageApp(root);
    await assert.rejects(
      inspectPack(artifact, { root, proxiesManifest: 'config/proxies.expected.yml' }),
      /headers\.inject\.x-sneaky: declared in packaged proxies\.yml but not in expected manifest/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an empty manifest behaves exactly like --require-empty-proxies', async () => {
  const emptyRoot = await fixture({ manifest: '# no external proxies allowed\n' });
  try {
    const artifact = await packageApp(emptyRoot);
    await inspectPack(artifact, {
      root: emptyRoot,
      proxiesManifest: 'config/proxies.expected.yml',
    });
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }

  const proxyRoot = await fixture({
    proxies: 'api.example.com:\n  timeout: 1000\n',
    manifest: '# no external proxies allowed\n',
  });
  try {
    const artifact = await packageApp(proxyRoot);
    await assert.rejects(
      inspectPack(artifact, { root: proxyRoot, proxiesManifest: 'config/proxies.expected.yml' }),
      /does not match config\/proxies\.expected\.yml/,
    );
    await assert.rejects(
      inspectPack(artifact, { root: proxyRoot, requireEmptyProxies: true }),
      /external proxy capability/,
    );
  } finally {
    await rm(proxyRoot, { recursive: true, force: true });
  }
});

test('--require-empty-proxies and --proxies-manifest are mutually exclusive', async () => {
  const root = await fixture({ manifest: '# empty\n' });
  try {
    const artifact = await packageApp(root);
    await assert.rejects(
      inspectPack(artifact, {
        root,
        requireEmptyProxies: true,
        proxiesManifest: 'config/proxies.expected.yml',
      }),
      /mutually exclusive/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diffProxies reports every difference and ignores list order', () => {
  assert.deepEqual(diffProxies(
    parseProxiesYaml('a.example.com:\n  paths:\n    allowlist:\n      - /b/\n      - /a/\n'),
    parseProxiesYaml('a.example.com:\n  paths:\n    allowlist:\n      - /a/\n      - /b/\n'),
  ), []);

  const diffs = diffProxies(
    {
      'a.example.com': { timeout: 1000, paths: { allowlist: ['/a/', '/c/'] } },
      'b.example.com': null,
    },
    {
      'a.example.com': { timeout: 2000, paths: { allowlist: ['/a/'], blocklist: ['/x/'] } },
    },
    { actualLabel: 'server-reported proxies' },
  );
  assert.deepEqual(diffs, [
    'a.example.com.paths.allowlist: entry "/c/" is in server-reported proxies but not in expected manifest',
    'a.example.com.paths.blocklist: missing from server-reported proxies; expected manifest declares ["/x/"]',
    'a.example.com.timeout: server-reported proxies has 1000, expected manifest has 2000',
    'b.example.com: declared in server-reported proxies but not in expected manifest (null)',
  ]);
});
