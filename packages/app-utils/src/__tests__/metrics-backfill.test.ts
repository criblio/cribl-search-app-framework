import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BACKFILL_WINDOW_SECONDS,
  coverageProbeQuery,
  createMetricsCoverageProbe,
  isRetryableDrop,
  planDensityWindows,
  planFixedWindows,
  readExportStats,
  runMetricsBackfill,
  runMetricsExport,
  promSelector,
  splitCoverageSec,
  windowTilingError,
  type BackfillWindow,
  type ExportStats,
  type MetricsBackfillDeps,
  type MetricsBackfillEmitter,
  type MetricsBackfillProgress,
} from '../metrics-backfill.js';
import type { SearchHttpClient } from '../search-job.js';

const H = 3600;
const NOW = 1_700_000_000 + 37; // deliberately not minute-aligned
const TO = Math.floor(NOW / 60) * 60;

const clean = (eventsOut = 100): ExportStats => ({ eventsOut, eventsDropped: 0, dropReasons: {}, reported: true });

const requests: MetricsBackfillEmitter = { id: 'requests', metricName: 'app_requests_total', query: 'Q_REQ', kind: 'counter' };
const latency: MetricsBackfillEmitter = { id: 'latency', metricName: 'app_latency_ms', query: 'Q_LAT', kind: 'histogram' };

/**
 * A fake metrics store: per-family earliest covered second. Exports record
 * their windows; the probe answers from the store; a callback can make a
 * window drop.
 */
function fakeStore(initial: Record<string, number | null>, drop?: (q: string, w: BackfillWindow) => ExportStats | null) {
  const covered = { ...initial };
  const exports: Array<{ query: string } & BackfillWindow> = [];
  const probes: Array<{ metric: string } & BackfillWindow> = [];
  const familyOf = (q: string) => (q === 'Q_REQ' ? 'app_requests_total' : q === 'Q_LAT' ? 'app_latency_ms' : q);
  const deps: MetricsBackfillDeps = {
    async runExport(query, earliestMs, latestMs) {
      const w = { earliestSec: earliestMs / 1000, latestSec: latestMs / 1000 };
      exports.push({ query, ...w });
      const dropped = drop?.(query, w);
      if (dropped) return dropped;
      const fam = familyOf(query);
      covered[fam] = Math.min(covered[fam] ?? Infinity, w.earliestSec);
      return clean();
    },
    async earliestCoveredSec(emitter, earliestMs, latestMs) {
      probes.push({ metric: emitter.metricName, earliestSec: earliestMs / 1000, latestSec: latestMs / 1000 });
      const c = covered[emitter.metricName];
      return c == null || c > latestMs / 1000 ? null : Math.max(c, earliestMs / 1000);
    },
  };
  return { deps, exports, probes, covered };
}

describe('window planning', () => {
  it('tiles a gap with fixed windows, clamping the last', () => {
    expect(planFixedWindows(0, 15 * H, 6 * H)).toEqual([
      { earliestSec: 0, latestSec: 6 * H },
      { earliestSec: 6 * H, latestSec: 12 * H },
      { earliestSec: 12 * H, latestSec: 15 * H },
    ]);
    expect(planFixedWindows(10, 10)).toEqual([]);
    expect(() => planFixedWindows(0, 10, 0)).toThrow(RangeError);
  });

  it('packs count bins under the per-export cap, contiguously', () => {
    const bins = [10, 20, 30, 5, 50].map((count, i) => ({ tSec: i * 300, count }));
    expect(planDensityWindows(bins, 300, 40)).toEqual([
      { earliestSec: 0, latestSec: 600 },
      { earliestSec: 600, latestSec: 1200 },
      { earliestSec: 1200, latestSec: 1500 },
    ]);
  });
});

describe('density windows clamped to the gap', () => {
  const gap = { earliestSec: 1_020, latestSec: 2_340 }; // minute-aligned, not 300-aligned

  it('drops bins outside the gap and clamps both ends, so no covered minute is re-emitted', () => {
    const bins = [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700].map((tSec) => ({ tSec, count: 10 }));
    const w = planDensityWindows(bins, 300, 25, gap);
    expect(w).toEqual([
      { earliestSec: 1_020, latestSec: 1_500 },
      { earliestSec: 1_500, latestSec: 2_100 },
      { earliestSec: 2_100, latestSec: 2_340 },
    ]);
    expect(windowTilingError(w, gap)).toBeNull();
  });

  it('bridges missing (empty) bins so the windows stay contiguous', () => {
    const bins = [{ tSec: 1_200, count: 30 }, { tSec: 2_100, count: 30 }];
    const w = planDensityWindows(bins, 300, 40, gap);
    expect(w).toEqual([
      { earliestSec: 1_020, latestSec: 1_500 },
      { earliestSec: 1_500, latestSec: 2_340 },
    ]);
    expect(windowTilingError(w, gap)).toBeNull();
    // Without the gap the bins are followed exactly, hole included (unchanged).
    expect(planDensityWindows(bins, 300, 40)).toEqual([
      { earliestSec: 1_200, latestSec: 1_500 },
      { earliestSec: 2_100, latestSec: 2_400 },
    ]);
  });

  it('a gap with no source events is one window; an empty gap none', () => {
    expect(planDensityWindows([], 300, 40, gap)).toEqual([gap]);
    expect(planDensityWindows([{ tSec: 0, count: 5 }], 300, 40, gap)).toEqual([gap]);
    expect(planDensityWindows([], 300, 40, { earliestSec: 60, latestSec: 60 })).toEqual([]);
  });

  it('accepts unsorted bins when given a gap', () => {
    const bins = [{ tSec: 1_800, count: 30 }, { tSec: 1_200, count: 30 }];
    expect(windowTilingError(planDensityWindows(bins, 300, 40, gap), gap)).toBeNull();
  });
});

describe('window tiling validation', () => {
  const gap = { earliestSec: 0, latestSec: 600 };
  it('accepts an exact tiling in any order and names every failure mode', () => {
    expect(windowTilingError([{ earliestSec: 300, latestSec: 600 }, { earliestSec: 0, latestSec: 300 }], gap)).toBeNull();
    expect(windowTilingError([], gap)).toMatch(/no windows/);
    expect(windowTilingError([{ earliestSec: 0, latestSec: 660 }], gap)).toMatch(/outside gap/);
    expect(windowTilingError([{ earliestSec: -60, latestSec: 600 }], gap)).toMatch(/outside gap/);
    expect(windowTilingError([{ earliestSec: 0, latestSec: 360 }, { earliestSec: 300, latestSec: 600 }], gap)).toMatch(/overlap/);
    expect(windowTilingError([{ earliestSec: 0, latestSec: 240 }, { earliestSec: 300, latestSec: 600 }], gap)).toMatch(/hole 240-300 between/);
    expect(windowTilingError([{ earliestSec: 60, latestSec: 600 }], gap)).toMatch(/bottom/);
    expect(windowTilingError([{ earliestSec: 0, latestSec: 540 }], gap)).toMatch(/top/);
    expect(windowTilingError([{ earliestSec: 0, latestSec: 0 }, { earliestSec: 0, latestSec: 600 }], gap)).toMatch(/empty/);
    expect(windowTilingError([{ earliestSec: 0, latestSec: Number.NaN }], gap)).toMatch(/non-finite/);
  });

  it('fails the emitter clearly, before any export, when planWindows does not tile the gap', async () => {
    const s = fakeStore({ app_requests_total: null, app_latency_ms: null });
    const logs: string[] = [];
    const seen: MetricsBackfillProgress[] = [];
    const planWindows = vi.fn((e: MetricsBackfillEmitter, g: BackfillWindow) =>
      e.id === 'latency'
        ? [{ earliestSec: g.earliestSec, latestSec: g.latestSec + 300 }] // runs past the covered boundary
        : planFixedWindows(g.earliestSec, g.latestSec));
    const r = await runMetricsBackfill([latency, requests], { ...s.deps, planWindows, log: (m) => logs.push(m) }, {
      horizonSec: H, nowSec: NOW, onProgress: (p) => seen.push(p),
    });
    expect(r.emitters[0]).toMatchObject({ status: 'failed', exportsRun: 0, windows: 0 });
    expect(r.emitters[0].error).toMatch(/planWindows output does not tile the gap: window .* is outside gap/);
    expect(logs.some((l) => l.includes('does not tile'))).toBe(true);
    expect(seen.filter((p) => p.phase === 'emitter-done')).toHaveLength(2);
    // The next emitter still runs, and nothing was exported for the bad one.
    expect(r.emitters[1].status).toBe('filled');
    expect(s.exports.every((e) => e.query === 'Q_REQ')).toBe(true);
  });
});

describe('export stats', () => {
  it('reads eventsOut / eventsDropped / dropReasons from the export row, not the job status', () => {
    const rows = [
      { _raw: 'something' },
      { status: 'Exporting complete', eventsOut: '0', eventsDropped: 50000, dropReasons: '{"invalid_type":50000}' },
    ];
    expect(readExportStats(rows)).toEqual({ eventsOut: 0, eventsDropped: 50000, dropReasons: { invalid_type: 50000 }, reported: true });
    expect(readExportStats([{ eventsOut: 5, dropReasons: { cap: 2 } }])).toMatchObject({ eventsOut: 5, dropReasons: { cap: 2 } });
    expect(readExportStats([{ x: 1 }])).toBeNull();
  });

  it('runMetricsExport runs the job over epoch-ms bounds without a signal', async () => {
    const posted: unknown[] = [];
    const http: SearchHttpClient = {
      async post(_path, body) { posted.push(body); return { items: [{ id: 'j1', status: 'completed' }] }; },
      async get(path) {
        if (path.includes('/results')) return '{"isFinished":true}\n{"status":"Exporting complete","eventsOut":7,"eventsDropped":1}';
        return { items: [{ id: 'j1', status: 'completed' }] };
      },
    };
    await expect(runMetricsExport(http, 'Q', 1000, 2000)).resolves.toEqual({ eventsOut: 7, eventsDropped: 1, dropReasons: {}, reported: true });
    expect(posted[0]).toEqual({ query: 'Q', earliest: '1000', latest: '2000' });
  });

  it('marks a job with no stats row as unreported rather than inventing success', async () => {
    const http: SearchHttpClient = {
      async post() { return { items: [{ id: 'j', status: 'completed' }] }; },
      async get(path) { return path.includes('/results') ? '{"isFinished":true}' : { items: [{ status: 'completed' }] }; },
    };
    await expect(runMetricsExport(http, 'Q', 0, 1)).resolves.toMatchObject({ reported: false, eventsOut: 0 });
  });

  it('only splits drops that a smaller window can fix', () => {
    expect(isRetryableDrop({ eventsOut: 40_000, eventsDropped: 10_000, dropReasons: {}, reported: true })).toBe(true);
    expect(isRetryableDrop({ eventsOut: 0, eventsDropped: 50_000, dropReasons: { invalid_type: 50_000 }, reported: true })).toBe(false);
  });
});

describe('runMetricsBackfill', () => {
  it('fills a new family over the whole horizon, newest window first', async () => {
    const s = fakeStore({ app_requests_total: null });
    const r = await runMetricsBackfill([requests], s.deps, { horizonSec: 24 * H, nowSec: NOW });
    expect(r.horizon).toEqual({ earliestSec: TO - 24 * H, latestSec: TO });
    expect(s.exports.map((e) => e.latestSec)).toEqual([TO, TO - 6 * H, TO - 12 * H, TO - 18 * H]);
    expect(r.emitters[0]).toMatchObject({ status: 'filled', windows: 4, exportsRun: 4, eventsDropped: 0 });
  });

  it('adds only the new family: a covered family is probed and skipped', async () => {
    const s = fakeStore({ app_requests_total: TO - 30 * H, app_latency_ms: null });
    const r = await runMetricsBackfill([requests, latency], s.deps, { horizonSec: 24 * H, nowSec: NOW });
    expect(r.emitters.map((e) => e.status)).toEqual(['skipped', 'filled']);
    expect(s.exports.every((e) => e.query === 'Q_LAT')).toBe(true);
  });

  it('fills only below the forward-emit boundary, so no covered minute is re-emitted', async () => {
    const boundary = TO - 2 * H - 37; // forward emit started here
    const s = fakeStore({ app_requests_total: boundary });
    const r = await runMetricsBackfill([requests], s.deps, { horizonSec: 24 * H, nowSec: NOW });
    const top = Math.floor(boundary / 60) * 60;
    expect(r.emitters[0].gap).toEqual({ earliestSec: TO - 24 * H, latestSec: top });
    expect(Math.max(...s.exports.map((e) => e.latestSec))).toBe(top);
  });

  it('probes once per emitter, never per window (the boundary-bin false positive left 6h holes)', async () => {
    // A probe that, like the real store, reports ANY range touching the
    // first covered bin as covered. A per-window re-probe would skip the
    // newest window, whose upper edge IS that bin.
    const boundary = TO - 6 * H;
    const exports: number[] = [];
    let probes = 0;
    const deps: MetricsBackfillDeps = {
      async runExport(_q, e) { exports.push(e / 1000); return clean(); },
      async earliestCoveredSec(_e, earliestMs, latestMs) {
        probes += 1;
        return latestMs / 1000 >= boundary && earliestMs / 1000 <= boundary ? boundary : null;
      },
    };
    const r = await runMetricsBackfill([requests], deps, { horizonSec: 24 * H, nowSec: NOW });
    expect(probes).toBe(1);
    expect(exports).toEqual([TO - 12 * H, TO - 18 * H, TO - 24 * H]);
    expect(r.emitters[0].windows).toBe(3);
  });

  it('resumes an interrupted run: the next run fills only what is still missing', async () => {
    const s = fakeStore({ app_requests_total: null });
    const controller = new AbortController();
    const first = await runMetricsBackfill([requests], s.deps, {
      horizonSec: 24 * H, nowSec: NOW, signal: controller.signal,
      onProgress: (p) => { if (p.phase === 'window' && p.windowsDone === 2) controller.abort(); },
    });
    expect(first.aborted).toBe(true);
    expect(first.emitters[0].status).toBe('aborted');
    expect(s.exports).toHaveLength(2);

    s.exports.length = 0;
    const second = await runMetricsBackfill([requests], s.deps, { horizonSec: 24 * H, nowSec: NOW });
    expect(second.emitters[0].gap).toEqual({ earliestSec: TO - 24 * H, latestSec: TO - 12 * H });
    expect(s.exports.map((e) => [e.earliestSec, e.latestSec])).toEqual([
      [TO - 18 * H, TO - 12 * H],
      [TO - 24 * H, TO - 18 * H],
    ]);
  });

  it('halves and retries a window that drops, newer half first, down to the minute floor', async () => {
    const dense = TO - 3 * H; // a minute too dense to ever export cleanly
    const s = fakeStore({ app_requests_total: null }, (_q, w) => {
      if (w.latestSec - w.earliestSec > 2 * H) return { eventsOut: 40_000, eventsDropped: 5_000, dropReasons: {}, reported: true };
      if (w.earliestSec <= dense && dense < w.latestSec) return { eventsOut: 10, eventsDropped: 3, dropReasons: {}, reported: true };
      return null;
    });
    const r = await runMetricsBackfill([requests], s.deps, { horizonSec: 6 * H, nowSec: NOW });
    const e = r.emitters[0];
    expect(e.status).toBe('filled');
    expect(e.droppedWindows).toEqual([{ earliestSec: dense, latestSec: dense + 60 }]);
    expect(e.eventsDropped).toBe(3);
    // Clean exports tile the whole horizon except the one lost minute.
    const cleanSpans = s.exports
      .filter((x) => x.latestSec - x.earliestSec <= 2 * H && !(x.earliestSec <= dense && dense < x.latestSec))
      .reduce((n, x) => n + (x.latestSec - x.earliestSec), 0);
    expect(cleanSpans).toBe(6 * H - 60);
    // Newest-first holds inside a split too: the first half run is the top one.
    expect(s.exports[1]).toMatchObject({ latestSec: TO });
    // Every split after a partial write is surfaced as a possible over-count.
    expect(e.partialRetries.length).toBeGreaterThan(0);
  });

  it('stops an emitter whose export drops everything instead of splitting it to dust', async () => {
    const s = fakeStore({ app_requests_total: null, app_latency_ms: null }, (q) =>
      q === 'Q_LAT' ? { eventsOut: 0, eventsDropped: 50_000, dropReasons: { invalid_type: 50_000 }, reported: true } : null);
    const r = await runMetricsBackfill([latency, requests], s.deps, { horizonSec: 24 * H, nowSec: NOW });
    expect(r.emitters[0]).toMatchObject({ status: 'failed', exportsRun: 1 });
    expect(r.emitters[0].error).toMatch(/invalid_type/);
    expect(r.emitters[1].status).toBe('filled');
  });

  it('uses an emitter window size or an injected planner', async () => {
    const s = fakeStore({ app_requests_total: null, app_latency_ms: null });
    const planWindows = vi.fn((_e: MetricsBackfillEmitter, gap: BackfillWindow) =>
      planDensityWindows([{ tSec: gap.earliestSec, count: 1 }, { tSec: gap.latestSec - 300, count: 1 }], 300, 1, gap));
    await runMetricsBackfill([{ ...requests, windowSeconds: 12 * H }], s.deps, { horizonSec: 24 * H, nowSec: NOW });
    expect(s.exports).toHaveLength(2);
    s.exports.length = 0;
    await runMetricsBackfill([latency], { ...s.deps, planWindows }, { horizonSec: 1 * H, nowSec: NOW });
    expect(planWindows).toHaveBeenCalledOnce();
    expect(s.exports.map((e) => e.latestSec)).toEqual([TO, TO - H + 300]);
  });

  it('reports progress for every phase and honours an abort before the first probe', async () => {
    const s = fakeStore({ app_requests_total: null });
    const seen: MetricsBackfillProgress['phase'][] = [];
    await runMetricsBackfill([requests], s.deps, { horizonSec: 12 * H, nowSec: NOW, onProgress: (p) => seen.push(p.phase) });
    expect(seen).toEqual(['probe', 'plan', 'window', 'window', 'emitter-done']);

    const controller = new AbortController();
    controller.abort();
    const r = await runMetricsBackfill([requests], s.deps, { horizonSec: 12 * H, nowSec: NOW, signal: controller.signal });
    expect(r).toMatchObject({ aborted: true, emitters: [] });
  });

  it('defaults to 6h windows', () => {
    expect(DEFAULT_BACKFILL_WINDOW_SECONDS).toBe(6 * H);
  });
});

describe('coverage probe', () => {
  it('probes histograms through histogram_quantile (a bare count() of one returns nothing)', () => {
    expect(coverageProbeQuery('m_total')).toBe('count(m_total)');
    expect(coverageProbeQuery('m_ms', 'histogram')).toBe('histogram_quantile(0.5, sum(rate(m_ms[5m])) by (le))');
    expect(() => coverageProbeQuery('m) or vector(1')).toThrow(RangeError);
  });

  it('returns the earliest finite sample (zero counts), padding histogram probes by 5m', async () => {
    const calls: Array<{ query: string; earliest: unknown; step: unknown }> = [];
    const transport = vi.fn(async (query: string, o: { earliest?: unknown; step?: unknown }) => {
      calls.push({ query, earliest: o.earliest, step: o.step });
      return [
        '{"isFinished":true,"job":{"status":"completed"}}',
        '{"_kind":"sample","_time":1200,"_value":"NaN"}',
        '{"_kind":"sample","_time":1260,"_value":0}',
        '{"_kind":"sample","_time":1320,"_value":4}',
      ].join('\n');
    });
    const probe = createMetricsCoverageProbe({ transport });
    await expect(probe(latency, 1_000_000, 2_000_000)).resolves.toBe(1260);
    expect(calls[0]).toMatchObject({ earliest: 1_000_000 - 300_000, step: 60 });
    expect(calls[0].query).toContain('histogram_quantile');
    await probe(requests, 1_000_000, 2_000_000);
    expect(calls[1]).toMatchObject({ earliest: 1_000_000, query: 'count(app_requests_total)' });
  });
});

describe('coverage probe label selector', () => {
  it('restricts the probe to exact label values, escaped', () => {
    expect(coverageProbeQuery('m', 'gauge', { labels: { quantile: 'p95' } })).toBe('count(m{quantile="p95"})');
    expect(coverageProbeQuery('m', 'gauge', { splitBy: 'route', labels: { quantile: 'p95', env: 'a"b\\c' } }))
      .toBe('count by (route) (m{quantile="p95",env="a\\"b\\\\c"})');
    expect(coverageProbeQuery('m_ms', 'histogram', { labels: { svc: 'x' } }))
      .toBe('histogram_quantile(0.5, sum(rate(m_ms{svc="x"}[5m])) by (le))');
    expect(coverageProbeQuery('m', undefined, {})).toBe('count(m)');
    expect(promSelector('m')).toBe('m');
  });

  it('rejects unsafe label names and control characters', () => {
    expect(() => coverageProbeQuery('m', undefined, { labels: { 'q"}) or vector(1': 'x' } })).toThrow(RangeError);
    expect(() => coverageProbeQuery('m', undefined, { labels: { q: 'a\nb' } })).toThrow(RangeError);
    expect(() => promSelector('m{', {})).toThrow(RangeError);
  });

  it('the default probe applies an emitter coverageLabels', async () => {
    const calls: string[] = [];
    const transport = vi.fn(async (query: string) => {
      calls.push(query);
      return '{"isFinished":true,"job":{"status":"completed"}}\n{"_kind":"sample","_time":600,"_value":1}';
    });
    const probe = createMetricsCoverageProbe({ transport });
    await expect(probe({ ...requests, coverageLabels: { quantile: 'p95' } }, 0, 1_000_000)).resolves.toBe(600);
    expect(calls).toEqual(['count(app_requests_total{quantile="p95"})']);
  });
});

describe('coverage split by label value', () => {
  const pctl: MetricsBackfillEmitter = {
    id: 'pctl',
    metricName: 'app_latency_pctl_ms',
    query: 'Q_PCTL',
    kind: 'gauge',
    coverageSplit: { label: 'quantile', values: ['0.95', '0.99'] },
  };
  const series = (quantile: string, ts: number[]) => ({ labels: { quantile }, points: ts.map((t) => ({ t, v: 1 })) });

  it('splits the probe query by the label, for gauges and histograms', () => {
    expect(coverageProbeQuery('m', 'gauge', 'quantile')).toBe('count by (quantile) (m)');
    expect(coverageProbeQuery('m_ms', 'histogram', 'route')).toBe(
      'histogram_quantile(0.5, sum(rate(m_ms[5m])) by (le, route))',
    );
    expect(() => coverageProbeQuery('m', undefined, 'q) or vector(1')).toThrow(RangeError);
  });

  it('starts coverage at the LATEST series start, so a covered p95 cannot hide a younger p99', () => {
    expect(splitCoverageSec([series('0.95', [600, 660]), series('0.99', [1800, 1860])], pctl.coverageSplit!)).toBe(1800);
  });

  it('treats a required value with no samples as uncovered', () => {
    expect(splitCoverageSec([series('0.95', [600])], pctl.coverageSplit!)).toBeNull();
    // NaN-only is no sample either; unrequired values are ignored.
    expect(splitCoverageSec([
      series('0.95', [600]),
      { labels: { quantile: '0.99' }, points: [{ t: 300, v: Number.NaN }] },
      series('0.5', [60]),
    ], pctl.coverageSplit!)).toBeNull();
  });

  it('the probe reads per-quantile series and the backfill fills the p99 gap', async () => {
    const calls: string[] = [];
    const transport = vi.fn(async (query: string) => {
      calls.push(query);
      return [
        '{"isFinished":true,"job":{"status":"completed"}}',
        `{"_kind":"sample","_time":${TO - 6 * H},"_value":3,"quantile":"0.95"}`,
        `{"_kind":"sample","_time":${TO - H},"_value":1,"quantile":"0.99"}`,
      ].join('\n');
    });
    const probe = createMetricsCoverageProbe({ transport });
    await expect(probe(pctl, (TO - 6 * H) * 1000, TO * 1000)).resolves.toBe(TO - H);
    expect(calls[0]).toBe('count by (quantile) (app_latency_pctl_ms)');

    const windows: BackfillWindow[] = [];
    const result = await runMetricsBackfill([pctl], {
      earliestCoveredSec: probe,
      runExport: async (_q, e, l) => {
        windows.push({ earliestSec: e / 1000, latestSec: l / 1000 });
        return clean();
      },
    }, { horizonSec: 6 * H, nowSec: NOW });
    // Unsplit, count(metric) would see the p95 sample at the horizon and skip.
    expect(result.emitters[0].status).toBe('filled');
    expect(result.emitters[0].gap).toEqual({ earliestSec: TO - 6 * H, latestSec: TO - H });
  });
});
