/**
 * Server-side Cribl access for a cell: what makes the browser tool
 * executors run unchanged inside a workerd isolate with no `window`.
 *
 * The browser reaches Cribl through the iframe fetch proxy, which
 * carries the parent session's auth implicitly — `window.CRIBL_API_URL`
 * plus a bare `fetch` is the whole story. A cell has neither, so every
 * seam the framework already exposes for injection is filled here:
 *
 *   - {@link createCellSearchHttpClient} → a `SearchHttpClient` for
 *     `runSearchJob`, so run_search works server-side,
 *   - {@link createCellMetricsTransport} → a `MetricsTransport` built
 *     from `metricsQueryPath`, so run_metrics_query hits the same
 *     endpoint the browser does,
 *   - {@link createCellApiClient} → an `HttpClient` for the general
 *     Cribl REST API (the provisioner's shape).
 *
 * All three take one injected `bearer()`. Token acquisition, caching,
 * and refresh stay with the host: a cell typically holds OAuth
 * client-credentials in its env and caches the exchange at module
 * scope, and that cache is the host's business, not this module's.
 * Lifted from the APM cell (cell/src/criblClient.ts +
 * cellSearchClient.ts), where this shape has been in production;
 * nothing here is Kidder- or APM-specific.
 */
import { metricsQueryPath, type MetricsTransport } from './metrics.js';
import { runSearchJob, type SearchHttpClient } from './search-job.js';
import type { HttpClient } from './provisioner.js';

/** How a cell obtains a bearer for the Cribl API. Called per request —
 *  implement caching in the host (the token outlives one call). */
export type BearerSource = () => Promise<string>;

export interface CellCriblConfig {
  /** Workspace base URL, e.g. `https://<workspace>.cribl.cloud`. A
   *  trailing slash and a trailing `/api/v1` are both tolerated: the
   *  version prefix is added per request, so passing a base that
   *  already carries one would otherwise produce `/api/v1/api/v1/…`. */
  baseUrl: string;
  bearer: BearerSource;
  /** API version prefix. Defaults to `v1`. The published spec
   *  describes `/api/v2`, so a caller working from it passes 'v2'. */
  apiVersion?: string;
}

/** Strip a trailing slash and any trailing `/api/vN` from a base URL. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/api\/v\d+$/, '');
}

export interface CellCriblResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON when the body is a single JSON document, else the raw
   *  text. NDJSON stays text — see the note in {@link cellCriblFetch}. */
  body: unknown;
  text: string;
}

/**
 * One authenticated request against `{base}/api/{version}{path}`,
 * returning status and body without throwing on a non-2xx. Callers
 * that want the framework's throw-on-error contract wrap this
 * ({@link createCellSearchHttpClient} does); callers that need to
 * report a status to an agent use it directly.
 */
export async function cellCriblFetch(
  cfg: CellCriblConfig,
  method: string,
  path: string,
  opts: { body?: unknown; signal?: AbortSignal } = {},
): Promise<CellCriblResponse> {
  const token = await cfg.bearer();
  const base = `${normalizeBase(cfg.baseUrl)}/api/${cfg.apiVersion ?? 'v1'}`;
  const hasBody = opts.body !== undefined;
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      accept: 'application/json, application/x-ndjson',
    },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const text = await resp.text();
  // A single JSON document parses here; NDJSON (the results and
  // metrics endpoints) does NOT, and must stay raw text —
  // runSearchJob's parseNdjson owns the schema-line-0 skip, and
  // pre-parsing would leak that schema row in as data.
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not a single JSON document; the raw text IS the body.
  }
  return { status: resp.status, ok: resp.ok, body, text };
}

/** The framework's throw-on-error convention, with the status and a
 *  bounded slice of the body in the message so an agent (or a log
 *  line) can tell 403 from 404 from a validation failure. */
async function orThrow(
  cfg: CellCriblConfig,
  method: string,
  path: string,
  opts: { body?: unknown; signal?: AbortSignal } = {},
): Promise<unknown> {
  const resp = await cellCriblFetch(cfg, method, path, opts);
  if (!resp.ok) {
    throw new Error(`Cribl ${method} ${path} → ${resp.status}: ${resp.text.slice(0, 300)}`);
  }
  return resp.body;
}

/**
 * A `SearchHttpClient` for {@link runSearchJob}, so a cell runs the
 * same KQL search jobs the browser does. Pass to `runSearchJob(http,
 * kql, options)` — or straight into `createRunSearchTool`'s `runQuery`
 * via {@link createCellRunQuery}.
 */
export function createCellSearchHttpClient(cfg: CellCriblConfig): SearchHttpClient {
  return {
    get: (path) => orThrow(cfg, 'GET', path),
    post: (path, body) => orThrow(cfg, 'POST', path, { body }),
    del: (path) => orThrow(cfg, 'DELETE', path),
  };
}

/**
 * `createRunSearchTool`'s `runQuery` dependency, wired for a cell: a
 * fresh authenticated client per query (the bearer may have rotated)
 * feeding the shared search-job runner. This is the whole of what
 * run_search needs from a host.
 */
export function createCellRunQuery(
  cfg: CellCriblConfig,
): (
  kql: string,
  earliest: string,
  latest: string,
  limit: number,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>[]> {
  return (kql, earliest, latest, limit, signal) =>
    runSearchJob(createCellSearchHttpClient(cfg), kql, { earliest, latest, limit, signal });
}

/**
 * The `HttpClient` shape the provisioner and dataset-provisioner take
 * — the same four verbs, authenticated for a cell. Lets a cell reuse
 * `reconcile`, `ensureAcceleratedFields`, and friends unchanged.
 */
export function createCellApiClient(cfg: CellCriblConfig): HttpClient {
  return {
    get: (path) => orThrow(cfg, 'GET', path),
    post: (path, body) => orThrow(cfg, 'POST', path, { body }),
    patch: (path, body) => orThrow(cfg, 'PATCH', path, { body }),
    del: (path) => orThrow(cfg, 'DELETE', path),
  };
}

/**
 * The cell's metrics transport — the run_metrics_query parallel to the
 * search client. Builds the request via the framework's
 * `metricsQueryPath` so the wire contract stays identical to the
 * browser path, and returns the raw NDJSON body the metrics parser
 * expects.
 */
export function createCellMetricsTransport(cfg: CellCriblConfig): MetricsTransport {
  return async (query, opts) => {
    const resp = await cellCriblFetch(cfg, 'GET', metricsQueryPath(query, opts), {
      signal: opts.signal,
    });
    if (!resp.ok) {
      throw new Error(`metrics query failed (${resp.status}): ${resp.text.slice(0, 400)}`);
    }
    return resp.text;
  };
}
