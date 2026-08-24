/**
 * The catalog client, against the response shapes a live workspace
 * actually returns. Every fixture below is trimmed from a real response
 * (staging, engine `homelab`, dataset `metrics`, 1,182 metrics / 35,287
 * active series) — including the field names that differ from what the
 * spec's prose implies, which is the whole reason for pinning them.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMetricsCatalog, type CatalogTransport } from '../metrics-catalog.js';

const ENGINES = {
  items: [
    {
      id: 'homelab',
      metricsDatasetId: 'metrics',
      datasets: ['main', 'demo', 'homelab', 'otel', 'metrics'],
      status: 'ready',
    },
  ],
  count: 1,
};

const ENGINE_ROOT = '/products/lakehouse_engine_metrics/engines/homelab/datasets/metrics';

/** A transport over a path→body map, recording what was requested. */
function stub(routes: Record<string, unknown>): CatalogTransport & { paths: string[] } {
  const paths: string[] = [];
  const t = vi.fn(async (path: string) => {
    paths.push(path);
    const body = routes[path];
    if (body === undefined) return { status: 404, ok: false, text: `Cannot GET ${path}` };
    return { status: 200, ok: true, text: typeof body === 'string' ? body : JSON.stringify(body) };
  }) as unknown as CatalogTransport & { paths: string[] };
  Object.defineProperty(t, 'paths', { get: () => paths });
  return t;
}

const ENGINES_PATH = '/m/default_search/search/local_search/engines';

describe('engine resolution', () => {
  it('reads the engine id and its own metrics dataset from the engines list', async () => {
    const transport = stub({ [ENGINES_PATH]: ENGINES });
    const catalog = createMetricsCatalog({ transport });
    expect(await catalog.engine()).toEqual({ engineId: 'homelab', datasetId: 'metrics' });
  });

  it('asks for the engines list WITH a group context and the catalog WITHOUT one', async () => {
    // The two directions are reversed between /search/* and /products/*,
    // and getting either wrong is a 404 that reads like "no such
    // endpoint". This is the fact most worth locking down.
    const transport = stub({
      [ENGINES_PATH]: ENGINES,
      [`${ENGINE_ROOT}/prom/api/v1/labels`]: { status: 'success', data: ['job'] },
    });
    await createMetricsCatalog({ transport }).labels();
    expect(transport.paths[0]).toBe(ENGINES_PATH);
    expect(transport.paths[1]).toBe(`${ENGINE_ROOT}/prom/api/v1/labels`);
    expect(transport.paths[1]).not.toContain('/m/');
  });

  it('resolves the engine once and reuses it', async () => {
    const transport = stub({
      [ENGINES_PATH]: ENGINES,
      [`${ENGINE_ROOT}/prom/api/v1/labels`]: { status: 'success', data: ['job'] },
    });
    const catalog = createMetricsCatalog({ transport });
    await catalog.labels();
    await catalog.labels();
    expect(transport.paths.filter((p) => p === ENGINES_PATH)).toHaveLength(1);
  });

  it('does not cache a failed resolution', async () => {
    // A bearer that wasn't ready yet must not make the rest of the
    // session permanently undiscoverable.
    let fail = true;
    const transport = vi.fn(async (path: string) => {
      if (fail) return { status: 503, ok: false, text: 'not ready' };
      return { status: 200, ok: true, text: JSON.stringify(ENGINES) };
    }) as unknown as CatalogTransport;
    const catalog = createMetricsCatalog({ transport });
    await expect(catalog.engine()).rejects.toThrow(/503/);
    fail = false;
    expect(await catalog.engine()).toEqual({ engineId: 'homelab', datasetId: 'metrics' });
  });

  it('prefers the engine\'s own metricsDatasetId over a dataset it does not serve', async () => {
    const transport = stub({ [ENGINES_PATH]: ENGINES });
    const catalog = createMetricsCatalog({ transport, dataset: 'not_on_this_engine' });
    expect((await catalog.engine()).datasetId).toBe('metrics');
  });

  it('honours a requested dataset the engine does serve', async () => {
    const transport = stub({ [ENGINES_PATH]: ENGINES });
    const catalog = createMetricsCatalog({ transport, dataset: 'otel' });
    expect((await catalog.engine()).datasetId).toBe('otel');
  });

  it('explains an empty engines list rather than throwing on undefined', async () => {
    const transport = stub({ [ENGINES_PATH]: { items: [], count: 0 } });
    await expect(createMetricsCatalog({ transport }).labels()).rejects.toThrow(
      /no Local Search engine/,
    );
  });

  it('reports a 2xx HTML body as a miss, not as data', async () => {
    // The workspace serves the SPA shell with a 200 for an unmatched
    // path, so `ok` is true and the body is HTML. Left unchecked this
    // surfaces as an opaque JSON parse error.
    const transport = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: '<!doctype html><html><body>app shell</body></html>',
    })) as unknown as CatalogTransport;
    await expect(createMetricsCatalog({ transport }).labels()).rejects.toThrow(/returned HTML/);
  });
});

describe('catalog reads', () => {
  const catalog = () =>
    createMetricsCatalog({
      transport: stub({
        [ENGINES_PATH]: ENGINES,
        [`${ENGINE_ROOT}/prom/api/v1/labels`]: {
          status: 'success',
          data: ['__name__', 'instance', 'job'],
        },
        [`${ENGINE_ROOT}/prom/api/v1/label/job/values`]: {
          status: 'success',
          data: ['node', 'prometheus', 'pve'],
        },
        [`${ENGINE_ROOT}/prom/api/v1/metadata`]: {
          status: 'success',
          data: {
            up: [{ type: 'gauge', help: 'scrape up', unit: '' }],
            node_load1: [{ type: 'gauge', help: '', unit: '' }],
            criblapm_requests_total: [{ type: 'counter', help: '', unit: '' }],
          },
        },
        [`${ENGINE_ROOT}/prom/api/v1/series?match%5B%5D=up`]: {
          status: 'success',
          data: [
            { __name__: 'up', instance: '192.168.4.4:9100', job: 'node' },
            { __name__: 'up', instance: 'localhost:9090', job: 'prometheus' },
          ],
        },
        [`${ENGINE_ROOT}/metrics/up/labels`]: {
          labels: [
            { key: 'job', distinct: 4, seriesCount: 0, share: 0.129 },
            { key: 'instance', distinct: 27, seriesCount: 0, share: 0.871 },
          ],
        },
        [`${ENGINE_ROOT}/metrics/summary`]: {
          totals: {
            metrics: 1182,
            activeMetrics: 1182,
            totalMetrics: 1273,
            activeSeries: 35287,
            series: 35287,
            dpm: 134361,
          },
          rows: [
            { name: 'up', type: 'gauge', activeSeriesCount: 27, samplesPerMinute: 27, usage: 'active', queries30d: 9 },
            {
              name: 'node_systemd_unit_state',
              type: 'gauge',
              activeSeriesCount: 7421,
              samplesPerMinute: 29441,
              usage: 'unused',
              queries30d: 0,
            },
            {
              name: 'unpoller_client_dpi_receive_bytes',
              type: 'gauge',
              activeSeriesCount: 682,
              samplesPerMinute: 2689,
              usage: 'active',
              queries30d: 7,
            },
          ],
        },
      }),
    });

  it('lists label names', async () => {
    expect(await catalog().labels()).toEqual(['__name__', 'instance', 'job']);
  });

  it('lists one label\'s values', async () => {
    expect(await catalog().labelValues('job')).toEqual(['node', 'prometheus', 'pve']);
  });

  it('flattens the metadata map, taking the first record per metric', async () => {
    const meta = await catalog().metadata();
    expect(meta).toEqual([
      { name: 'criblapm_requests_total', type: 'counter', help: '', unit: '' },
      { name: 'node_load1', type: 'gauge', help: '', unit: '' },
      { name: 'up', type: 'gauge', help: 'scrape up', unit: '' },
    ]);
  });

  it('filters metadata by substring, not just prefix', async () => {
    // A model looking for "requests" should find
    // criblapm_requests_total; requiring a prefix match makes the
    // filter useless against namespaced metric names.
    expect((await catalog().metadata('requests')).map((m) => m.name)).toEqual([
      'criblapm_requests_total',
    ]);
  });

  it('encodes the series selector as the match[] the API expects', async () => {
    const series = await catalog().series('up');
    expect(series).toEqual([
      { __name__: 'up', instance: '192.168.4.4:9100', job: 'node' },
      { __name__: 'up', instance: 'localhost:9090', job: 'prometheus' },
    ]);
  });

  it('orders a metric\'s label dimensions by share, highest first', async () => {
    const dims = await catalog().metricLabels('up');
    expect(dims.map((d) => d.key)).toEqual(['instance', 'job']);
    expect(dims[0]).toEqual({ key: 'instance', distinct: 27, share: 0.871 });
  });

  it('projects the 1MB summary down to totals plus the busiest metrics', async () => {
    // The live response is 1,073 KB across 1,182 rows of 31 fields and
    // accepts no limit/offset, so the projection is not an optimization
    // — it is what makes this callable from an agent at all.
    const { totals, rows, matched } = await catalog().summary({ limit: 2 });
    expect(totals).toEqual({
      metrics: 1273,
      activeMetrics: 1182,
      series: 35287,
      samplesPerMinute: 134361,
    });
    expect(matched).toBe(3);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name)).toEqual(['node_systemd_unit_state', 'unpoller_client_dpi_receive_bytes']);
    expect(rows[0]).toEqual({
      name: 'node_systemd_unit_state',
      type: 'gauge',
      unit: '',
      activeSeries: 7421,
      samplesPerMinute: 29441,
      usage: 'unused',
      queries30d: 0,
    });
  });

  it('filters the summary case-insensitively and reports how many matched', async () => {
    const { rows, matched } = await catalog().summary({ filter: 'UNPOLLER' });
    expect(matched).toBe(1);
    expect(rows.map((r) => r.name)).toEqual(['unpoller_client_dpi_receive_bytes']);
  });

  it('reports a Prometheus error envelope instead of returning empty data', async () => {
    const transport = stub({
      [ENGINES_PATH]: ENGINES,
      [`${ENGINE_ROOT}/prom/api/v1/labels`]: { status: 'error', error: 'bad request' },
    });
    await expect(createMetricsCatalog({ transport }).labels()).rejects.toThrow(/bad request/);
  });

  it('surfaces a 404 from a non-Cloud deployment as an error the caller can fall back on', async () => {
    const transport = stub({ [ENGINES_PATH]: ENGINES });
    await expect(createMetricsCatalog({ transport }).labels()).rejects.toThrow(/404/);
  });
});
