import assert from 'node:assert/strict';
import test from 'node:test';
import { installUploadedPack } from '../src/deploy.mjs';

function response(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('same-version deployment is idempotent and never force-installs', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return response({ items: [{ id: 'apm', version: '1.2.3' }] });
  };
  try {
    const result = await installUploadedPack({
      baseUrl: 'https://example.invalid',
      token: 'test-token',
      source: 'candidate.tgz',
      pkg: { name: 'apm', version: '1.2.3', displayName: 'APM' },
    });
    assert.equal(result.unchanged, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'GET');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an existing older app is upgraded with PATCH and no force field', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return response({ items: [{ id: 'apm', version: '1.2.2' }] });
    return response({ items: [{ id: 'apm', version: '1.2.3' }] });
  };
  try {
    await installUploadedPack({
      baseUrl: 'https://example.invalid',
      token: 'test-token',
      source: 'candidate.tgz',
      pkg: { name: 'apm', version: '1.2.3', displayName: 'APM' },
    });
    assert.equal(calls[1].init.method, 'PATCH');
    const body = JSON.parse(calls[1].init.body);
    assert.deepEqual(body, { source: 'candidate.tgz', displayName: 'APM', version: '1.2.3' });
    assert.equal('force' in body, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
