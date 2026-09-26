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
import { KvError, kvGetJson, kvPutJson, kvPutText, memberKey, parseMemberKey } from '../kv.js';
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

describe('(e) member keys survive hostile ids', () => {
  const hostile = [
    'plain',
    'has|pipe',
    'has/slash',
    'has~tilde',
    'has%percent',
    'all|of/them~at%once',
    'user@example.com',
    'a b c',
  ];

  it.each(hostile)('round-trips %s exactly', (id) => {
    const key = memberKey('verdicts', id);
    expect(parseMemberKey(key)).toEqual(['verdicts', id]);
  });

  it('never emits a character that would invent a path segment', () => {
    for (const id of hostile) {
      const key = memberKey('verdicts', id);
      expect(key).not.toContain('/');
      // `%` only ever appears as the start of an escape, never raw.
      expect(key.replace(/%[0-9A-F]{2}/g, '')).not.toContain('%');
    }
  });

  it('separates parts unambiguously when a part contains the separator', () => {
    // `:` is the separator because encodeURIComponent ESCAPES it, so it can
    // never appear raw inside an encoded part. `~` fails this test — it is
    // unreserved and passes through unescaped — which is why it is not used.
    expect(parseMemberKey(memberKey('ns', 'ends:', 'next'))).toEqual(['ns', 'ends:', 'next']);
    expect(parseMemberKey(memberKey('ns', 'has~tilde'))).toEqual(['ns', 'has~tilde']);
  });

  it('escapes `|` so it cannot be confused with anything', () => {
    expect(memberKey('ns', 'a|b')).toBe('ns:a%7Cb');
  });

  it('refuses an empty namespace or member id', () => {
    expect(() => memberKey('', 'm')).toThrow(/namespace/);
    expect(() => memberKey('ns', '')).toThrow(/member id/);
  });

  it('survives a round trip through a real URL path', () => {
    // The point of the encoding: the key occupies exactly one path segment
    // however hostile the member id is.
    const id = 'all|of/them~at%once';
    const key = memberKey('verdicts', id);
    const url = new URL(`${API}/kvstore/${key}`);
    const segments = url.pathname.split('/');
    expect(segments[segments.length - 1]).toBe(key);   // still one segment
    expect(parseMemberKey(segments[segments.length - 1])).toEqual(['verdicts', id]);
  });
});
