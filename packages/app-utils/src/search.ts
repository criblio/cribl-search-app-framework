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
