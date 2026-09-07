import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryInstant, queryRange } from '../metrics.js';
import { createRunMetricsQueryTool, type MetricsQueryUi } from '../agent-tools.js';

// Captured Cribl framing (2026-09-07), with transient IDs shortened. Both
// responses were HTTP 200, fully consumed, with inline samples and no footer.
const INSTANT = '{"isFinished":false,"offset":0,"persistedEventCount":1,"totalEventCount":1,"job":{"id":"mq-instant","status":"running"}}\n' +
  '{"_kind":"sample","_time":1788755335,"_value":98}\n';
const RANGE = '{"isFinished":false,"offset":0,"persistedEventCount":3,"totalEventCount":3,"job":{"id":"mq-range","status":"running"}}\n' +
  '{"_kind":"sample","outcome":"completed","_time":160,"_value":8}\n' +
  '{"_kind":"sample","outcome":"failed","_time":100,"_value":2}\n' +
  '{"_kind":"sample","outcome":"completed","_time":100,"_value":6}\n';
const EMPTY = '{"isFinished":true,"totalEventCount":0,"job":{"status":"completed"}}\n';
const toolCall = (step?: number) => ({
  id: 'metrics-test', name: 'run_metrics_query',
  arguments: JSON.stringify({ query: 'sum(goattown_turns_total)', step }),
});

afterEach(() => vi.unstubAllGlobals());

describe('synchronous metrics responses', () => {
  it('reads browser instant samples without creating or polling a Search job', async () => {
    vi.stubGlobal('window', { CRIBL_API_URL: '/api/v1' });
    const fetch = vi.fn(async (_url: string | URL | Request) => new Response(INSTANT));
    vi.stubGlobal('fetch', fetch);
    expect(await queryInstant('sum(goattown_turns_total)')).toEqual([
      { labels: {}, _time: 1788755335, _value: 98 },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetch.mock.calls[0]?.[0]), 'https://cribl.example');
    expect(url.pathname).toBe('/api/v1/m/default_search/search/query');
    expect(url.searchParams.get('searchJobSource')).toBe('metrics');
  });

  it('groups and sorts injected range samples while the header is running', async () => {
    const transport = vi.fn(async () => RANGE);
    expect(await queryRange('m', { step: 60, transport })).toEqual([
      { labels: { outcome: 'completed' }, points: [{ t: 100, v: 6 }, { t: 160, v: 8 }] },
      { labels: { outcome: 'failed' }, points: [{ t: 100, v: 2 }] },
    ]);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 60])('returns usable agent results for step %s', async (step) => {
    const tool = createRunMetricsQueryTool({ transport: async () => step ? RANGE : INSTANT });
    const result = await tool(toolCall(step));
    const ui = result.ui as MetricsQueryUi;
    expect(ui.error).toBeUndefined();
    if (step) expect(ui.series?.[0].points).toEqual([{ t: 100000, v: 6 }, { t: 160000, v: 8 }]);
    else expect(ui.rows).toEqual([{ _time: 1788755335, _value: 98 }]);
  });

  it('preserves legacy completed, event-only, and running-without-counts responses', async () => {
    for (const body of [
      INSTANT.replace('"running"', '"completed"').replace('"isFinished":false', '"isFinished":true'),
      INSTANT.split('\n').slice(1).join('\n'),
      '{"isFinished":false,"job":{"status":"running"}}\n' + INSTANT.split('\n')[1],
    ]) expect(await queryInstant('m', { transport: async () => body })).toHaveLength(1);
  });

  it('distinguishes a completed empty result from an incomplete running response', async () => {
    expect(await queryInstant('missing', { transport: async () => EMPTY })).toEqual([]);
    const tool = createRunMetricsQueryTool({ transport: async () => EMPTY });
    expect((await tool(toolCall())).content).toContain('no results');
    await expect(queryInstant('m', { transport: async () =>
      '{"isFinished":false,"totalEventCount":0,"job":{"status":"running"}}',
    })).rejects.toMatchObject({ code: 'incomplete-response' });
  });

  it.each(['failed', 'error', 'canceled', 'cancelled'])('rejects explicit %s status even with samples', async (status) => {
    await expect(queryInstant('m', { transport: async () => INSTANT.replace('"running"', JSON.stringify(status)) }))
      .rejects.toMatchObject({ code: status.startsWith('cancel') ? 'cancelled' : 'query-failed' });
  });

  it.each([
    ['', 'invalid-response'],
    ['null', 'invalid-response'],
    ['[]', 'invalid-response'],
    ['{"message":"upstream error"}', 'invalid-response'],
    [INSTANT + '{', 'invalid-response'],
    [INSTANT.replace('"_kind":"sample",', ''), 'invalid-response'],
    [INSTANT.replace('"totalEventCount":1', '"totalEventCount":2'), 'incomplete-response'],
    [INSTANT.replace('"totalEventCount":1', '"totalEventCount":-1'), 'invalid-response'],
  ])('rejects malformed or truncated response %#', async (body, code) => {
    await expect(queryInstant('m', { transport: async () => body })).rejects.toMatchObject({ code });
  });

  it('keeps cancellation effective even if an injected transport ignores the signal', async () => {
    const controller = new AbortController();
    await expect(queryInstant('m', { signal: controller.signal, transport: async () => {
      controller.abort();
      return INSTANT;
    } })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('gives query advice only for an explicit failed query', async () => {
    const failed = createRunMetricsQueryTool({ transport: async () => INSTANT.replace('"running"', '"failed"') });
    expect((await failed(toolCall())).content).toContain('Check its PromQL');
    for (const transport of [
      async () => { throw new Error('metrics query failed (503): unavailable'); },
      async () => INSTANT.replace('"totalEventCount":1', '"totalEventCount":2'),
    ]) {
      const result = await createRunMetricsQueryTool({ transport })(toolCall());
      expect(result.content).not.toContain('Check its PromQL');
      expect(result.content).toContain('do not create or poll Search jobs');
      expect(result.content).toContain('does not establish');
    }
    const cancelled = createRunMetricsQueryTool({ transport: async () => { throw new DOMException('Aborted', 'AbortError'); } });
    expect((await cancelled(toolCall())).content).toContain('request was cancelled');
  });
});
