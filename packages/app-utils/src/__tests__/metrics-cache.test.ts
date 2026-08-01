import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedQueryInstant, cachedQueryRange, clearMetricsCache } from '../metrics.js';

/**
 * The metrics client uses global `fetch` + `window.CRIBL_API_URL`. Stub
 * both, and count fetches to prove the dedup + short-TTL behavior: a
 * concurrent duplicate reuses the in-flight promise; a repeat within the
 * TTL reuses the cached value; clearing forces a fresh fetch.
 */
const SUMMARY = '{"isFinished":true,"job":{"status":"completed"}}';
function ndjson(...samples: Array<Record<string, unknown>>): string {
  return [SUMMARY, ...samples.map((s) => JSON.stringify({ _kind: 'sample', ...s }))].join('\n');
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearMetricsCache();
  (globalThis as unknown as { window: unknown }).window = { CRIBL_API_URL: '/api/v1' };
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => ndjson({ _time: 1, _value: 42, svc: 'api' }),
    headers: { get: () => 'application/json' },
  }));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  clearMetricsCache();
  vi.restoreAllMocks();
});

describe('cachedQueryInstant', () => {
  it('dedupes concurrent identical reads into one fetch', async () => {
    const [a, b] = await Promise.all([
      cachedQueryInstant('sum(m)', { earliest: '-5m' }),
      cachedQueryInstant('sum(m)', { earliest: '-5m' }),
    ]);
    expect(a).toEqual(b);
    expect(a).toEqual([{ _time: 1, _value: 42, labels: { svc: 'api' } }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves a repeat within the TTL from cache (no second fetch)', async () => {
    await cachedQueryInstant('sum(m)', { earliest: '-5m' });
    await cachedQueryInstant('sum(m)', { earliest: '-5m' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keys on query + window, so a different window refetches', async () => {
    await cachedQueryInstant('sum(m)', { earliest: '-5m' });
    await cachedQueryInstant('sum(m)', { earliest: '-15m' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops the signal so an aborted nav does not cancel the shared read', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const rows = await cachedQueryInstant('sum(m)', { earliest: '-5m', signal: ctrl.signal });
    expect(rows).toHaveLength(1);
    // The stubbed fetch received no aborted signal (dropped before the call).
    const opts = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(opts?.signal?.aborted).not.toBe(true);
  });

  it('clearMetricsCache forces the next read to refetch', async () => {
    await cachedQueryInstant('sum(m)', { earliest: '-5m' });
    clearMetricsCache();
    await cachedQueryInstant('sum(m)', { earliest: '-5m' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache errors — the next caller retries', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    await expect(cachedQueryInstant('bad', {})).rejects.toThrow();
    // second call succeeds (default mock), proving the failure was not cached
    const rows = await cachedQueryInstant('bad', {});
    expect(rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('cachedQueryRange', () => {
  it('dedupes + caches range reads keyed by step', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => ndjson({ _time: 1, _value: 1, svc: 'api' }, { _time: 2, _value: 2, svc: 'api' }),
      headers: { get: () => 'application/json' },
    });
    const [a, b] = await Promise.all([
      cachedQueryRange('sum(m)', { step: 60 }),
      cachedQueryRange('sum(m)', { step: 60 }),
    ]);
    expect(a).toEqual(b);
    expect(a[0].points).toHaveLength(2);
    await cachedQueryRange('sum(m)', { step: 60 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // a different step is a different key
    await cachedQueryRange('sum(m)', { step: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
