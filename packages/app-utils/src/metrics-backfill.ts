/**
 * Metrics backfill: populate a metrics family with history by re-running
 * its `export to metrics` search over past windows, so panels that read the
 * metrics store work across every time range on day one rather than only
 * from the moment the scheduled emitter started.
 *
 * The store is NOT idempotent — re-emitting a bin doubles it — so the whole
 * design is about never writing a minute twice:
 *
 * 1. **Coverage comes from the store.** Per emitter, `earliestCoveredSec`
 *    asks the metrics store for the earliest sample the family already has.
 *    Only the gap `[horizonStart, earliestCovered)` is filled. A new family
 *    has no samples and gets the full horizon; a covered one is skipped; so
 *    adding one emitter backfills only that family. No KV marker to drift.
 * 2. **Newest → oldest.** Windows (and the halves of a split window) run
 *    from the forward-emit boundary backwards, so coverage stays contiguous
 *    and an interrupted run leaves a clean boundary that the next run's
 *    probe finds. That is what makes the job resumable.
 * 3. **Probe once per emitter, never per window.** A window's upper edge IS
 *    the first covered bin, so a per-window probe catches that boundary bin,
 *    reads the window as covered and skips it — APM shipped that and got 6h
 *    holes. The gap is exact; every window in it is emitted.
 * 4. **Zero drops.** `export to metrics` reports `completed` even when it
 *    dropped 100% of its events; only the export's own result row
 *    (`eventsOut`/`eventsDropped`/`dropReasons`) tells you. A window that
 *    drops is halved and retried down to a one-minute floor. A window that
 *    drops EVERYTHING is a broken query (e.g. `invalid_type`), not a dense
 *    window, and splitting it would only run hundreds of doomed exports —
 *    the emitter stops and reports it instead.
 *
 * Pure and dependency-injected: `runMetricsExport` and
 * `createMetricsCoverageProbe` below are ready-made deps for the browser,
 * and a Node script passes its own transport, so the Settings button and
 * the deploy script run the identical algorithm.
 */

import { queryRange, type MetricSeries, type MetricsTransport } from './metrics.js';
import { runSearchJob, type SearchHttpClient } from './search-job.js';

/** Fixed window for a family with no `windowSeconds` of its own. */
export const DEFAULT_BACKFILL_WINDOW_SECONDS = 6 * 3600;
/** A window is never split below one minute (the emitters' bin size). */
export const MIN_BACKFILL_CHUNK_SECONDS = 60;
/** Under the observed ~50k-row per-export input cap, with headroom. */
export const SAFE_MAX_EXPORT_EVENTS = 40_000;

export interface BackfillWindow {
  earliestSec: number;
  latestSec: number;
}

/** The export's own accounting. A `completed` job can still drop every event. */
export interface ExportStats {
  eventsOut: number;
  eventsDropped: number;
  dropReasons: Record<string, number>;
  /** False when the job returned no stats row at all; counts are then zeros. */
  reported: boolean;
}

export interface MetricsBackfillEmitter {
  /** Stable id for logs and progress. */
  id: string;
  /** Metric family the coverage probe checks. */
  metricName: string;
  /** Search to re-run per window; ends in `| export to metrics …`. */
  query: string;
  /** Free-form shape tag handed to the coverage probe (`counter`, `histogram`, …). */
  kind?: string;
  /** Fixed window size. Default {@link DEFAULT_BACKFILL_WINDOW_SECONDS}. */
  windowSeconds?: number;
  /**
   * Probe coverage per label value instead of per family. Without it the
   * probe asks `count(metric)`, which has a sample wherever ANY series of
   * the family exists — so for percentile gauges sharing one name with a
   * `quantile` label, a covered p95 hides an empty p99 and the backfill
   * skips it. See {@link CoverageSplit}.
   */
  coverageSplit?: CoverageSplit;
  /**
   * Restrict the default coverage probe to series with these exact label
   * values (`{ quantile: 'p95' }` → `count(m{quantile="p95"})`), for an
   * emitter that writes only some series of a shared family. Unlike
   * {@link CoverageSplit} it neither requires every value nor probes the
   * others. Ignored when the probe has a custom `query`.
   */
  coverageLabels?: Readonly<Record<string, string>>;
}

/**
 * The series a family must have, all of them, for a minute to count as
 * covered: one per value of `label`. Coverage starts at the LATEST of the
 * values' earliest samples, so the gap reaches up to where the last
 * required series begins — the gap to fill is wherever ANY of them is
 * missing. A value with no sample at all means the family is uncovered
 * (`null`), which is why the values are listed rather than discovered: a
 * series that was never written returns nothing to discover.
 *
 * The emitter re-emits every series over that gap, so the series that were
 * already covered are written a second time between their own earliest
 * sample and the gap's top. That is harmless for a gauge re-written with
 * the same value at the same timestamp, and double-counts a counter — use
 * a split for gauge-like families (percentiles), not counters.
 */
export interface CoverageSplit {
  /** Label distinguishing the required series, e.g. `quantile`. */
  label: string;
  /** Every value the family must carry, e.g. `['0.5', '0.95', '0.99']`. */
  values: readonly string[];
}

export interface MetricsBackfillDeps<E extends MetricsBackfillEmitter = MetricsBackfillEmitter> {
  /** Run `query` over [earliestMs, latestMs) to completion and return its stats.
   * Do not wire this to a cancellable signal: an export cancelled mid-flight
   * leaves a partly written window the coverage probe cannot see. */
  runExport(query: string, earliestMs: number, latestMs: number): Promise<ExportStats>;
  /** Earliest epoch-seconds the emitter's family has a sample within
   * [earliestMs, latestMs], or null for none. */
  earliestCoveredSec(emitter: E, earliestMs: number, latestMs: number): Promise<number | null>;
  /** Override fixed windows for an emitter — e.g. density-sized windows from a
   * source-event count ({@link planDensityWindows} with the gap). Must tile
   * the gap exactly — contiguous, non-overlapping, within it — or the emitter
   * fails with `status: 'failed'` before any export runs
   * ({@link windowTilingError}). */
  planWindows?(emitter: E, gap: BackfillWindow): BackfillWindow[] | Promise<BackfillWindow[]>;
  /** Whether a dropping window is worth splitting. Default: unless it dropped
   * every event ({@link isRetryableDrop}). */
  isRetryableDrop?(stats: ExportStats): boolean;
  log?(message: string): void;
}

export type MetricsBackfillProgress =
  | { phase: 'probe'; emitterId: string; emitterIndex: number; emitterCount: number }
  | { phase: 'plan'; emitterId: string; gap: BackfillWindow | null; windowCount: number }
  | {
      phase: 'window';
      emitterId: string;
      window: BackfillWindow;
      /** Planned windows finished for this emitter (splits count once). */
      windowsDone: number;
      windowCount: number;
      stats: ExportStats;
    }
  | { phase: 'emitter-done'; result: EmitterBackfillResult };

export interface MetricsBackfillOptions {
  /** How far back to cover, in seconds. */
  horizonSec: number;
  /** Injected clock (epoch seconds); the run covers up to floor(now)@m. */
  nowSec: number;
  /** Honoured between exports, never during one. */
  signal?: AbortSignal;
  onProgress?(progress: MetricsBackfillProgress): void;
  /** Split floor. Default {@link MIN_BACKFILL_CHUNK_SECONDS}. */
  minChunkSeconds?: number;
}

export interface EmitterBackfillResult {
  id: string;
  metricName: string;
  status: 'skipped' | 'filled' | 'failed' | 'aborted';
  /** The uncovered range this run targeted; null when skipped. */
  gap: BackfillWindow | null;
  windows: number;
  exportsRun: number;
  eventsOut: number;
  eventsDropped: number;
  /** One-minute windows that still dropped; their events are lost. */
  droppedWindows: BackfillWindow[];
  /** Windows split after writing SOME events — the retried halves re-emit
   * those, so these minutes may be over-counted. Empty in a healthy run. */
  partialRetries: BackfillWindow[];
  /** Exports that returned no stats row (treated as clean). */
  unreportedExports: number;
  error?: string;
}

export interface MetricsBackfillResult {
  horizon: BackfillWindow;
  emitters: EmitterBackfillResult[];
  exportsRun: number;
  eventsOut: number;
  eventsDropped: number;
  aborted: boolean;
}

export function floorToMinute(sec: number): number {
  return Math.floor(sec / 60) * 60;
}

/** Contiguous fixed windows over [fromSec, toSec); the last is clamped. */
export function planFixedWindows(
  fromSec: number,
  toSec: number,
  windowSeconds: number = DEFAULT_BACKFILL_WINDOW_SECONDS,
): BackfillWindow[] {
  if (!(windowSeconds > 0)) throw new RangeError('windowSeconds must be positive');
  const windows: BackfillWindow[] = [];
  for (let s = fromSec; s < toSec; s += windowSeconds) {
    windows.push({ earliestSec: s, latestSec: Math.min(s + windowSeconds, toSec) });
  }
  return windows;
}

/**
 * Pack ascending, evenly spaced count bins into contiguous windows whose
 * expected export volume stays under `maxEventsPerWindow`. A single bin over
 * the cap becomes its own window (the runner splits it further on a drop).
 * For emitters whose output scales with source events (per-event
 * histograms) rather than with time.
 *
 * Pass the `gap` being filled and the result tiles it exactly, which is
 * what {@link runMetricsBackfill} requires of `planWindows`: bins outside
 * the gap are ignored, the first window starts at the gap's start, each
 * window starts where the previous ended (a missing bin — no source events
 * — joins its neighbour at no cost), and the last ends at the gap's top.
 * Count bins are usually coarser than the minute-aligned gap, and a window
 * running past the gap's top would re-emit covered minutes, which the
 * store doubles. A gap with no bins at all is one window.
 *
 * Without `gap` the windows follow the bins exactly, holes included.
 */
export function planDensityWindows(
  bins: readonly { tSec: number; count: number }[],
  binSeconds: number,
  maxEventsPerWindow: number = SAFE_MAX_EXPORT_EVENTS,
  gap?: BackfillWindow,
): BackfillWindow[] {
  const inGap = gap
    ? bins
      .filter((b) => b.tSec + binSeconds > gap.earliestSec && b.tSec < gap.latestSec)
      .sort((a, b) => a.tSec - b.tSec)
    : bins;
  const windows: BackfillWindow[] = [];
  let start: number | null = null;
  let acc = 0;
  let end = 0;
  for (const bin of inGap) {
    if (start === null) start = bin.tSec;
    if (acc > 0 && acc + bin.count > maxEventsPerWindow) {
      windows.push({ earliestSec: start, latestSec: end });
      start = bin.tSec;
      acc = 0;
    }
    acc += bin.count;
    end = bin.tSec + binSeconds;
  }
  if (start !== null) windows.push({ earliestSec: start, latestSec: end });
  if (!gap) return windows;
  if (!(gap.latestSec > gap.earliestSec)) return [];

  const tiled: BackfillWindow[] = [];
  let cursor = gap.earliestSec;
  for (const w of windows) {
    const top = Math.min(w.latestSec, gap.latestSec);
    if (top <= cursor) continue;
    tiled.push({ earliestSec: cursor, latestSec: top });
    cursor = top;
  }
  if (cursor < gap.latestSec) {
    if (tiled.length > 0) tiled[tiled.length - 1] = { earliestSec: tiled[tiled.length - 1].earliestSec, latestSec: gap.latestSec };
    else tiled.push({ earliestSec: gap.earliestSec, latestSec: gap.latestSec });
  }
  return tiled;
}

/**
 * Why `windows` does not tile `gap` — contiguous, non-overlapping, in
 * bounds, every edge finite, covering it from bottom to top — or null when
 * it does. Order does not matter. {@link runMetricsBackfill} fails an
 * emitter whose `planWindows` output does not tile: an overlap or a window
 * past the gap re-emits minutes (the store doubles them), and a hole is
 * history never filled that the next run's probe cannot see.
 */
export function windowTilingError(windows: readonly BackfillWindow[], gap: BackfillWindow): string | null {
  if (windows.length === 0) return `no windows for gap ${gap.earliestSec}-${gap.latestSec}`;
  for (const w of windows) {
    if (!w || !Number.isFinite(w.earliestSec) || !Number.isFinite(w.latestSec)) {
      return `window has a non-finite edge: ${JSON.stringify(w)}`;
    }
    if (!(w.latestSec > w.earliestSec)) return `empty or inverted window ${w.earliestSec}-${w.latestSec}`;
    if (w.earliestSec < gap.earliestSec || w.latestSec > gap.latestSec) {
      return `window ${w.earliestSec}-${w.latestSec} is outside gap ${gap.earliestSec}-${gap.latestSec}`;
    }
  }
  const sorted = [...windows].sort((a, b) => a.earliestSec - b.earliestSec);
  if (sorted[0].earliestSec !== gap.earliestSec) {
    return `hole ${gap.earliestSec}-${sorted[0].earliestSec} at the bottom of the gap`;
  }
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]; const cur = sorted[i];
    if (cur.earliestSec < prev.latestSec) {
      return `windows ${prev.earliestSec}-${prev.latestSec} and ${cur.earliestSec}-${cur.latestSec} overlap`;
    }
    if (cur.earliestSec > prev.latestSec) return `hole ${prev.latestSec}-${cur.earliestSec} between windows`;
  }
  const top = sorted[sorted.length - 1].latestSec;
  if (top !== gap.latestSec) return `hole ${top}-${gap.latestSec} at the top of the gap`;
  return null;
}

/** Default drop policy: split unless the export dropped every event. A
 * capacity drop still writes the rows under the cap; a 100% drop is a query
 * the store rejects (`invalid_type`) and no window size will fix it. */
export function isRetryableDrop(stats: ExportStats): boolean {
  return stats.eventsDropped > 0 && stats.eventsOut > 0;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseDropReasons(value: unknown): Record<string, number> {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return {}; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [reason, count] of Object.entries(raw as Record<string, unknown>)) out[reason] = num(count);
  return out;
}

/**
 * Find the export's stats row among a job's result rows — the row carrying
 * `eventsOut`/`eventsDropped` (status `Exporting complete…`). Returns null
 * when there is none.
 */
export function readExportStats(rows: readonly Record<string, unknown>[]): ExportStats | null {
  const hasStats = (r: Record<string, unknown>) => 'eventsOut' in r || 'eventsDropped' in r;
  const row = rows.find((r) => hasStats(r) && /complete/i.test(String(r.status ?? '')))
    ?? rows.find(hasStats);
  if (!row) return null;
  return {
    eventsOut: num(row.eventsOut),
    eventsDropped: num(row.eventsDropped),
    dropReasons: parseDropReasons(row.dropReasons),
    reported: true,
  };
}

export interface RunMetricsExportOptions {
  /** Default 10 minutes; exports over long windows outlive the 48s search default. */
  timeoutMs?: number;
  searchBase?: string;
}

/**
 * Run one `export to metrics` search over [earliestMs, latestMs) and return
 * its stats. Deliberately takes no AbortSignal (see
 * {@link MetricsBackfillDeps.runExport}). A ready-made `runExport` dep:
 * `runExport: (q, e, l) => runMetricsExport(http, q, e, l)`.
 */
export async function runMetricsExport(
  http: SearchHttpClient,
  query: string,
  earliestMs: number,
  latestMs: number,
  opts: RunMetricsExportOptions = {},
): Promise<ExportStats> {
  const rows = await runSearchJob(http, query, {
    earliest: String(earliestMs),
    latest: String(latestMs),
    limit: 50,
    pageSize: 50,
    timeoutMs: opts.timeoutMs ?? 600_000,
    pollIntervalMs: 1_000,
    searchBase: opts.searchBase,
  });
  return readExportStats(rows) ?? { eventsOut: 0, eventsDropped: 0, dropReasons: {}, reported: false };
}

const METRIC_NAME = /^[A-Za-z_:][A-Za-z0-9_:]*$/;
const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface CoverageProbeQueryOptions {
  /** One result series per value of this label (`count by (label) (m)`). */
  splitBy?: string;
  /**
   * Exact-match label matchers restricting the probe to some series of the
   * family: `{ quantile: 'p95' }` → `m{quantile="p95"}`. Label names must be
   * plain PromQL identifiers; values are serialised as escaped string
   * literals (control characters rejected), so any value is safe.
   */
  labels?: Readonly<Record<string, string>>;
}

/** `m` or `m{a="x",b="y"}` with validated names and escaped values. */
export function promSelector(metricName: string, labels: Readonly<Record<string, string>> = {}): string {
  if (!METRIC_NAME.test(metricName)) throw new RangeError(`not a metric name: ${metricName}`);
  const matchers = Object.entries(labels).map(([name, value]) => {
    if (!LABEL_NAME.test(name)) throw new RangeError(`not a label name: ${name}`);
    // eslint-disable-next-line no-control-regex
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new RangeError(`label ${name} value must be a string without control characters`);
    }
    return `${name}=${JSON.stringify(value)}`;
  });
  return matchers.length ? `${metricName}{${matchers.join(',')}}` : metricName;
}

/**
 * PromQL that yields a sample wherever a family has data. Histograms answer
 * only through `histogram_quantile(… by (le))` — a bare `count()` of a
 * histogram returns nothing, which made APM re-backfill a covered family.
 * With `splitBy`, one series per value of that label
 * (`count by (quantile) (m)`), for {@link CoverageSplit}. With `labels`,
 * only the matching series (`count(m{quantile="p95"})`). The third
 * argument is the `splitBy` label or an options object.
 */
export function coverageProbeQuery(
  metricName: string,
  kind?: string,
  splitByOrOptions?: string | CoverageProbeQueryOptions,
): string {
  const o: CoverageProbeQueryOptions = typeof splitByOrOptions === 'string'
    ? { splitBy: splitByOrOptions }
    : splitByOrOptions ?? {};
  const { splitBy } = o;
  const selector = promSelector(metricName, o.labels);
  if (splitBy !== undefined && !LABEL_NAME.test(splitBy)) throw new RangeError(`not a label name: ${splitBy}`);
  if (kind === 'histogram') {
    return `histogram_quantile(0.5, sum(rate(${selector}[5m])) by (le${splitBy ? `, ${splitBy}` : ''}))`;
  }
  return splitBy ? `count by (${splitBy}) (${selector})` : `count(${selector})`;
}

/** Earliest finite sample time in `series`, or null. Finite, not positive:
 * a quantile or a count can be 0. */
function earliestFinite(series: readonly MetricSeries[]): number | null {
  let min: number | null = null;
  for (const s of series) {
    for (const p of s.points) {
      if (Number.isFinite(p.v) && (min === null || p.t < min)) min = p.t;
    }
  }
  return min;
}

/**
 * Coverage start across a split: each required value's earliest sample,
 * then the LATEST of those (null if any value has none). Taking the
 * earliest instead would let one long-covered series hide another's gap —
 * the very bug the split exists to fix. Series whose label is not a
 * required value are ignored.
 */
export function splitCoverageSec(series: readonly MetricSeries[], split: CoverageSplit): number | null {
  if (split.values.length === 0) return earliestFinite(series);
  let latest: number | null = null;
  for (const value of new Set(split.values)) {
    const first = earliestFinite(series.filter((s) => s.labels[split.label] === value));
    if (first === null) return null;
    if (latest === null || first > latest) latest = first;
  }
  return latest;
}

export interface MetricsCoverageProbeOptions<E extends MetricsBackfillEmitter> {
  /** Probe expression per emitter. Default {@link coverageProbeQuery}. For
   * an emitter with `coverageSplit`, the expression must keep the split
   * label on its result series (e.g. `… by (quantile)`). */
  query?(emitter: E): string;
  /** Range-query step. Default 60 — the emitters' bin, so the first covered
   * sample lands on the first written minute rather than up to a step later. */
  stepSec?: number;
  dataset?: string;
  transport?: MetricsTransport;
}

/**
 * A ready-made `earliestCoveredSec` dep over `/metrics` `queryRange`.
 * Histogram probes start 5 minutes early so the first step's `rate[5m]`
 * has samples (else a short gap reads uncovered and is re-emitted).
 * Coverage is a FINITE sample, not a positive one: a quantile can be 0.
 * An emitter with `coverageSplit` is probed per label value and covered
 * from the latest of those values' earliest samples ({@link splitCoverageSec}).
 */
export function createMetricsCoverageProbe<E extends MetricsBackfillEmitter>(
  opts: MetricsCoverageProbeOptions<E> = {},
): MetricsBackfillDeps<E>['earliestCoveredSec'] {
  const step = opts.stepSec ?? 60;
  return async (emitter, earliestMs, latestMs) => {
    const startMs = emitter.kind === 'histogram' ? earliestMs - 300_000 : earliestMs;
    const split = emitter.coverageSplit;
    const query = opts.query?.(emitter)
      ?? coverageProbeQuery(emitter.metricName, emitter.kind, { splitBy: split?.label, labels: emitter.coverageLabels });
    const series = await queryRange(query, {
      earliest: startMs,
      latest: latestMs,
      step,
      dataset: opts.dataset,
      transport: opts.transport,
    });
    return split ? splitCoverageSec(series, split) : earliestFinite(series);
  };
}

interface RunState {
  result: EmitterBackfillResult;
  minChunk: number;
}

/** One window, halving on a retryable drop. Newer half first, so an abort
 * between halves still leaves coverage contiguous from the top. */
async function runWindow<E extends MetricsBackfillEmitter>(
  deps: MetricsBackfillDeps<E>,
  emitter: E,
  w: BackfillWindow,
  state: RunState,
  signal: AbortSignal | undefined,
): Promise<ExportStats> {
  const stats = await deps.runExport(emitter.query, w.earliestSec * 1000, w.latestSec * 1000);
  const r = state.result;
  r.exportsRun += 1;
  r.eventsOut += stats.eventsOut;
  if (!stats.reported) r.unreportedExports += 1;
  if (stats.eventsDropped <= 0) return stats;

  const retryable = (deps.isRetryableDrop ?? isRetryableDrop)(stats);
  if (!retryable) {
    r.eventsDropped += stats.eventsDropped;
    throw new NonRetryableDrop(w, stats);
  }
  const span = w.latestSec - w.earliestSec;
  if (span <= state.minChunk) {
    r.eventsDropped += stats.eventsDropped;
    r.droppedWindows.push(w);
    deps.log?.(`backfill ${emitter.id}: ${stats.eventsDropped} dropped in dense window ${w.earliestSec}-${w.latestSec}`);
    return stats;
  }
  if (stats.eventsOut > 0) r.partialRetries.push(w);
  const mid = Math.max(floorToMinute(w.earliestSec + Math.floor(span / 2)), w.earliestSec + state.minChunk);
  const newer = { earliestSec: Math.min(mid, w.latestSec), latestSec: w.latestSec };
  const older = { earliestSec: w.earliestSec, latestSec: newer.earliestSec };
  deps.log?.(`backfill ${emitter.id}: split ${w.earliestSec}-${w.latestSec} after ${stats.eventsDropped} dropped`);
  if (newer.latestSec > newer.earliestSec) await runWindow(deps, emitter, newer, state, signal);
  if (signal?.aborted) throw new BackfillAborted();
  if (older.latestSec > older.earliestSec) await runWindow(deps, emitter, older, state, signal);
  return stats;
}

class NonRetryableDrop extends Error {
  constructor(readonly window: BackfillWindow, readonly stats: ExportStats) {
    super(`export dropped all ${stats.eventsDropped} events in ${window.earliestSec}-${window.latestSec}` +
      (Object.keys(stats.dropReasons).length ? ` (${JSON.stringify(stats.dropReasons)})` : '') +
      ' — fix the emitter query; splitting cannot help');
  }
}

class BackfillAborted extends Error {}

/**
 * Backfill every emitter over the last `horizonSec` seconds, each only over
 * its uncovered gap, newest→oldest, without drops. Never throws for a
 * failing emitter (it is reported and the next one runs); deps errors from
 * the probe or an export do propagate. Abort returns the partial result
 * with `aborted: true`.
 */
export async function runMetricsBackfill<E extends MetricsBackfillEmitter>(
  emitters: readonly E[],
  deps: MetricsBackfillDeps<E>,
  opts: MetricsBackfillOptions,
): Promise<MetricsBackfillResult> {
  const toSec = floorToMinute(opts.nowSec);
  const fromSec = floorToMinute(toSec - opts.horizonSec);
  const minChunk = opts.minChunkSeconds ?? MIN_BACKFILL_CHUNK_SECONDS;
  const results: EmitterBackfillResult[] = [];
  let aborted = false;

  for (const [index, emitter] of emitters.entries()) {
    if (opts.signal?.aborted) { aborted = true; break; }
    const result: EmitterBackfillResult = {
      id: emitter.id, metricName: emitter.metricName, status: 'filled', gap: null,
      windows: 0, exportsRun: 0, eventsOut: 0, eventsDropped: 0,
      droppedWindows: [], partialRetries: [], unreportedExports: 0,
    };
    results.push(result);
    opts.onProgress?.({ phase: 'probe', emitterId: emitter.id, emitterIndex: index, emitterCount: emitters.length });

    const covered = await deps.earliestCoveredSec(emitter, fromSec * 1000, toSec * 1000);
    const gapToSec = covered === null ? toSec : Math.min(floorToMinute(covered), toSec);
    if (gapToSec <= fromSec) {
      result.status = 'skipped';
      deps.log?.(`backfill ${emitter.id}: already covered`);
      opts.onProgress?.({ phase: 'plan', emitterId: emitter.id, gap: null, windowCount: 0 });
      opts.onProgress?.({ phase: 'emitter-done', result });
      continue;
    }

    const gap = { earliestSec: fromSec, latestSec: gapToSec };
    result.gap = gap;
    const planned = deps.planWindows
      ? [...await deps.planWindows(emitter, gap)]
      : planFixedWindows(fromSec, gapToSec, emitter.windowSeconds ?? DEFAULT_BACKFILL_WINDOW_SECONDS);
    const tilingError = windowTilingError(planned, gap);
    if (tilingError) {
      result.status = 'failed';
      result.error = `planWindows output does not tile the gap: ${tilingError}`;
      deps.log?.(`backfill ${emitter.id}: ${result.error}`);
      opts.onProgress?.({ phase: 'plan', emitterId: emitter.id, gap, windowCount: 0 });
      opts.onProgress?.({ phase: 'emitter-done', result });
      continue;
    }
    planned.sort((a, b) => b.latestSec - a.latestSec);
    result.windows = planned.length;
    deps.log?.(`backfill ${emitter.id}: gap ${fromSec}-${gapToSec}, ${planned.length} window(s), newest first`);
    opts.onProgress?.({ phase: 'plan', emitterId: emitter.id, gap, windowCount: planned.length });

    const state: RunState = { result, minChunk };
    try {
      for (const [done, w] of planned.entries()) {
        if (opts.signal?.aborted) throw new BackfillAborted();
        const stats = await runWindow(deps, emitter, w, state, opts.signal);
        opts.onProgress?.({
          phase: 'window', emitterId: emitter.id, window: w,
          windowsDone: done + 1, windowCount: planned.length, stats,
        });
      }
    } catch (error) {
      if (error instanceof BackfillAborted) {
        result.status = 'aborted';
        aborted = true;
      } else if (error instanceof NonRetryableDrop) {
        result.status = 'failed';
        result.error = error.message;
        deps.log?.(`backfill ${emitter.id}: ${error.message}`);
      } else {
        throw error;
      }
    }
    opts.onProgress?.({ phase: 'emitter-done', result });
    if (aborted) break;
  }

  const sum = (key: 'exportsRun' | 'eventsOut' | 'eventsDropped') => results.reduce((n, r) => n + r[key], 0);
  return {
    horizon: { earliestSec: fromSec, latestSec: toSec },
    emitters: results,
    exportsRun: sum('exportsRun'),
    eventsOut: sum('eventsOut'),
    eventsDropped: sum('eventsDropped'),
    aborted,
  };
}
