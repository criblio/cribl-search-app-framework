const DEFAULT_SEARCH_BASE = '/m/default_search/search';

export interface SearchHttpClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  del?(path: string): Promise<unknown>;
}

export interface SearchJobOptions {
  earliest?: string;
  latest?: string;
  limit?: number;
  pageSize?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  searchBase?: string;
}

export type SearchFailureKind =
  | 'aborted'
  | 'creation'
  | 'poll'
  | 'timeout'
  | 'job'
  | 'results'
  | 'malformed-response';

export class SearchJobError extends Error {
  constructor(
    public readonly kind: SearchFailureKind,
    message: string,
    public readonly jobId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SearchJobError';
  }
}

function itemFrom(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.items)) {
    const item = record.items[0];
    return item && typeof item === 'object' ? item as Record<string, unknown> : undefined;
  }
  return record;
}

function apiError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return record.status === 'error' ? String(record.message ?? 'unknown Cribl error') : undefined;
}

function jobStatus(value: unknown, fallback = ''): string {
  const item = itemFrom(value);
  return typeof item?.status === 'string' ? item.status : fallback;
}

function jobIdentifier(value: unknown): string {
  const item = itemFrom(value);
  return typeof item?.id === 'string' ? item.id : '';
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

function ensureActive(signal: AbortSignal | undefined, jobId?: string): void {
  if (signal?.aborted) throw new SearchJobError('aborted', 'Search was canceled', jobId);
}

function delay(ms: number, signal: AbortSignal | undefined, jobId: string): Promise<void> {
  ensureActive(signal, jobId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new SearchJobError('aborted', 'Search was canceled', jobId));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function parseNdjson(raw: unknown, jobId: string): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    if (raw.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
      return raw as Record<string, unknown>[];
    }
    throw new SearchJobError('malformed-response', 'Search results array contains a non-object row', jobId);
  }
  if (raw && typeof raw === 'object') return [];
  if (typeof raw !== 'string') {
    throw new SearchJobError('malformed-response', 'Search results were not NDJSON', jobId);
  }
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length <= 1) return [];
  const rows: Record<string, unknown>[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    try {
      const parsed: unknown = JSON.parse(lines[index]);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('row is not an object');
      }
      rows.push(parsed as Record<string, unknown>);
    } catch (error) {
      throw new SearchJobError(
        'malformed-response',
        `Search results contain malformed NDJSON at data line ${index}`,
        jobId,
        { cause: error },
      );
    }
  }
  return rows;
}

async function cancelJob(http: SearchHttpClient, path: string): Promise<void> {
  if (!http.del) return;
  await http.del(path).catch(() => undefined);
}

/** Run one Cribl Search job through an injected browser or Node HTTP client. */
export async function runSearchJob(
  http: SearchHttpClient,
  query: string,
  options: SearchJobOptions = {},
): Promise<Record<string, unknown>[]> {
  const {
    earliest = '-1h',
    latest = 'now',
    limit = 200,
    pageSize = 200,
    pollIntervalMs = 400,
    timeoutMs = 48_000,
    signal,
    searchBase = DEFAULT_SEARCH_BASE,
  } = options;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100_000) {
    throw new SearchJobError('creation', 'Search result limit is invalid');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new SearchJobError('creation', 'Search result page size is invalid');
  }
  ensureActive(signal);

  let created: unknown;
  try {
    created = await http.post(`${searchBase}/jobs`, { query, earliest, latest });
  } catch (error) {
    throw new SearchJobError('creation', 'Search job creation failed', undefined, { cause: error });
  }
  const createError = apiError(created);
  if (createError) throw new SearchJobError('creation', `Cribl: ${createError}`);
  const jobId = jobIdentifier(created);
  if (!jobId) throw new SearchJobError('malformed-response', 'Search job response is missing items[0].id');
  const jobPath = `${searchBase}/jobs/${encodeURIComponent(jobId)}`;

  const abort = () => { void cancelJob(http, jobPath); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    let status = jobStatus(created, 'queued');
    const deadline = Date.now() + timeoutMs;
    while (!isTerminal(status)) {
      ensureActive(signal, jobId);
      if (Date.now() >= deadline) {
        await cancelJob(http, jobPath);
        throw new SearchJobError('timeout', `Search job ${jobId} timed out`, jobId);
      }
      await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), signal, jobId);
      let polled: unknown;
      try {
        polled = await http.get(jobPath);
      } catch (error) {
        throw new SearchJobError('poll', `Search job ${jobId} poll failed`, jobId, { cause: error });
      }
      const pollError = apiError(polled);
      if (pollError) throw new SearchJobError('poll', `Cribl: ${pollError}`, jobId);
      status = jobStatus(polled, status);
    }
    if (status !== 'completed') {
      throw new SearchJobError('job', `Search job ${jobId} ended with status: ${status}`, jobId);
    }

    const rows: Record<string, unknown>[] = [];
    let offset = 0;
    while (rows.length < limit) {
      ensureActive(signal, jobId);
      const requested = Math.min(pageSize, limit - rows.length);
      let raw: unknown;
      try {
        raw = await http.get(`${jobPath}/results?offset=${offset}&limit=${requested}`);
      } catch (error) {
        throw new SearchJobError('results', `Search job ${jobId} result fetch failed`, jobId, { cause: error });
      }
      const events = parseNdjson(raw, jobId);
      rows.push(...events.slice(0, requested));
      if (events.length < requested) break;
      offset += events.length;
    }
    return rows;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
