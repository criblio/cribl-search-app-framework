import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunMetricsQueryTool, type MetricsQueryUi } from '../agent-tools.js';

const SUMMARY = '{"isFinished":true,"job":{"status":"completed"}}';
function ndjson(...samples: Array<Record<string, unknown>>): string {
  return [SUMMARY, ...samples.map((s) => JSON.stringify({ _kind: 'sample', ...s }))].join('\n');
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = { CRIBL_API_URL: '/api/v1' };
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => ndjson({ _time: 100, _value: 3, svc: 'frontend' }),
    headers: { get: () => 'application/json' },
  }));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => vi.restoreAllMocks());

function call(args: Record<string, unknown>) {
  return { id: 'call-1', name: 'run_metrics_query', arguments: JSON.stringify(args) };
}

describe('createRunMetricsQueryTool', () => {
  it('runs an instant query and returns labels + value rows', async () => {
    const tool = createRunMetricsQueryTool();
    const res = await tool(call({ query: 'sum(criblapm_requests_total) by (svc)', description: 'req by svc' }));
    const ui = res.ui as MetricsQueryUi;
    expect(ui.kind).toBe('metrics');
    expect(ui.rows).toEqual([{ svc: 'frontend', _time: 100, _value: 3 }]);
    expect(ui.series).toBeUndefined();
    expect(res.content).toContain('frontend');
  });

  it('runs a range query (step set) and returns a per-series chart card', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => ndjson({ _time: 100, _value: 1, svc: 'frontend' }, { _time: 160, _value: 5, svc: 'frontend' }),
      headers: { get: () => 'application/json' },
    });
    const tool = createRunMetricsQueryTool();
    const res = await tool(call({ query: 'sum(rate(m[5m])) by (svc)', step: 60, description: 'rate' }));
    const ui = res.ui as MetricsQueryUi;
    expect(ui.step).toBe(60);
    expect(ui.series).toHaveLength(1);
    expect(ui.series?.[0].name).toBe('frontend');
    // epoch-seconds → epoch-ms for the chart
    expect(ui.series?.[0].points[0].t).toBe(100_000);
  });

  it('clamps a sub-15s step up to the 15s floor', async () => {
    const tool = createRunMetricsQueryTool();
    const res = await tool(call({ query: 'm', step: 3, description: 'x' }));
    expect((res.ui as MetricsQueryUi).step).toBe(15);
  });

  it('injects the app-provided dataset into the query URL', async () => {
    const tool = createRunMetricsQueryTool({ dataset: () => 'apm_metrics' });
    await tool(call({ query: 'm', description: 'x' }));
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('datasetId=apm_metrics');
  });

  it('reports a query error back to the agent instead of throwing', async () => {
    const tool = createRunMetricsQueryTool();
    const res = await tool(call({ description: 'missing query' }));
    expect(res.content).toContain('Metrics query failed');
    expect((res.ui as MetricsQueryUi).error).toContain('non-empty string');
  });
});
