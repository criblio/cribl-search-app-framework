/**
 * Thin client for Cribl Search job API.
 *
 * Inside the Cribl App Platform iframe, window.CRIBL_API_URL is injected
 * and authenticated cookies are present, so fetch() Just Works.
 * Search endpoints must be called via the default_search worker group
 * prefix /m/default_search/search/...
 */

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

function searchBase(): string {
  return `${apiUrl()}/m/default_search/search`;
}

interface JobItem {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | string;
}

interface JobListResponse {
  items?: JobItem[];
  count?: number;
}

interface ApiError {
  status?: string;
  message?: string;
}

function isApiError(body: unknown): body is ApiError {
  return !!body && typeof body === 'object' && 'status' in body && (body as ApiError).status === 'error';
}

export async function runQuery(
  kql: string,
  earliest: string = '-1h',
  latest: string = 'now',
  limit: number = 200,
): Promise<Record<string, unknown>[]> {
  const createResp = await fetch(`${searchBase()}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: kql, earliest, latest }),
  });
  if (!createResp.ok) {
    throw new Error(`Search job creation failed (${createResp.status}): ${await createResp.text()}`);
  }
  const createBody = (await createResp.json()) as JobListResponse | ApiError;
  if (isApiError(createBody)) {
    throw new Error(`Cribl: ${createBody.message ?? 'unknown error'}`);
  }
  const job = createBody.items?.[0];
  if (!job?.id) {
    throw new Error(`Search job creation: missing items[0].id in response`);
  }
  const jobId = job.id;

  let status = job.status;
  for (let i = 0; i < 120 && status !== 'completed' && status !== 'failed' && status !== 'canceled'; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const pollResp = await fetch(`${searchBase()}/jobs/${jobId}`);
    if (!pollResp.ok) throw new Error(`Job poll failed (${pollResp.status})`);
    const pollBody = (await pollResp.json()) as JobListResponse | ApiError;
    if (isApiError(pollBody)) throw new Error(`Cribl: ${pollBody.message ?? 'unknown error'}`);
    status = pollBody.items?.[0]?.status ?? status;
  }
  if (status !== 'completed') {
    throw new Error(`Search job ${jobId} ended with status: ${status}`);
  }

  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  while (rows.length < limit) {
    const pageSize = Math.min(200, limit - rows.length);
    const res = await fetch(
      `${searchBase()}/jobs/${jobId}/results?offset=${offset}&limit=${pageSize}`,
    );
    if (!res.ok) throw new Error(`Results fetch failed (${res.status})`);
    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) break;
    const events: Record<string, unknown>[] = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        events.push(JSON.parse(lines[i]) as Record<string, unknown>);
      } catch { /* ignore malformed line */ }
    }
    rows.push(...events);
    if (events.length < pageSize) break;
    offset += events.length;
  }
  return rows;
}
