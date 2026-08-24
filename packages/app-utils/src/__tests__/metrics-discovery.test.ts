/**
 * Discovery: the catalog is preferred, the dot-command is the fallback,
 * and PromQL never touches either.
 *
 * The threat these tests are named for is the one that motivated the
 * catalog: a workspace where `.metadata` returns a completed job with
 * zero rows, which a caller cannot distinguish from "no metrics exist".
 * So they assert WHICH backend answered, not just that an answer came
 * back — an implementation that quietly used the transport would return
 * the right-looking empty list and pass any outcome-only test.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRunMetricsQueryTool, type MetricsQueryUi } from '../agent-tools.js';
import { listLabels, listMetricMetadata, listSeries } from '../metrics.js';
import type { MetricsCatalog } from '../metrics-catalog.js';

/** The job-summary line, then nothing: what a workspace without the
 *  dot-command grammar returns. Completed, no error, no rows. */
const EMPTY_NDJSON = '{"isFinished":true,"totalEventCount":0,"job":{"status":"completed"}}';

function fakeCatalog(over: Partial<MetricsCatalog> = {}): MetricsCatalog {
  return {
    engine: vi.fn(async () => ({ engineId: 'homelab', datasetId: 'metrics' })),
    metadata: vi.fn(async () => [{ name: 'up', type: 'gauge', help: 'scrape up', unit: '' }]),
    labels: vi.fn(async () => ['instance', 'job']),
    labelValues: vi.fn(async () => ['node', 'pve']),
    series: vi.fn(async () => [{ __name__: 'up', job: 'node' }]),
    summary: vi.fn(async () => ({
      totals: { metrics: 1273, activeMetrics: 1182, series: 35287, samplesPerMinute: 134361 },
      matched: 2,
      rows: [
        { name: 'node_systemd_unit_state', type: 'gauge', unit: '', activeSeries: 7421, samplesPerMinute: 29441, usage: 'unused', queries30d: 0 },
        { name: 'up', type: 'gauge', unit: '', activeSeries: 27, samplesPerMinute: 27, usage: 'active', queries30d: 9 },
      ],
    })),
    metricLabels: vi.fn(async () => [
      { key: 'instance', distinct: 27, share: 0.871 },
      { key: 'job', distinct: 4, share: 0.129 },
    ]),
    ...over,
  };
}

describe('listMetricMetadata / listLabels / listSeries with a catalog', () => {
  it('answers from the catalog and never calls the transport', async () => {
    const transport = vi.fn(async () => EMPTY_NDJSON);
    const catalog = fakeCatalog();
    expect(await listMetricMetadata(undefined, { catalog, transport })).toEqual([
      { name: 'up', type: 'gauge', help: 'scrape up', unit: '' },
    ]);
    expect(await listLabels({ catalog, transport })).toEqual(['instance', 'job']);
    expect(await listSeries('up', { catalog, transport })).toEqual([{ __name__: 'up', job: 'node' }]);
    expect(transport).not.toHaveBeenCalled();
  });

  it('does NOT fall back when the catalog legitimately returns nothing', async () => {
    // An empty catalog answer is accurate. Re-asking the transport would
    // buy a second round trip for the same nothing.
    const transport = vi.fn(async () => EMPTY_NDJSON);
    const catalog = fakeCatalog({ labels: vi.fn(async () => []) });
    expect(await listLabels({ catalog, transport })).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it('falls back to the dot-command when the catalog is unreachable', async () => {
    // The catalog endpoints are Cribl.Cloud-only; a 404 there must not
    // take discovery down on a deployment where the grammar works.
    const transport = vi.fn(async () =>
      [
        '{"isFinished":true,"job":{"status":"completed"}}',
        '{"_kind":"label","_value":"svc"}',
      ].join('\n'),
    );
    const catalog = fakeCatalog({
      labels: vi.fn(async () => {
        throw new Error('metrics catalog GET … → 404');
      }),
    });
    expect(await listLabels({ catalog, transport })).toEqual(['svc']);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('uses the dot-command alone when no catalog is supplied', async () => {
    const transport = vi.fn(async () =>
      ['{"isFinished":true,"job":{"status":"completed"}}', '{"_kind":"label","_value":"svc"}'].join('\n'),
    );
    expect(await listLabels({ transport })).toEqual(['svc']);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

function call(args: Record<string, unknown>) {
  return { id: 'c1', name: 'run_metrics_query', arguments: JSON.stringify(args) };
}

describe('run_metrics_query discovery dot-commands', () => {
  it('answers .catalog with totals and the busiest metrics', async () => {
    const catalog = fakeCatalog();
    const transport = vi.fn(async () => EMPTY_NDJSON);
    const tool = createRunMetricsQueryTool({ catalog, transport });
    const res = await tool(call({ query: '.catalog', description: 'what metrics exist' }));
    expect(res.content).toContain('1182 active metrics of 1273 known');
    expect(res.content).toContain('35287 active series');
    expect(res.content).toContain('node_systemd_unit_state');
    expect(transport).not.toHaveBeenCalled();
  });

  it('passes a .catalog substring through as the filter', async () => {
    const summary = vi.fn(async () => ({
      totals: { metrics: 1, activeMetrics: 1, series: 1, samplesPerMinute: 1 },
      matched: 1,
      rows: [],
    }));
    const tool = createRunMetricsQueryTool({ catalog: fakeCatalog({ summary }) });
    await tool(call({ query: '.catalog criblapm', description: 'apm metrics' }));
    expect(summary).toHaveBeenCalledWith(expect.objectContaining({ filter: 'criblapm' }));
  });

  it('answers .labels with dataset-wide label names', async () => {
    const tool = createRunMetricsQueryTool({ catalog: fakeCatalog() });
    const res = await tool(call({ query: '.labels', description: 'labels' }));
    expect(res.content).toContain('2 label names');
    expect(res.content).toContain('instance');
  });

  it('answers .labels <metric> with that metric\'s dimensions by share', async () => {
    const metricLabels = vi.fn(async () => [{ key: 'instance', distinct: 27, share: 0.871 }]);
    const tool = createRunMetricsQueryTool({ catalog: fakeCatalog({ metricLabels }) });
    const res = await tool(call({ query: '.labels up', description: 'up labels' }));
    expect(metricLabels).toHaveBeenCalledWith('up', undefined);
    expect(res.content).toContain('label dimensions of up');
    expect(res.content).toContain('0.871');
  });

  it('answers .values <label>', async () => {
    const labelValues = vi.fn(async () => ['node', 'pve']);
    const tool = createRunMetricsQueryTool({ catalog: fakeCatalog({ labelValues }) });
    const res = await tool(call({ query: '.values job', description: 'job values' }));
    expect(labelValues).toHaveBeenCalledWith('job', undefined);
    expect(res.content).toContain('2 values of label job');
  });

  it('answers .metadata and .series', async () => {
    const tool = createRunMetricsQueryTool({ catalog: fakeCatalog() });
    expect((await tool(call({ query: '.metadata', description: 'm' }))).content).toContain('up');
    expect((await tool(call({ query: '.series up', description: 's' }))).content).toContain('1 series matching up');
  });

  it('tells the model what a bare .series or .values is missing', async () => {
    const tool = createRunMetricsQueryTool({ catalog: fakeCatalog() });
    expect((await tool(call({ query: '.series', description: 's' }))).content).toContain('needs a metric name');
    expect((await tool(call({ query: '.values', description: 'v' }))).content).toContain('needs a label name');
  });

  it('sends PromQL to the transport, not the catalog', async () => {
    const catalog = fakeCatalog();
    const transport = vi.fn(
      async () =>
        ['{"isFinished":true,"job":{"status":"completed"}}', '{"_kind":"sample","_time":1,"_value":2,"job":"node"}'].join('\n'),
    );
    const tool = createRunMetricsQueryTool({ catalog, transport });
    const res = await tool(call({ query: 'count(up)', description: 'count' }));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(catalog.summary).not.toHaveBeenCalled();
    expect((res.ui as MetricsQueryUi).rows).toEqual([{ job: 'node', _time: 1, _value: 2 }]);
  });

  it('sends an unrecognized dot-command to the transport', async () => {
    // The endpoint may grow commands this module hasn't heard of; those
    // must keep working rather than being swallowed here.
    const transport = vi.fn(async () => EMPTY_NDJSON);
    const tool = createRunMetricsQueryTool({ catalog: fakeCatalog(), transport });
    await tool(call({ query: '.somethingnew', description: 'x' }));
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('reports a catalog failure as a retryable tool error, not a crash', async () => {
    const catalog = fakeCatalog({
      summary: vi.fn(async () => {
        throw new Error('metrics catalog GET … → 403');
      }),
    });
    const tool = createRunMetricsQueryTool({ catalog });
    const res = await tool(call({ query: '.catalog', description: 'c' }));
    expect(res.content).toContain('403');
    expect((res.ui as MetricsQueryUi).error).toContain('403');
  });
});
