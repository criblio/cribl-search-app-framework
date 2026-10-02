/** Browser client for the Cribl Search job API. */

import { runSearchJob, type SearchHttpClient } from './search-job.js';
import { withGenerationSignal } from './query-generation.js';

declare global {
  interface Window {
    CRIBL_API_URL?: string;
    CRIBL_BASE_PATH?: string;
    CRIBL_APP_ID?: string;
  }
}

export function apiUrl(): string {
  return window.CRIBL_API_URL ?? '/api/v1';
}

/**
 * Build a browser HTTP client for the search-job runner.
 *
 * `get`/`post` carry the navigation signal so their in-flight fetches
 * abort on nav. `del` deliberately does NOT — it's the job-cancellation
 * DELETE the runner fires *from* the abort handler; passing the
 * already-aborted signal would abort the cancellation itself and leak
 * the worker-pool slot.
 */
function browserSearchClient(signal?: AbortSignal): SearchHttpClient {
  const base = apiUrl().replace(/\/$/, '');
  async function call(
    method: string,
    path: string,
    body?: unknown,
    reqSignal?: AbortSignal,
  ): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: reqSignal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`${method} ${path} failed (${response.status}): ${detail.slice(0, 400)}`);
    }
    const text = await response.text();
    if (path.includes('/results?')) return text;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('json')) return text ? JSON.parse(text) : {};
    return text;
  }
  return {
    get: (path) => call('GET', path, undefined, signal),
    post: (path, body) => call('POST', path, body, signal),
    del: (path) => call('DELETE', path), // no signal — cancellation must survive abort
  };
}

/**
 * Browser convenience wrapper around the shared runner, cancellable on
 * navigation. When no `signal` is passed it defaults to the current
 * navigation generation (see query-generation.ts) so a KQL search job
 * is cancelled — poll loop broken, worker-pool slot released, in-flight
 * fetches aborted — when the user navigates away. Apps opt in by calling
 * `newQueryGeneration()` on nav; apps that don't get the previous
 * (never-aborted) behavior.
 */
export async function runQuery(
  kql: string,
  earliest: string = '-1h',
  latest: string = 'now',
  limit: number = 200,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const sig = withGenerationSignal(signal);
  return runSearchJob(browserSearchClient(sig), kql, { earliest, latest, limit, signal: sig });
}

/** Default `runWithLimit` cap: the cluster's ~20 concurrent search jobs are shared by every panel and user, and APM's Spotlight hit 429s uncapped. */
export const SEARCH_FANOUT_LIMIT = 4;

/** Options for {@link runWithLimit} / {@link runWithLimitSettled}. */
export interface RunWithLimitOptions {
  /**
   * Once aborted, no further items start; each unstarted item rejects with
   * `signal.reason`. Items already running are not interrupted here — the
   * same signal is passed to the worker so it can cancel its own job.
   */
  signal?: AbortSignal;
}

/**
 * Run `worker` over `items` with at most `limit` in flight, settling every
 * item. Results are in input order regardless of completion order.
 *
 * This exists for search fan-out: Cribl Search caps concurrent jobs per
 * cluster (`Search queue limit reached (max: 20)`), and a page already holds
 * several of those slots. APM's Spotlight fanned out 22 attribute queries
 * unbounded and the tail returned 429s; a limit of 4 fixed it. Use
 * {@link SEARCH_FANOUT_LIMIT} unless you know the page runs nothing else.
 *
 * One item's failure never stops the others — a slow or broken attribute
 * must not blank every other panel.
 */
export async function runWithLimitSettled<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
  options: RunWithLimitOptions = {},
): Promise<PromiseSettledResult<R>[]> {
  if (!(limit >= 1)) throw new RangeError(`runWithLimit: limit must be >= 1, got ${limit}`);
  const { signal } = options;
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;

  async function pump(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      if (signal?.aborted) {
        results[i] = { status: 'rejected', reason: signal.reason };
        continue;
      }
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i] as T, i, signal) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const lanes = Math.min(Math.floor(Math.min(limit, Number.MAX_SAFE_INTEGER)), items.length);
  await Promise.all(Array.from({ length: lanes }, () => pump()));
  return results;
}

/**
 * {@link runWithLimitSettled}, unwrapped: resolves to the results in input
 * order, or rejects with the lowest-index failure. It rejects only after
 * every item has settled, so no search job is still running — and holding a
 * cluster slot — once the caller has moved on.
 *
 * ```ts
 * const rows = await runWithLimit(attrs, SEARCH_FANOUT_LIMIT, (attr, _i, signal) =>
 *   runQuery(distributionKql(attr), '-1h', 'now', 20, signal));
 * ```
 *
 * For per-item error handling (stream each result as it lands, show "no
 * answer" for the ones that failed) catch inside the worker, or use
 * {@link runWithLimitSettled}.
 */
export async function runWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
  options: RunWithLimitOptions = {},
): Promise<R[]> {
  const settled = await runWithLimitSettled(items, limit, worker, options);
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map((r) => (r as PromiseFulfilledResult<R>).value);
}
