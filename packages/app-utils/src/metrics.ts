/**
 * Client for the Cribl Search metrics query API.
 *
 * This mirrors what the built-in Metrics app (`__cribl_metrics`) does:
 * a synchronous GET to `/m/default_search/search/query` with
 * `searchJobSource=metrics&datasetId=<dataset>`. The `query` parameter is
 * PromQL: bare selectors, label matchers (`{type="uap"}`), aggregations
 * with `by` clauses, `rate(m[5m])`, `topk(...)`, scalar arithmetic, etc.
 *
 * Response is NDJSON. The first line is a job summary:
 *   {"isFinished":true, "totalEventCount":N, "job":{"id":"mq-...","status":"completed"}}
 * Each following line is an event. For expression queries the events are
 *   {"_kind":"sample", <groupLabels...>, "_time":<epochSec>, "_value":<num>}
 * With `step` set you get a range query (one sample per step per series);
 * without it you get an instant query (single sample per series at `latest`).
 *
 * Discovery queries use a dot-command grammar instead of PromQL:
 *   .labels                → {"_kind":"label",   "_value":"<labelName>"}
 *   .metadata              → {"_kind":"metadata", "__name__", "_type", "_help", "_unit"}
 *   .series <metric>       → {"_kind":"series",  "__name__", <label>:<value>, ...}
 */

import { apiUrl } from './search.js';

/** Default dataset for metrics queries. */
export const METRICS_DATASET = 'metrics';

export interface MetricsQueryOptions {
  /** Relative (`-1h`) or epoch-ms time. Default `-1h`. */
  earliest?: string | number;
  /** Relative or epoch-ms time. Default `now`. */
  latest?: string | number;
  /** Range-query step in seconds. Omit for an instant query. */
  step?: number;
  /** Override the metrics dataset. */
  dataset?: string;
  signal?: AbortSignal;
  /**
   * How the metrics query GET is executed. Defaults to
   * {@link defaultMetricsTransport}, which reads `window.CRIBL_API_URL`
   * and relies on the iframe fetch proxy — correct in the app. A
   * non-browser host (a server-side investigation runtime) injects a
   * transport that targets its own base URL and adds auth, exactly as
   * the search-job runner takes an injected HTTP client. Given a query
   * + options, it returns the raw NDJSON response body.
   */
  transport?: MetricsTransport;
}

/** Executes the metrics query GET and returns the raw NDJSON body. */
export type MetricsTransport = (
  query: string,
  opts: MetricsQueryOptions,
) => Promise<string>;

/** One event row from the metrics API, `_time` normalized to epoch seconds. */
export interface MetricSample {
  _time: number;
  _value: number;
  /** Grouping labels (everything the server returned except _kind/_time/_value). */
  labels: Record<string, string>;
}

/** A time series: one label set plus its ordered samples. */
export interface MetricSeries {
  labels: Record<string, string>;
  points: Array<{ t: number; v: number }>;
}

export interface MetricMetadata {
  name: string;
  type: string;
  help: string;
  unit: string;
}

interface RawRow {
  _kind: string;
  _time?: number | string;
  _value?: number | string;
  [key: string]: unknown;
}

/**
 * The metrics query path relative to an `/api/v1` base:
 * `/m/default_search/search/query?…`. Exported so an injected
 * transport builds the identical request against its own base URL
 * rather than re-deriving the parameter contract.
 */
export function metricsQueryPath(query: string, opts: MetricsQueryOptions): string {
  const params = new URLSearchParams({
    query,
    earliest: String(opts.earliest ?? '-1h'),
    latest: String(opts.latest ?? 'now'),
    searchJobSource: 'metrics',
    datasetId: opts.dataset ?? METRICS_DATASET,
  });
  if (opts.step !== undefined) params.set('step', String(opts.step));
  return `/m/default_search/search/query?${params}`;
}

function buildUrl(query: string, opts: MetricsQueryOptions): string {
  return `${apiUrl().replace(/\/$/, '')}${metricsQueryPath(query, opts)}`;
}

/**
 * Browser transport: GET the metrics query URL through the iframe
 * fetch proxy (auth rides the parent session). This is the default
 * when no transport is injected.
 */
export const defaultMetricsTransport: MetricsTransport = async (query, opts) => {
  const response = await fetch(buildUrl(query, opts), { signal: opts.signal });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`metrics query failed (${response.status}): ${text.slice(0, 400)}`);
  }
  return text;
};

async function fetchRows(query: string, opts: MetricsQueryOptions = {}): Promise<RawRow[]> {
  const transport = opts.transport ?? defaultMetricsTransport;
  const text = await transport(query, opts);
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const summary = JSON.parse(lines[0]) as {
    isFinished?: boolean;
    job?: { status?: string; id?: string };
  };
  if (summary.job?.status && summary.job.status !== 'completed') {
    throw new Error(`metrics query job ${summary.job.id} status: ${summary.job.status}`);
  }
  return lines.slice(1).map((l) => JSON.parse(l) as RawRow);
}

function toSample(row: RawRow): MetricSample {
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === '_kind' || key === '_time' || key === '_value') continue;
    labels[key] = String(value);
  }
  return { _time: Number(row._time), _value: Number(row._value), labels };
}

/** Signature used to group samples of one series together. */
function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(' ');
}

/** Run any PromQL expression; returns flat samples in server order. */
export async function runMetricsQuery(
  query: string,
  opts: MetricsQueryOptions = {},
): Promise<MetricSample[]> {
  const rows = await fetchRows(query, opts);
  return rows.filter((r) => r._kind === 'sample').map(toSample);
}

/**
 * Range query: PromQL expression evaluated every `step` seconds.
 * Samples are grouped into series by label set, points sorted by time.
 */
export async function queryRange(
  query: string,
  opts: MetricsQueryOptions & { step: number },
): Promise<MetricSeries[]> {
  const samples = await runMetricsQuery(query, opts);
  const byKey = new Map<string, MetricSeries>();
  for (const s of samples) {
    const key = labelKey(s.labels);
    let series = byKey.get(key);
    if (!series) {
      series = { labels: s.labels, points: [] };
      byKey.set(key, series);
    }
    series.points.push({ t: s._time, v: s._value });
  }
  const result = [...byKey.values()];
  for (const series of result) series.points.sort((a, b) => a.t - b.t);
  return result;
}

/** Instant query: single sample per series at `latest`. */
export async function queryInstant(
  query: string,
  opts: MetricsQueryOptions = {},
): Promise<MetricSample[]> {
  const { step: _ignored, ...rest } = opts;
  void _ignored;
  return runMetricsQuery(query, rest);
}

/** List metric names + type/help/unit, optionally filtered by prefix. */
export async function listMetricMetadata(
  prefix?: string,
  opts: MetricsQueryOptions = {},
): Promise<MetricMetadata[]> {
  const rows = await fetchRows('.metadata', opts);
  return rows
    .filter((r) => r._kind === 'metadata')
    .map((r) => ({
      name: String(r.__name__ ?? ''),
      type: String(r._type ?? ''),
      help: String(r._help ?? ''),
      unit: String(r._unit ?? ''),
    }))
    .filter((m) => !prefix || m.name.startsWith(prefix));
}

/** List label names present in the dataset. */
export async function listLabels(opts: MetricsQueryOptions = {}): Promise<string[]> {
  const rows = await fetchRows('.labels', opts);
  return rows.filter((r) => r._kind === 'label').map((r) => String(r._value));
}

/** One entry from GET /m/default_search/search/datasets (fields vary by provider). */
export interface SearchDatasetInfo {
  id: string;
  type?: string;
  provider?: string;
  description?: string;
  [key: string]: unknown;
}

/** List all Search datasets in the workspace. */
export async function listSearchDatasets(signal?: AbortSignal): Promise<SearchDatasetInfo[]> {
  const response = await fetch(`${apiUrl().replace(/\/$/, '')}/m/default_search/search/datasets`, {
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`listing datasets failed (${response.status}): ${detail.slice(0, 400)}`);
  }
  const body = (await response.json()) as { items?: SearchDatasetInfo[] };
  return body.items ?? [];
}

/** List the label sets (series) of one metric. */
export async function listSeries(
  metric: string,
  opts: MetricsQueryOptions = {},
): Promise<Array<Record<string, string>>> {
  const rows = await fetchRows(`.series ${metric}`, opts);
  return rows
    .filter((r) => r._kind === 'series')
    .map((r) => {
      const labels: Record<string, string> = {};
      for (const [key, value] of Object.entries(r)) {
        if (key === '_kind') continue;
        labels[key] = String(value);
      }
      return labels;
    });
}

// ── Dedup + short-TTL cache for the fast metrics store ────────────────
/**
 * Metrics reads are pure, idempotent GETs against the PromQL engine, but
 * some are expensive (`histogram_quantile`, wide anomaly baselines). The
 * engine keeps *computing* a query even after the browser aborts the
 * fetch — so cancelling in-flight reads on rapid re-navigation and then
 * re-firing identical ones piles abandoned-but-running computations onto
 * the engine, and later cheap reads queue behind that backlog. Page
 * latency then escalates across repeated navs even though client-side
 * pending requests stay flat.
 *
 * The fix, for idempotent metrics reads: DON'T cancel — dedupe and
 * briefly cache. A repeat nav (or a duplicate read within one view's
 * fan-out) reuses the single in-flight promise or a recent result rather
 * than spawning a fresh expensive computation. KQL search jobs stay
 * cancellable (they hold worker-pool slots worth releasing); a metrics
 * GET just needs to finish once and be reused.
 *
 * Because these reads deliberately drop any `signal`, a stale result can
 * still resolve after a nav — pair them with `captureQueryGeneration()`
 * at the call site to drop late fills before they touch the UI.
 *
 * TTL is short (metrics are minute-binned; a few seconds of staleness is
 * invisible) — long enough to absorb a burst of navigations, short
 * enough that a view's own auto-refresh still sees fresh data.
 */
const CACHE_TTL_MS = 12_000;

interface CacheEntry<T> {
  at: number;
  value: T;
}

const instantCache = new Map<string, CacheEntry<MetricSample[]>>();
const instantInflight = new Map<string, Promise<MetricSample[]>>();
const rangeCache = new Map<string, CacheEntry<MetricSeries[]>>();
const rangeInflight = new Map<string, Promise<MetricSeries[]>>();

function cacheKey(query: string, opts: MetricsQueryOptions): string {
  return [
    query,
    String(opts.earliest ?? '-1h'),
    String(opts.latest ?? 'now'),
    opts.step ?? '',
    opts.dataset ?? '',
  ].join('|');
}

/**
 * Cached, de-duplicated instant query. Deliberately drops any `signal`:
 * the read runs to completion so its result can be reused. Errors are
 * not cached (the next caller retries).
 */
export async function cachedQueryInstant(
  query: string,
  opts: MetricsQueryOptions = {},
): Promise<MetricSample[]> {
  const key = cacheKey(query, opts);
  const hit = instantCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const existing = instantInflight.get(key);
  if (existing) return existing;
  const { signal: _drop, ...rest } = opts;
  void _drop;
  const p = queryInstant(query, rest)
    .then((rows) => {
      instantCache.set(key, { at: Date.now(), value: rows });
      instantInflight.delete(key);
      return rows;
    })
    .catch((err) => {
      instantInflight.delete(key);
      throw err;
    });
  instantInflight.set(key, p);
  return p;
}

/** Cached, de-duplicated range query. Same semantics as cachedQueryInstant. */
export async function cachedQueryRange(
  query: string,
  opts: MetricsQueryOptions & { step: number },
): Promise<MetricSeries[]> {
  const key = cacheKey(query, opts);
  const hit = rangeCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const existing = rangeInflight.get(key);
  if (existing) return existing;
  const { signal: _drop, ...rest } = opts;
  void _drop;
  const p = queryRange(query, rest)
    .then((series) => {
      rangeCache.set(key, { at: Date.now(), value: series });
      rangeInflight.delete(key);
      return series;
    })
    .catch((err) => {
      rangeInflight.delete(key);
      throw err;
    });
  rangeInflight.set(key, p);
  return p;
}

/** Drop all cached metrics results (e.g. after the user changes dataset). */
export function clearMetricsCache(): void {
  instantCache.clear();
  rangeCache.clear();
}
