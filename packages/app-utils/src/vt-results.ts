/**
 * Read scheduled-search output back out of `$vt_results`.
 *
 * The point of a scheduled search is that a page reads its rows in ~1 s
 * instead of re-running the aggregation live (each live job also pays
 * queue wait in the worker pool — one app's five-panel home page cost
 * 8–15 s live and ~1 s cached). This reader batches every panel into ONE
 * job and partitions the rows by `jobName`.
 *
 * A job with no rows is ABSENT from the result map — the search has not
 * run yet, the window missed it, or the dataset just changed. That is a
 * cache miss, not an error: the caller falls back to its live query.
 */
import { kqlStringLiteral } from './kql.js';
import { runQuery as browserRunQuery } from './search.js';

/** Same signature as `runQuery` from `/search` and `createCellRunQuery`
 * from `/cell-cribl`, so a server-side host can pass its own. */
export type VtRunQuery = (
  kql: string,
  earliest: string,
  latest: string,
  limit: number,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>[]>;

export interface ReadVtResultsOptions {
  /** Default `'-1h'`. Must cover your slowest cadence, or that job's
   * key is simply absent (a miss, not an error). */
  earliest?: string;
  /** Default `'now'`. */
  latest?: string;
  /** Default 10 000. `runQuery` defaults to 200, which silently
   * truncates a batched read — one panel alone can be 60 buckets × 20
   * series. */
  limit?: number;
  signal?: AbortSignal;
  /** Default `true`: keep only each job's newest run (see `latestRunRows`). */
  latestRunOnly?: boolean;
  /** Default: the browser `runQuery`. */
  runQuery?: VtRunQuery;
}

export const DEFAULT_VT_RESULTS_LIMIT = 10_000;

/**
 * The batched query. `jobName in (...)`, not the documented
 * `jobName=["a","b"]` array form, which Cribl KQL does not parse
 * ("no viable alternative at input 'jobName=['").
 */
export function vtResultsQuery(jobNames: string[]): string {
  const list = [...new Set(jobNames)].map(kqlStringLiteral).join(', ');
  return `dataset="$vt_results" | where jobName in (${list})`;
}

/**
 * Keep only the newest run's rows. `$vt_results` retains `keepLastN` runs
 * per search, so a reader treating a partition as "current state" would
 * otherwise mix a stale run in — a service that flapped between runs
 * appears twice, once with its old status. A `jobId` carries a fixed-width
 * epoch-ms component, so for one search the string max is the newest run.
 * Rows from one search only; rows with no `jobId` at all are returned as-is.
 */
export function latestRunRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  let latest = '';
  for (const row of rows) {
    const id = String(row.jobId ?? '');
    if (id > latest) latest = id;
  }
  if (!latest) return rows;
  return rows.filter((row) => String(row.jobId ?? '') === latest);
}

/**
 * When a run started, from its `jobId` (`1704236905683.wgocax`, or
 * `<search>.1704236905683.wgocax` for a scheduled job), in epoch ms.
 * `null` when no 13-digit epoch-ms component is present.
 */
export function runStartedMs(jobId: unknown): number | null {
  if (typeof jobId !== 'string') return null;
  const match = /(?:^|\.)(\d{13})(?=\.|$)/.exec(jobId);
  return match ? Number(match[1]) : null;
}

/**
 * Read several scheduled searches' latest results in one job.
 *
 * ```ts
 * const cached = await readVtResults(['myapp__summary', 'myapp__series']);
 * const summary = cached.get('myapp__summary') ?? await runQuery(liveSummaryKql);
 * ```
 */
export async function readVtResults(
  jobNames: string[],
  opts: ReadVtResultsOptions = {},
): Promise<Map<string, Record<string, unknown>[]>> {
  const out = new Map<string, Record<string, unknown>[]>();
  if (jobNames.length === 0) return out;
  const run = opts.runQuery ?? browserRunQuery;
  const rows = await run(
    vtResultsQuery(jobNames),
    opts.earliest ?? '-1h',
    opts.latest ?? 'now',
    opts.limit ?? DEFAULT_VT_RESULTS_LIMIT,
    opts.signal,
  );
  const wanted = new Set(jobNames);
  for (const row of rows) {
    const name = String(row.jobName ?? '');
    if (!wanted.has(name)) continue;
    let bucket = out.get(name);
    if (!bucket) out.set(name, (bucket = []));
    bucket.push(row);
  }
  if (opts.latestRunOnly !== false) {
    for (const [name, bucket] of out) out.set(name, latestRunRows(bucket));
  }
  return out;
}
