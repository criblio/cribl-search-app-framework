/** Browser client for the Cribl Search job API. */

import { runSearchJob, type SearchHttpClient } from './search-job.js';

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

function browserSearchClient(): SearchHttpClient {
  const base = apiUrl().replace(/\/$/, '');
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
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
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    del: (path) => call('DELETE', path),
  };
}

/** Backward-compatible browser convenience wrapper around the shared runner. */
export async function runQuery(
  kql: string,
  earliest: string = '-1h',
  latest: string = 'now',
  limit: number = 200,
): Promise<Record<string, unknown>[]> {
  return runSearchJob(browserSearchClient(), kql, { earliest, latest, limit });
}
