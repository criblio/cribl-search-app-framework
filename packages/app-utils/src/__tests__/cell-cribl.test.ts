/**
 * The cell-side Cribl adapters.
 *
 * These are thin, and the interesting failures are all in the seams:
 * a base URL that already carries `/api/v1` producing `/api/v1/api/v1`,
 * a bearer read once and cached forever, and — the one that would
 * silently corrupt results — pre-parsing NDJSON so the job's schema
 * line gets handed back as if it were data.
 *
 * `fetch` is stubbed globally rather than injected because that IS the
 * contract: these adapters exist to work in a workerd isolate where the
 * only I/O primitive is the global fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cellCriblFetch,
  createCellApiClient,
  createCellCatalogTransport,
  createCellMetricsCatalog,
  createCellMetricsTransport,
  createCellSearchHttpClient,
  type CellCriblConfig,
} from '../cell-cribl.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: Recorded[] = [];
let respond: (url: string) => { status?: number; body: string };

beforeEach(() => {
  calls = [];
  respond = () => ({ status: 200, body: '{"items":[]}' });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body == null ? undefined : String(init.body),
    });
    const { status = 200, body } = respond(String(url));
    return { status, ok: status >= 200 && status < 300, text: async () => body } as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function cfg(over: Partial<CellCriblConfig> = {}): CellCriblConfig {
  return { baseUrl: 'https://ws.cribl.cloud', bearer: async () => 'tok-1', ...over };
}

describe('cellCriblFetch', () => {
  it('builds {base}/api/v1{path} and sends the bearer', async () => {
    await cellCriblFetch(cfg(), 'GET', '/m/default_search/search/datasets');
    expect(calls[0].url).toBe('https://ws.cribl.cloud/api/v1/m/default_search/search/datasets');
    expect(calls[0].headers.authorization).toBe('Bearer tok-1');
  });

  it.each([
    'https://ws.cribl.cloud',
    'https://ws.cribl.cloud/',
    'https://ws.cribl.cloud/api/v1',
    'https://ws.cribl.cloud/api/v1/',
  ])('normalizes the base %s', async (baseUrl) => {
    // A base that already carries the version prefix would otherwise
    // produce /api/v1/api/v1/... — a 404 that reads like a bad path.
    await cellCriblFetch(cfg({ baseUrl }), 'GET', '/apps');
    expect(calls[0].url).toBe('https://ws.cribl.cloud/api/v1/apps');
  });

  it('honours an explicit apiVersion', async () => {
    await cellCriblFetch(cfg({ apiVersion: 'v2' }), 'GET', '/apps');
    expect(calls[0].url).toBe('https://ws.cribl.cloud/api/v2/apps');
  });

  it('asks for a fresh bearer on every request', async () => {
    // Token rotation is the host's business, but only if the host is
    // actually consulted each time.
    let n = 0;
    const c = cfg({ bearer: async () => `tok-${++n}` });
    await cellCriblFetch(c, 'GET', '/apps');
    await cellCriblFetch(c, 'GET', '/apps');
    expect(calls.map((call) => call.headers.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  it('sends a JSON body with a content-type, and neither when there is no body', async () => {
    await cellCriblFetch(cfg(), 'POST', '/x', { body: { a: 1 } });
    expect(calls[0].body).toBe('{"a":1}');
    expect(calls[0].headers['content-type']).toBe('application/json');

    await cellCriblFetch(cfg(), 'DELETE', '/x');
    expect(calls[1].body).toBeUndefined();
    expect(calls[1].headers['content-type']).toBeUndefined();
  });

  it('returns a non-2xx instead of throwing', async () => {
    respond = () => ({ status: 403, body: '{"message":"forbidden"}' });
    const r = await cellCriblFetch(cfg(), 'GET', '/apps');
    expect(r).toMatchObject({ status: 403, ok: false });
    expect(r.body).toEqual({ message: 'forbidden' });
  });

  it('leaves NDJSON as raw text', async () => {
    // Two JSON documents on two lines: JSON.parse must fail and the
    // text must survive intact. Parsing here would strip the schema
    // line 0 that runSearchJob's parser knows to skip.
    const ndjson = '{"fields":["_time"]}\n{"_time":1,"a":2}\n';
    respond = () => ({ body: ndjson });
    const r = await cellCriblFetch(cfg(), 'GET', '/results');
    expect(r.text).toBe(ndjson);
    expect(r.body).toBe(ndjson);
  });

  it('passes the abort signal through', async () => {
    const ac = new AbortController();
    ac.abort();
    // The stub ignores it; what matters is that it reaches fetch, which
    // is what makes a long poll cancellable.
    await cellCriblFetch(cfg(), 'GET', '/apps', { signal: ac.signal });
    expect(calls).toHaveLength(1);
  });
});

describe('createCellSearchHttpClient', () => {
  it('maps get/post/del onto the right verbs', async () => {
    const http = createCellSearchHttpClient(cfg());
    await http.get('/jobs');
    await http.post('/jobs', { query: 'x' });
    await http.del!('/jobs/1');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'DELETE']);
  });

  it('throws on a non-2xx with the status and body in the message', async () => {
    // runSearchJob's contract is throw-on-error; the status is what
    // tells a 403 (auth) from a 400 (bad KQL).
    respond = () => ({ status: 400, body: '{"message":"bad KQL"}' });
    const http = createCellSearchHttpClient(cfg());
    await expect(http.get('/jobs')).rejects.toThrow(/→ 400.*bad KQL/s);
  });

  it('bounds the body it quotes in an error', async () => {
    respond = () => ({ status: 500, body: 'x'.repeat(5_000) });
    const http = createCellSearchHttpClient(cfg());
    const err = await http.get('/jobs').catch((e: Error) => e);
    expect((err as Error).message.length).toBeLessThan(500);
  });
});

describe('createCellApiClient', () => {
  it("covers the provisioner's four verbs", async () => {
    const http = createCellApiClient(cfg());
    await http.get('/a');
    await http.post('/a', {});
    await http.patch('/a', { b: 1 });
    await http.del('/a');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'PATCH', 'DELETE']);
    expect(calls[2].body).toBe('{"b":1}');
  });
});

describe('createCellMetricsTransport', () => {
  it('hits the same path the browser transport does', async () => {
    respond = () => ({ body: '{"isFinished":true}\n' });
    const transport = createCellMetricsTransport(cfg());
    await transport('up', { earliest: '-15m', latest: 'now', step: 60 });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v1/m/default_search/search/query');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      query: 'up',
      earliest: '-15m',
      latest: 'now',
      step: '60',
      searchJobSource: 'metrics',
      datasetId: 'metrics',
    });
  });

  it('returns the raw NDJSON, unparsed', async () => {
    const ndjson = '{"isFinished":true}\n{"_kind":"sample","_value":1}\n';
    respond = () => ({ body: ndjson });
    const transport = createCellMetricsTransport(cfg());
    expect(await transport('up', {})).toBe(ndjson);
  });

  it('throws on a non-2xx', async () => {
    respond = () => ({ status: 404, body: 'not found' });
    const transport = createCellMetricsTransport(cfg());
    await expect(transport('up', {})).rejects.toThrow(/metrics query failed \(404\)/);
  });
});

describe('createCellMetricsCatalog', () => {
  it('authenticates the catalog reads and resolves the engine from the engines list', async () => {
    respond = (url) =>
      url.includes('/local_search/engines')
        ? { body: '{"items":[{"id":"homelab","metricsDatasetId":"metrics","status":"ready"}]}' }
        : { body: '{"status":"success","data":["job"]}' };
    const catalog = createCellMetricsCatalog(cfg());
    expect(await catalog.labels()).toEqual(['job']);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/m/default_search/search/local_search/engines');
    // /products/* takes NO group context — the reverse of /search/*.
    expect(new URL(calls[1].url).pathname).toBe(
      '/api/v1/products/lakehouse_engine_metrics/engines/homelab/datasets/metrics/prom/api/v1/labels',
    );
    expect(calls[1].headers.authorization).toBe('Bearer tok-1');
  });

  it('does not throw the 404 a non-Cloud workspace returns — the client decides', async () => {
    // The transport must report the status rather than raise, so the
    // catalog can turn a missing endpoint into a dot-command fallback.
    respond = () => ({ status: 404, body: 'Cannot GET' });
    const transport = createCellCatalogTransport(cfg());
    await expect(transport('/products/lakehouse_engine_metrics/health')).resolves.toMatchObject({
      status: 404,
      ok: false,
    });
  });
});
