/**
 * Strict app-KV behavior, including regression (e): member keys containing
 * `|`, `/`, `~`, and `%`.
 *
 * The distinction these exist to protect: a JSON "key not found" is
 * ordinary absence and may fall back to defaults, while an HTML 404 means
 * the request never reached the KV store — and falling back there invents
 * state the app then writes back over whatever was really stored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KvError, isLegacyMemberKey, kvGetJson, kvPutJson, kvPutText, memberKey, parseMemberKey } from '../kv.js';
import { loadSettings, saveSettings, saveSettingsResult } from '../settings.js';

const API = 'https://api.example/api/v1';
const original = globalThis.fetch;

// `apiUrl()` reads `window.CRIBL_API_URL`; these run under node, so the
// global is stubbed rather than pulling in a DOM environment for two fields.
beforeEach(() => {
  (globalThis as { window?: unknown }).window = { CRIBL_API_URL: API };
});
afterEach(() => {
  globalThis.fetch = original;
  delete (globalThis as { window?: unknown }).window;
});

/** Serve one canned response and record the URL it was asked for. */
function serve(body: string, init: ResponseInit = {}) {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  globalThis.fetch = (async (url: string | URL | Request, requestInit?: RequestInit) => {
    urls.push(String(url));
    if (requestInit) inits.push(requestInit);
    return new Response(body, { status: 200, ...init });
  }) as typeof fetch;
  return { urls, inits };
}

describe('URL shape', () => {
  it('calls ${apiUrl()}/kvstore/<key> and never injects /a/<appId>', async () => {
    // Injecting the scope ourselves double-scopes the path, and the 404
    // that produces is indistinguishable from a missing key.
    const { urls } = serve(JSON.stringify({ dataset: 'otel' }));
    await kvGetJson('settings');
    expect(urls[0]).toBe(`${API}/kvstore/settings`);
    expect(urls[0]).not.toContain('/a/');
    expect(urls[0]).not.toContain('/m/');
  });
});

describe('absence versus routing failure', () => {
  it('treats a JSON "Key not found" as absence', async () => {
    serve(JSON.stringify({ message: 'Key not found' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
    expect(await kvGetJson('missing')).toEqual({ found: false });
  });

  it('treats an HTML 404 as a routing failure, never as defaults', async () => {
    // The failure this prevents: substituting defaults here invents state,
    // which the app then writes back over whatever was really stored.
    serve('<!doctype html><html><body>app shell</body></html>', {
      status: 404, headers: { 'content-type': 'text/html' },
    });
    const error = await kvGetJson('settings').catch((e: unknown) => e as KvError);
    expect(error).toBeInstanceOf(KvError);
    expect((error as KvError).isRoutingFailure).toBe(true);
    expect((error as KvError).status).toBe(404);
  });

  it('detects an HTML body even when the content type lies', async () => {
    serve('<html>nope</html>', { status: 200, headers: { 'content-type': 'application/json' } });
    await expect(kvGetJson('settings')).rejects.toMatchObject({ bodyKind: 'html' });
  });

  it('rejects a non-JSON 200 rather than guessing', async () => {
    serve('not json at all', { status: 200, headers: { 'content-type': 'text/plain' } });
    await expect(kvGetJson('settings')).rejects.toThrow(/not JSON/);
  });

  it('never puts the body in the error', async () => {
    // A KV value can hold anything, including a credential.
    serve('{"token":"super-secret-value"}x', {
      status: 500, headers: { 'content-type': 'application/json' },
    });
    const error = await kvGetJson('creds').catch((e: unknown) => e as KvError);
    expect(JSON.stringify({ m: (error as KvError).message, k: (error as KvError).bodyKind }))
      .not.toContain('super-secret-value');
  });
});

describe('writes check response.ok', () => {
  it('throws when the store rejects the write', async () => {
    // saveSettings used to ignore response.ok, so a rejected save reported
    // success and the change vanished on the next load.
    serve('forbidden', { status: 403, headers: { 'content-type': 'text/plain' } });
    await expect(kvPutJson('settings', { dataset: 'otel' })).rejects.toThrow(/failed with 403/);
  });

  it('names a routing failure on write too', async () => {
    serve('<html>login</html>', { status: 401, headers: { 'content-type': 'text/html' } });
    await expect(kvPutText('settings', 'x')).rejects.toThrow(/never reached the KV store/);
  });

  it('sends raw text for a credential without reading it back', async () => {
    const { urls, inits } = serve('', { status: 200 });
    await kvPutText('credential', 'secret-token');
    expect(urls).toHaveLength(1);                      // write only, no read-back
    expect(inits[0].method).toBe('PUT');
    expect(new Headers(inits[0].headers).get('content-type')).toBe('text/plain');
  });
});

describe('settings compatibility', () => {
  it('still merges stored values over defaults', async () => {
    serve(JSON.stringify({ dataset: 'custom' }), { headers: { 'content-type': 'application/json' } });
    expect(await loadSettings({ dataset: 'otel', extra: 1 }))
      .toEqual({ dataset: 'custom', extra: 1 });
  });

  it('still falls back to defaults on genuine absence', async () => {
    serve(JSON.stringify({ message: 'Key not found' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
    expect(await loadSettings({ dataset: 'otel' })).toEqual({ dataset: 'otel' });
  });

  it('saveSettings now surfaces a rejected write (behavior change)', async () => {
    serve('nope', { status: 500 });
    await expect(saveSettings({ dataset: 'otel' })).rejects.toBeInstanceOf(KvError);
  });

  it('saveSettingsResult reports it without unwinding', async () => {
    serve('nope', { status: 500 });
    const result = await saveSettingsResult({ dataset: 'otel' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBeInstanceOf(KvError);
  });
});

describe('(e) member keys are router-safe and reversible', () => {
  const hostile = [
    'plain', 'has|pipe', 'has/slash', 'has~tilde', 'has%percent', 'has:colon',
    'all|of/them~at%once:too', 'user@example.com', 'a b c', 'ünïcödé', '日本語', '💥',
  ];

  it.each(hostile)('round-trips %s exactly', (id) => {
    expect(parseMemberKey(memberKey('verdicts', id))).toEqual(['verdicts', id]);
  });

  it.each(hostile)('emits only router-safe characters for %s', (id) => {
    // Measured against live Cribl staging: a key containing a raw `:`
    // returns an HTML 404 (unmatched route), and so do `%7C` and `%2F`.
    // Output is therefore restricted to a strict subset of unreserved
    // path characters rather than to "what encodeURIComponent allows".
    expect(memberKey('verdicts', id)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('separates parts unambiguously even when a part contains the separator', () => {
    // Hex cannot emit `-`, so the separator can never appear inside an
    // encoded part however hostile the input.
    expect(parseMemberKey(memberKey('ns', 'a-b', 'c-d'))).toEqual(['ns', 'a-b', 'c-d']);
    expect(parseMemberKey(memberKey('ns', 'm', ''))).toEqual(['ns', 'm', '']);
  });

  it('carries a version prefix so the shape can change again', () => {
    expect(memberKey('ns', 'm').startsWith('k1-')).toBe(true);
  });

  it('refuses an empty namespace or member id', () => {
    expect(() => memberKey('', 'm')).toThrow(/namespace/);
    expect(() => memberKey('ns', '')).toThrow(/member id/);
  });

  it('rejects a 0.9.0 key rather than reinterpreting it', () => {
    // 0.9.0 joined percent-encoded parts with `:`. Those keys never
    // matched the router, so they hold no data — but misreading one is
    // worse than refusing it.
    const legacy = 'verdicts:user%40example.com';
    expect(() => parseMemberKey(legacy)).toThrow(/Not a k1 member key/);
    expect(isLegacyMemberKey(legacy)).toBe(true);
    expect(isLegacyMemberKey(memberKey('verdicts', 'user@example.com'))).toBe(false);
  });

  it('stays one path segment in a real URL', () => {
    const id = 'all|of/them~at%once:too';
    const key = memberKey('verdicts', id);
    const segments = new URL(`${API}/kvstore/${key}`).pathname.split('/');
    expect(segments[segments.length - 1]).toBe(key);
    expect(parseMemberKey(segments[segments.length - 1])).toEqual(['verdicts', id]);
  });
});

describe('absence is only the real KV missing-key contract', () => {
  it('a 403 "User not found" is an error, not absent data', async () => {
    // The masking defect: /not\s*found/i over any non-OK body reported an
    // authorization failure as "no value yet", after which the app writes
    // defaults over a store it was never allowed to read.
    serve(JSON.stringify({ message: 'User not found' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    });
    await expect(kvGetJson('fixture-key')).rejects.toBeInstanceOf(KvError);
  });

  it('a 500 mentioning "not found" is an error', async () => {
    serve(JSON.stringify({ message: 'upstream not found' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
    await expect(kvGetJson('fixture-key')).rejects.toMatchObject({ status: 500 });
  });

  it('only a 404 JSON {message:"Key not found"} is absence', async () => {
    serve(JSON.stringify({ message: 'Key not found' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
    expect(await kvGetJson('fixture-key')).toEqual({ found: false });
  });

  it('a 404 with a different JSON message is still an error', async () => {
    serve(JSON.stringify({ message: 'App not found' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
    await expect(kvGetJson('fixture-key')).rejects.toBeInstanceOf(KvError);
  });
});
