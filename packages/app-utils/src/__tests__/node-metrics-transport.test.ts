/**
 * `createNodeMetricsTransport` — the metrics query path from a Node script,
 * authenticated with the cached client-credentials token, so
 * `createMetricsCoverageProbe` runs from a deploy script with no app code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBearerTokenCache } from '../auth.js';
import { createMetricsCoverageProbe, type MetricsBackfillEmitter } from '../metrics-backfill.js';
import { queryRange } from '../metrics.js';
import { createNodeMetricsTransport } from '../provisioner.js';

const OAUTH = { baseUrl: 'https://main-x.cribl-staging.cloud/', clientId: 'id', clientSecret: 'secret' };
const originalFetch = globalThis.fetch;
let tokenCalls: number;

beforeEach(() => {
  tokenCalls = 0;
  clearBearerTokenCache();
  globalThis.fetch = (async (url: string) => {
    if (!String(url).includes('/oauth/token')) throw new Error(`unexpected global fetch ${url}`);
    tokenCalls += 1;
    return new Response(JSON.stringify({ access_token: `t${tokenCalls}`, expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearBearerTokenCache();
});

const BODY = [
  '{"isFinished":true,"job":{"status":"completed"}}',
  '{"_kind":"sample","_time":1260,"_value":0}',
  '{"_kind":"sample","_time":1320,"_value":2}',
].join('\n');

describe('createNodeMetricsTransport', () => {
  it('GETs the metrics query path on /api/v1 with a cached Bearer token', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const metricsFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return new Response(BODY, { status: 200 });
    }) as unknown as typeof fetch;
    const transport = createNodeMetricsTransport(OAUTH, { fetch: metricsFetch });
    const series = await queryRange('count(m)', { earliest: 1_000_000, latest: 2_000_000, step: 60, transport });
    await queryRange('count(m)', { earliest: 1_000_000, latest: 2_000_000, step: 60, transport });
    expect(series[0].points.map((p) => p.t)).toEqual([1260, 1320]);
    expect(tokenCalls).toBe(1);
    const url = new URL(seen[0].url);
    expect(url.origin + url.pathname).toBe('https://main-x.cribl-staging.cloud/api/v1/m/default_search/search/query');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      query: 'count(m)', earliest: '1000000', latest: '2000000', step: '60',
      searchJobSource: 'metrics', datasetId: 'metrics',
    });
    expect(seen.map((s) => s.auth)).toEqual(['Bearer t1', 'Bearer t1']);
  });

  it('throws on a non-2xx response instead of reading it as no data', async () => {
    const metricsFetch = (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch;
    const transport = createNodeMetricsTransport(OAUTH, { fetch: metricsFetch });
    await expect(transport('count(m)', {})).rejects.toThrow(/metrics query failed \(403\): denied/);
  });

  it('powers createMetricsCoverageProbe from Node with no app code', async () => {
    const queries: string[] = [];
    const metricsFetch = (async (url: string) => {
      queries.push(new URL(url).searchParams.get('query') ?? '');
      return new Response(BODY, { status: 200 });
    }) as unknown as typeof fetch;
    const probe = createMetricsCoverageProbe<MetricsBackfillEmitter>({
      transport: createNodeMetricsTransport(OAUTH, { fetch: metricsFetch }),
    });
    const emitter = { id: 'p95', metricName: 'lat_ms', query: 'Q', coverageLabels: { quantile: 'p95' } };
    await expect(probe(emitter, 1_000_000, 2_000_000)).resolves.toBe(1260);
    expect(queries).toEqual(['count(lat_ms{quantile="p95"})']);
  });

  it('passes the abort signal to the request', async () => {
    let signal: AbortSignal | null | undefined;
    const metricsFetch = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      return new Response(BODY, { status: 200 });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    await createNodeMetricsTransport(OAUTH, { fetch: metricsFetch })('count(m)', { signal: controller.signal });
    expect(signal).toBe(controller.signal);
  });
});
