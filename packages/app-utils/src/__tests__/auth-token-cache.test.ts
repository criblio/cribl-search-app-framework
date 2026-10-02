/**
 * `getCachedBearerToken` — one OAuth exchange per credential per process.
 *
 * APM's Playwright helpers each kept a private cache with a 60 s safety
 * margin: a token handed out seconds before expiry failed API calls midway
 * through a page load. This is that cache, shared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearBearerTokenCache,
  fetchBearerToken,
  getBearerToken,
  getCachedBearerToken,
} from '../auth.js';

const STAGING = { baseUrl: 'https://main-x.cribl-staging.cloud', clientId: 'id', clientSecret: 'secret' };
const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; body: Record<string, unknown> }>;
let nextToken: number;
let expiresIn: number | undefined;

beforeEach(() => {
  calls = [];
  nextToken = 0;
  expiresIn = 3600;
  clearBearerTokenCache();
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    nextToken += 1;
    return new Response(JSON.stringify({ access_token: `t${nextToken}`, expires_in: expiresIn }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe('fetchBearerToken', () => {
  it('reports expiry from expires_in and targets the staging endpoint', async () => {
    const before = Date.now();
    const token = await fetchBearerToken(STAGING);
    expect(token.accessToken).toBe('t1');
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(calls[0].url).toBe('https://login.cribl-staging.cloud/oauth/token');
    expect(calls[0].body).toMatchObject({ grant_type: 'client_credentials', audience: 'https://api.cribl-staging.cloud' });
    expect(await getBearerToken(STAGING)).toBe('t2');
  });
});

describe('getCachedBearerToken', () => {
  it('reuses one token across calls and shares a concurrent exchange', async () => {
    const [a, b] = await Promise.all([getCachedBearerToken(STAGING), getCachedBearerToken(STAGING)]);
    expect([a, b, await getCachedBearerToken(STAGING)]).toEqual(['t1', 't1', 't1']);
    expect(calls).toHaveLength(1);
  });

  it('refreshes once less than the margin remains', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    expect(await getCachedBearerToken(STAGING)).toBe('t1');
    vi.setSystemTime(3_600_000 - 61_000);
    expect(await getCachedBearerToken(STAGING)).toBe('t1');
    vi.setSystemTime(3_600_000 - 59_000);
    expect(await getCachedBearerToken(STAGING)).toBe('t2');
    expect(calls).toHaveLength(2);
  });

  it('keys the cache by credentials', async () => {
    await getCachedBearerToken(STAGING);
    expect(await getCachedBearerToken({ ...STAGING, clientId: 'other' })).toBe('t2');
    expect(await getCachedBearerToken(STAGING)).toBe('t1');
  });

  it('does not cache a failed exchange', async () => {
    const ok = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    await expect(getCachedBearerToken(STAGING)).rejects.toThrow(/401/);
    globalThis.fetch = ok;
    expect(await getCachedBearerToken(STAGING)).toBe('t1');
  });
});
