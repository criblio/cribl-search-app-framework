/**
 * The metrics CATALOG: what metrics exist, what they mean, and which
 * label sets they carry — as opposed to `metrics.ts`, which evaluates
 * PromQL against them.
 *
 * ## Why this exists
 *
 * `metrics.ts` has always done discovery through a dot-command grammar
 * (`.labels`, `.metadata`, `.series <metric>`) sent over the same
 * NDJSON query endpoint as PromQL. That grammar is what the built-in
 * Metrics app uses, and on some workspaces it works. On others it
 * returns a completed job with **zero rows** — no error, no hint, just
 * an empty result that reads exactly like "this workspace has no
 * metrics". Verified live on a staging workspace holding 1,182 metrics
 * and 35,287 active series: every dot-command came back empty while
 * `up`, `node_load1` and `count(up)` all returned real samples.
 *
 * The engine exposes a separate, first-class catalog API which answers
 * the same questions and more. This module wraps it. Discovery prefers
 * it and falls back to the dot-commands, so a workspace where only one
 * of the two works still gets answers.
 *
 * ## The shape of the API, which is not guessable from the spec
 *
 * Two path facts, both established against a live workspace:
 *
 *   - The engine id is not a constant. It comes from
 *     `GET /m/default_search/search/local_search/engines`, which needs
 *     the `/m/<group>` context — and returns each engine's own
 *     `metricsDatasetId`.
 *   - Everything under `/products/lakehouse_engine_metrics/…` takes NO
 *     group context, the exact reverse of `/search/*`. A bare
 *     `/search/local_search/engines` 404s and
 *     `/m/default_search/products/…` 404s.
 *
 * Every operation here is `x-cribl-internal: true` and marked
 * "Cribl.Cloud only" in the spec, which is why callers must tolerate a
 * 404 rather than treat it as a bug.
 *
 * ## Why the summary is projected rather than returned
 *
 * `GET …/metrics/summary` is **1,073 KB** on that staging workspace —
 * 1,182 rows of 31 fields each, including per-metric hour/day/week
 * trend comparisons and asset-dependency counts. It accepts no `limit`
 * or `offset` (measured: passing them changes nothing). So this module
 * fetches it whole and projects it down to the handful of fields that
 * answer "which metrics matter here", because the caller is a model
 * whose context this lands in for the rest of the session.
 */

/**
 * One authenticated GET against the workspace API, relative to an
 * `/api/v1` base. Injected for the same reason `MetricsTransport` is: a
 * browser rides the iframe fetch proxy, a cell has to add its own auth.
 * Must NOT throw on a non-2xx — a 404 here is expected information
 * (these endpoints are Cribl.Cloud-only), not an exception.
 */
export type CatalogTransport = (
  path: string,
  signal?: AbortSignal,
) => Promise<{ status: number; ok: boolean; text: string }>;

/** A Local Search engine, as `/search/local_search/engines` reports it. */
export interface LocalSearchEngine {
  id: string;
  /** The dataset id the engine keeps its metrics in. */
  metricsDatasetId?: string;
  /** Every dataset the engine serves, metrics or not. */
  datasets?: string[];
  status?: string;
  [key: string]: unknown;
}

/** Metric name + type/help/unit, from `prom/api/v1/metadata`. */
export interface CatalogMetadata {
  name: string;
  type: string;
  help: string;
  unit: string;
}

/** One metric's projected summary row. */
export interface CatalogMetricRow {
  name: string;
  type: string;
  unit: string;
  /** Series currently reporting. The cardinality that matters. */
  activeSeries: number;
  samplesPerMinute: number;
  /** `active` / `unused` — whether anything has queried it lately. */
  usage: string;
  queries30d: number;
}

/** Catalog-wide totals, from `metrics/summary`'s `totals`. */
export interface CatalogTotals {
  metrics: number;
  activeMetrics: number;
  series: number;
  samplesPerMinute: number;
  [key: string]: number;
}

/** One label dimension of a single metric, from `metrics/{name}/labels`. */
export interface CatalogMetricLabel {
  key: string;
  /** Distinct values seen for this label on this metric. */
  distinct: number;
  /** Fraction of the metric's cardinality this label accounts for. */
  share: number;
}

/** The catalog reads a discovery client needs. Every method rejects if
 *  the catalog is unreachable — callers fall back rather than fail. */
export interface MetricsCatalog {
  /** Resolve (and cache) the engine + dataset the other calls address. */
  engine(signal?: AbortSignal): Promise<{ engineId: string; datasetId: string }>;
  metadata(prefix?: string, signal?: AbortSignal): Promise<CatalogMetadata[]>;
  labels(signal?: AbortSignal): Promise<string[]>;
  labelValues(label: string, signal?: AbortSignal): Promise<string[]>;
  /** Label sets matching a PromQL selector (a bare metric name is one). */
  series(match: string, signal?: AbortSignal): Promise<Array<Record<string, string>>>;
  /** The projected catalog: totals plus the top `limit` metrics. */
  summary(
    opts?: { filter?: string; limit?: number; signal?: AbortSignal },
  ): Promise<{ totals: CatalogTotals; rows: CatalogMetricRow[]; matched: number }>;
  /** One metric's label dimensions, ordered by share. */
  metricLabels(metric: string, signal?: AbortSignal): Promise<CatalogMetricLabel[]>;
}

export interface MetricsCatalogConfig {
  transport: CatalogTransport;
  /** Group context for the engines lookup. Default `default_search`. */
  group?: string;
  /** Pin the engine instead of taking the first ready one. */
  engineId?: string;
  /** Preferred metrics dataset. Used only if the engine lists it;
   *  otherwise the engine's own `metricsDatasetId` wins, because that is
   *  the field that actually names its metrics store. */
  dataset?: string;
  /** Default cap on projected summary rows. */
  summaryLimit?: number;
}

const DEFAULT_SUMMARY_LIMIT = 40;

/** Product prefix for the metrics engine API. NO group context — see
 *  the module doc; this is the reverse of `/search/*`. */
const PRODUCT = '/products/lakehouse_engine_metrics';

async function getJson(
  cfg: MetricsCatalogConfig,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const resp = await cfg.transport(path, signal);
  if (!resp.ok) {
    throw new Error(`metrics catalog GET ${path} → ${resp.status}: ${resp.text.slice(0, 200)}`);
  }
  // A 2xx carrying HTML is this API's characteristic near-miss (the
  // request fell through to the web app), and it would otherwise
  // surface as an opaque JSON parse error.
  if (/^\s*<(?:!doctype|html)\b/i.test(resp.text)) {
    throw new Error(
      `metrics catalog GET ${path} returned HTML with a ${resp.status} — the path did not reach the API router.`,
    );
  }
  try {
    return JSON.parse(resp.text);
  } catch {
    throw new Error(`metrics catalog GET ${path} returned a non-JSON body (${resp.text.length} bytes)`);
  }
}

/** Unwrap a Prometheus-style `{status, data}` envelope. */
function promData(body: unknown, path: string): unknown {
  const env = body as { status?: string; data?: unknown; error?: string };
  if (env?.status && env.status !== 'success') {
    throw new Error(`metrics catalog ${path}: ${env.error ?? env.status}`);
  }
  return env?.data;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build a catalog client. Resolving the engine costs a request, so it
 * happens on first use and is cached on the client — not at module
 * scope, which a workerd isolate forbids, and not per call, which would
 * double every discovery round trip.
 */
export function createMetricsCatalog(cfg: MetricsCatalogConfig): MetricsCatalog {
  let resolved: Promise<{ engineId: string; datasetId: string }> | undefined;

  const engine = (signal?: AbortSignal) => {
    // A failed resolution is not cached: the usual cause is a token that
    // wasn't ready yet, and a permanently poisoned client would make the
    // rest of the session undiscoverable.
    resolved ??= resolveEngine(cfg, signal).catch((err: unknown) => {
      resolved = undefined;
      throw err;
    });
    return resolved;
  };

  /** `/products/…/engines/{id}/datasets/{id}` for the resolved engine. */
  const root = async (signal?: AbortSignal): Promise<string> => {
    const { engineId, datasetId } = await engine(signal);
    return `${PRODUCT}/engines/${encodeURIComponent(engineId)}/datasets/${encodeURIComponent(datasetId)}`;
  };

  return {
    engine,

    async metadata(prefix, signal) {
      const base = await root(signal);
      const data = promData(await getJson(cfg, `${base}/prom/api/v1/metadata`, signal), 'metadata');
      const out: CatalogMetadata[] = [];
      for (const [name, entries] of Object.entries((data ?? {}) as Record<string, unknown>)) {
        if (prefix && !name.includes(prefix)) continue;
        // The value is an array of metadata records (one per source that
        // reported the metric); the first is representative.
        const first = (Array.isArray(entries) ? entries[0] : entries) as
          | { type?: string; help?: string; unit?: string }
          | undefined;
        out.push({
          name,
          type: String(first?.type ?? ''),
          help: String(first?.help ?? ''),
          unit: String(first?.unit ?? ''),
        });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    },

    async labels(signal) {
      const base = await root(signal);
      const data = promData(await getJson(cfg, `${base}/prom/api/v1/labels`, signal), 'labels');
      return Array.isArray(data) ? data.map(String) : [];
    },

    async labelValues(label, signal) {
      const base = await root(signal);
      const path = `${base}/prom/api/v1/label/${encodeURIComponent(label)}/values`;
      const data = promData(await getJson(cfg, path, signal), 'label values');
      return Array.isArray(data) ? data.map(String) : [];
    },

    async series(match, signal) {
      const base = await root(signal);
      const path = `${base}/prom/api/v1/series?match%5B%5D=${encodeURIComponent(match)}`;
      const data = promData(await getJson(cfg, path, signal), 'series');
      if (!Array.isArray(data)) return [];
      return data.map((row) => {
        const labels: Record<string, string> = {};
        for (const [k, v] of Object.entries(row as Record<string, unknown>)) labels[k] = String(v);
        return labels;
      });
    },

    async summary(opts = {}) {
      const base = await root(opts.signal);
      const body = (await getJson(cfg, `${base}/metrics/summary`, opts.signal)) as {
        totals?: Record<string, unknown>;
        rows?: Array<Record<string, unknown>>;
      };
      const t = body.totals ?? {};
      const totals: CatalogTotals = {
        metrics: num(t.totalMetrics ?? t.metrics),
        activeMetrics: num(t.activeMetrics ?? t.metrics),
        series: num(t.activeSeries ?? t.series),
        samplesPerMinute: num(t.dpm),
      };
      const filter = opts.filter?.trim().toLowerCase();
      const all = (body.rows ?? []).filter(
        (r) => !filter || String(r.name ?? '').toLowerCase().includes(filter),
      );
      // Busiest first: with a thousand metrics the ones carrying the
      // cardinality are the ones worth a model's attention.
      all.sort((a, b) => num(b.activeSeriesCount) - num(a.activeSeriesCount));
      const limit = Math.max(1, opts.limit ?? cfg.summaryLimit ?? DEFAULT_SUMMARY_LIMIT);
      return {
        totals,
        matched: all.length,
        rows: all.slice(0, limit).map((r) => ({
          name: String(r.name ?? ''),
          type: String(r.type ?? ''),
          unit: String(r.unit ?? ''),
          activeSeries: num(r.activeSeriesCount ?? r.seriesCount),
          samplesPerMinute: num(r.samplesPerMinute),
          usage: String(r.usage ?? ''),
          queries30d: num(r.queries30d),
        })),
      };
    },

    async metricLabels(metric, signal) {
      const base = await root(signal);
      const path = `${base}/metrics/${encodeURIComponent(metric)}/labels`;
      const body = (await getJson(cfg, path, signal)) as {
        labels?: Array<Record<string, unknown>>;
      };
      return (body.labels ?? [])
        .map((l) => ({
          key: String(l.key ?? ''),
          distinct: num(l.distinct),
          share: num(l.share),
        }))
        .sort((a, b) => b.share - a.share);
    },
  };
}

/**
 * Find the engine to address, and the dataset within it.
 *
 * The engines list is the only part of this API that needs the group
 * context, and it is the only place the engine id and its metrics
 * dataset id can be learned.
 */
async function resolveEngine(
  cfg: MetricsCatalogConfig,
  signal?: AbortSignal,
): Promise<{ engineId: string; datasetId: string }> {
  const group = cfg.group ?? 'default_search';
  const body = (await getJson(cfg, `/m/${group}/search/local_search/engines`, signal)) as {
    items?: LocalSearchEngine[];
  };
  const engines = body.items ?? [];
  if (engines.length === 0) {
    throw new Error(
      'no Local Search engine in this workspace, so there is no metrics catalog to read.',
    );
  }
  const engine = cfg.engineId
    ? engines.find((e) => e.id === cfg.engineId)
    : (engines.find((e) => e.status === 'ready') ?? engines[0]);
  if (!engine) {
    throw new Error(
      `no Local Search engine with id ${JSON.stringify(cfg.engineId)} (have: ${engines
        .map((e) => e.id)
        .join(', ')})`,
    );
  }
  // The requested dataset only wins if the engine actually serves it —
  // otherwise every call below would 404 on a plausible-looking name.
  const datasetId =
    cfg.dataset && engine.datasets?.includes(cfg.dataset)
      ? cfg.dataset
      : (engine.metricsDatasetId ?? cfg.dataset);
  if (!datasetId) {
    throw new Error(`engine ${engine.id} reports no metrics dataset.`);
  }
  return { engineId: engine.id, datasetId };
}
