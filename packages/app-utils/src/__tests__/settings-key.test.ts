/**
 * Settings at an app-chosen KV key, merge-on-save, and raw-text KV reads.
 *
 * APM keeps its settings at its own key, so `loadSettings`/`saveSettings`
 * and `<DatasetProvider>` — hard-wired to `settings` — read nothing and it
 * could not adopt them (APM PR #195). Its proxy-header values are raw text,
 * which `kvGetJson` cannot read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KvError, kvGetText } from '../kv.js';
import { loadSettings, saveSettings, saveSettingsResult } from '../settings.js';
import { loadSavedDataset, syncSavedDataset } from '../dataset-settings.js';
import { getCurrentDataset, getDatasetLoadError, setCurrentDataset, setDatasetLoadError } from '../dataset.js';

const API = 'https://api.example/api/v1';
const originalFetch = globalThis.fetch;

interface Call {
  method: string;
  key: string;
  body?: string;
}

/** A fake KV store; `routes` overrides the response for a key. */
function kv(store: Record<string, string>, routes: Record<string, () => Response> = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const key = decodeURIComponent(String(url).slice(`${API}/kvstore/`.length));
    const method = init.method ?? 'GET';
    calls.push({ method, key, body: init.body as string | undefined });
    if (method === 'GET' && routes[key]) return routes[key]();
    if (method === 'PUT') {
      store[key] = init.body as string;
      return new Response('', { status: 200 });
    }
    if (key in store) return new Response(store[key], { status: 200, headers: { 'content-type': 'text/plain' } });
    return new Response(JSON.stringify({ message: 'Key not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}
const html404 = () => new Response('<!doctype html><html></html>', { status: 404, headers: { 'content-type': 'text/html' } });

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { CRIBL_API_URL: API };
  setCurrentDataset('');
  setDatasetLoadError(null);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as { window?: unknown }).window;
  setCurrentDataset('');
  setDatasetLoadError(null);
});

describe('kvGetText', () => {
  it('returns the stored text verbatim, with no JSON parsing', async () => {
    kv({ token: 'Bearer abc.def', json_looking: '{"a":1}', empty: '' });
    expect(await kvGetText('token')).toBe('Bearer abc.def');
    expect(await kvGetText('json_looking')).toBe('{"a":1}');
    expect(await kvGetText('empty')).toBe('');
  });

  it('is null only for the store\'s own missing-key answer', async () => {
    kv({});
    expect(await kvGetText('absent')).toBeNull();
  });

  it('throws KvError for a misroute and for any other failure', async () => {
    kv({}, {
      misrouted: html404,
      forbidden: () => new Response(JSON.stringify({ message: 'User not found' }), { status: 403 }),
      plain404: () => new Response('nope', { status: 404 }),
    });
    const misrouted = await kvGetText('misrouted').catch((e: unknown) => e);
    expect(misrouted).toBeInstanceOf(KvError);
    expect((misrouted as KvError).isRoutingFailure).toBe(true);
    await expect(kvGetText('forbidden')).rejects.toBeInstanceOf(KvError);
    await expect(kvGetText('plain404')).rejects.toBeInstanceOf(KvError);
  });
});

describe('settings at an app-chosen key', () => {
  it('loadSettings / saveSettings honour { key }, and default to settings', async () => {
    const store: Record<string, string> = { apm_settings: JSON.stringify({ dataset: 'traces' }) };
    const calls = kv(store);
    expect(await loadSettings({ dataset: 'otel' }, { key: 'apm_settings' })).toEqual({ dataset: 'traces' });
    expect(await loadSettings({ dataset: 'otel' })).toEqual({ dataset: 'otel' });
    await saveSettings({ dataset: 'x' }, { key: 'apm_settings' });
    await saveSettings({ dataset: 'y' });
    expect(calls.map((c) => `${c.method} ${c.key}`)).toEqual([
      'GET apm_settings',
      'GET settings',
      'PUT apm_settings',
      'PUT settings',
    ]);
    expect(JSON.parse(store.apm_settings)).toEqual({ dataset: 'x' });
  });

  it('merge: true keeps fields this caller does not own', async () => {
    const store: Record<string, string> = { s: JSON.stringify({ dataset: 'a', searchCadence: '5m', other: 1 }) };
    kv(store);
    await saveSettings({ dataset: 'b' }, { key: 's', merge: true });
    expect(JSON.parse(store.s)).toEqual({ dataset: 'b', searchCadence: '5m', other: 1 });
  });

  it('merge: true over an absent key writes just the new fields', async () => {
    const store: Record<string, string> = {};
    kv(store);
    await saveSettings({ dataset: 'b' }, { merge: true });
    expect(JSON.parse(store.settings)).toEqual({ dataset: 'b' });
  });

  it('merge: true aborts with KvError and writes nothing when the read misroutes', async () => {
    const calls = kv({}, { settings: html404 });
    const result = await saveSettingsResult({ dataset: 'b' }, { merge: true });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.isRoutingFailure).toBe(true);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('merge: true refuses to merge over a non-object value', async () => {
    const calls = kv({ s: '[1,2]' });
    await expect(saveSettings({ dataset: 'b' }, { key: 's', merge: true })).rejects.toThrow(/not an object/);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('without merge, saving replaces the stored value and does not read', async () => {
    const store: Record<string, string> = { settings: JSON.stringify({ dataset: 'a', other: 1 }) };
    const calls = kv(store);
    await saveSettings({ dataset: 'b' });
    expect(JSON.parse(store.settings)).toEqual({ dataset: 'b' });
    expect(calls.map((c) => c.method)).toEqual(['PUT']);
  });
});

describe('the saved dataset from an app-chosen source', () => {
  it('reads settingsKey instead of settings', async () => {
    kv({ apm_settings: JSON.stringify({ dataset: ' traces ' }), settings: JSON.stringify({ dataset: 'wrong' }) });
    expect(await loadSavedDataset('otel', { settingsKey: 'apm_settings' })).toBe('traces');
  });

  it('a custom loadDataset wins, and its failure is recorded like a KV failure', async () => {
    const calls = kv({});
    expect(await loadSavedDataset('otel', { loadDataset: async () => ' custom ', settingsKey: 'ignored' })).toBe('custom');
    expect(await loadSavedDataset('otel', { loadDataset: async () => null })).toBeUndefined();
    expect(calls).toEqual([]);

    const errors: Error[] = [];
    setCurrentDataset('app_default');
    await syncSavedDataset('app_default', {
      loadDataset: async () => {
        throw new KvError('misrouted', { key: 'apm_settings', bodyKind: 'html' });
      },
      onError: (e) => errors.push(e),
    });
    expect(getCurrentDataset()).toBe('app_default');
    expect(getDatasetLoadError()).toBeInstanceOf(KvError);
    expect(errors).toHaveLength(1);
  });

  it('syncSavedDataset pushes a value read from settingsKey into the store', async () => {
    kv({ apm_settings: JSON.stringify({ dataset: 'traces' }) });
    await syncSavedDataset('otel', { settingsKey: 'apm_settings' });
    expect(getCurrentDataset()).toBe('traces');
  });
});
