/**
 * Reconciling an ambiguous `POST /api/v1/apps`.
 *
 * The observed failure is HTTP 500 `UnknownError` AFTER the installation
 * commits, with a subsequent GET returning 200. These pin the two reactions
 * that must never happen: trusting an arbitrary GET 200, and repeating the
 * mutation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { installUploadedPack } from '../src/deploy.mjs';

/** Stub the Cribl API. `onInstall` decides what the mutation does. */
function stubApi({ appsBefore = [], appsAfter, onInstall }) {
  const calls = [];
  let installs = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path.endsWith('/apps')) {
      const items = installs === 0 ? appsBefore : (appsAfter ?? appsBefore);
      return new Response(JSON.stringify({ items }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    installs += 1;
    return onInstall();
  };
  return { calls, installCount: () => installs };
}

const pkg = { name: 'demo-app', displayName: 'Demo', version: '1.2.0' };
const ok = () => new Response(JSON.stringify({ items: [{ id: 'demo-app', version: '1.2.0' }], count: 1 }), {
  status: 200, headers: { 'content-type': 'application/json' },
});
const unknownError = () => new Response(JSON.stringify({ status: 'error', message: 'UnknownError' }), {
  status: 500, headers: { 'content-type': 'application/json' },
});

const original = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = original; });

await test('a clean install is unchanged behavior', async () => {
  stubApi({ appsBefore: [], onInstall: ok });
  const result = await installUploadedPack({ baseUrl: 'https://x', token: 't', source: 's', pkg });
  assert.equal(result.count, 1);
});

await test('skips the mutation entirely when the version already matches', async () => {
  const api = stubApi({ appsBefore: [{ id: 'demo-app', version: '1.2.0' }], onInstall: ok });
  const result = await installUploadedPack({ baseUrl: 'https://x', token: 't', source: 's', pkg });
  assert.equal(result.unchanged, true);
  assert.equal(api.installCount(), 0);
});

await test('reconciles a 500 that actually committed, without repeating it', async () => {
  const api = stubApi({
    appsBefore: [],
    appsAfter: [{ id: 'demo-app', version: '1.2.0' }],
    onInstall: unknownError,
  });
  const result = await installUploadedPack({ baseUrl: 'https://x', token: 't', source: 's', pkg });
  assert.equal(result.reconciled, true);
  assert.equal(result.previousVersion, null);
  // The mutation ran exactly once. A blind repeat is a second install of
  // unknown effect.
  assert.equal(api.installCount(), 1);
});

await test('a same-version redeploy says the artifact cannot be confirmed', async () => {
  // A GET 200 here proves only that SOME artifact of this version is
  // installed — not that it is the one just built.
  const api = stubApi({ appsBefore: [{ id: 'demo-app', version: '1.2.0' }], onInstall: ok });
  const result = await installUploadedPack({ baseUrl: 'https://x', token: 't', source: 's', pkg });
  assert.equal(result.unchanged, true);
  assert.equal(api.installCount(), 0);
  assert.match(result.warning, /no artifact digest/);
});

await test('reconciles a 500 that committed an upgrade, proven by the version change', async () => {
  const api = stubApi({
    appsBefore: [{ id: 'demo-app', version: '1.1.0' }],
    appsAfter: [{ id: 'demo-app', version: '1.2.0' }],
    onInstall: unknownError,
  });
  const result = await installUploadedPack({ baseUrl: 'https://x', token: 't', source: 's', pkg });
  assert.equal(result.reconciled, true);
  assert.equal(result.previousVersion, '1.1.0');
  assert.equal(api.installCount(), 1, 'the mutation must not be repeated');
  assert.match(result.warning, /1\.1\.0 to 1\.2\.0/);
});

await test('fails when the error left the wrong version installed', async () => {
  stubApi({
    appsBefore: [{ id: 'demo-app', version: '1.1.0' }],
    appsAfter: [{ id: 'demo-app', version: '1.1.0' }],
    onInstall: unknownError,
  });
  await assert.rejects(
    () => installUploadedPack({ baseUrl: 'https://x', token: 't', source: 's', pkg }),
    /still has demo-app@1\.1\.0, not 1\.2\.0/,
  );
});

await test('fails when nothing is installed after the error', async () => {
  stubApi({ appsBefore: [], appsAfter: [], onInstall: unknownError });
  await assert.rejects(
    () => installUploadedPack({ baseUrl: 'https://x', token: 't', source: 's', pkg }),
    /no app is installed/,
  );
});
