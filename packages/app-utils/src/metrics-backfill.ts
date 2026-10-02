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

import { queryRange, type MetricsTransport } from './metrics.js';
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
   * source-event count ({@link planDensityWindows}). Must tile the gap. */
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
 */
export function planDensityWindows(
  bins: readonly { tSec: number; count: number }[],
  binSeconds: number,
  maxEventsPerWindow: number = SAFE_MAX_EXPORT_EVENTS,
): BackfillWindow[] {
  const windows: BackfillWindow[] = [];
  let start: number | null = null;
  let acc = 0;
  let end = 0;
  for (const bin of bins) {
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
  return windows;
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

/**
 * PromQL that yields a sample wherever a family has data. Histograms answer
 * only through `histogram_quantile(… by (le))` — a bare `count()` of a
 * histogram returns nothing, which made APM re-backfill a covered family.
 */
export function coverageProbeQuery(metricName: string, kind?: string): string {
  if (!METRIC_NAME.test(metricName)) throw new RangeError(`not a metric name: ${metricName}`);
  return kind === 'histogram'
    ? `histogram_quantile(0.5, sum(rate(${metricName}[5m])) by (le))`
    : `count(${metricName})`;
}

export interface MetricsCoverageProbeOptions<E extends MetricsBackfillEmitter> {
  /** Probe expression per emitter. Default {@link coverageProbeQuery}. */
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
 */
export function createMetricsCoverageProbe<E extends MetricsBackfillEmitter>(
  opts: MetricsCoverageProbeOptions<E> = {},
): MetricsBackfillDeps<E>['earliestCoveredSec'] {
  const step = opts.stepSec ?? 60;
  return async (emitter, earliestMs, latestMs) => {
    const startMs = emitter.kind === 'histogram' ? earliestMs - 300_000 : earliestMs;
    const series = await queryRange(opts.query?.(emitter) ?? coverageProbeQuery(emitter.metricName, emitter.kind), {
      earliest: startMs,
      latest: latestMs,
      step,
      dataset: opts.dataset,
      transport: opts.transport,
    });
    let min: number | null = null;
    for (const s of series) {
      for (const p of s.points) {
        if (Number.isFinite(p.v) && (min === null || p.t < min)) min = p.t;
      }
    }
    return min;
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
