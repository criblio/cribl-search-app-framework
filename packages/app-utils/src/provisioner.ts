/**
 * Generic scheduled-search provisioner for Cribl Search Apps.
 *
 * Reconciles a workspace's set of `<prefix>*` saved searches with a
 * declarative plan supplied by the consuming app. Used by:
 *
 *  - `npm run provision` scripts at dev time (manual runs by humans
 *    against a staging deployment, via createNodeHttpClient).
 *  - In-app "Re-provision" flows at runtime (via createBrowserHttpClient).
 *
 * Safety model: every operation is scoped to rows whose `id` starts
 * with the configured prefix. Everything else is invisible. A
 * reconciliation run can create, update, or delete prefixed rows;
 * it will never touch a row a user created by hand.
 *
 * The Cribl Search saved-search REST surface this module uses:
 *
 *   GET    /m/default_search/search/saved          (list)
 *   POST   /m/default_search/search/saved          (create)
 *   PATCH  /m/default_search/search/saved/:id      (update)
 *   DELETE /m/default_search/search/saved/:id      (delete)
 *
 * The browser client relies on the platform fetch proxy for auth.
 * The node client uses an explicit Bearer token from OAuth client
 * credentials (see `getBearerToken`).
 */
import { getBearerToken, type OAuthConfig } from './auth.js';

/** The subset of the Cribl saved-search object that the provisioner
 * cares about. The server fills in the rest (`user`, etc.). */
export interface ProvisionedSearch {
  id: string;
  name: string;
  description: string;
  query: string;
  earliest: string;
  latest: string;
  sampleRate?: number;
  schedule: {
    enabled: boolean;
    cronSchedule: string;
    tz: string;
    keepLastN: number;
  };
}

/** A lookup table that must exist before scheduled searches
 * referencing it can be created. The provisioner seeds these
 * before reconciling the plan, since Cribl validates lookup
 * names at search creation time. */
export interface SeedLookup {
  name: string;
  seedQuery: string;
}

/** Per-app configuration passed to reconcile / planOnly. */
export interface ProvisionerConfig {
  /** Stable prefix for every app-managed saved search ID
   * (e.g. `criblapm__`, `criblca__`). The provisioner only ever
   * touches rows whose id begins with this string. */
  prefix: string;
  /** The desired set of saved searches. Either a static array or
   * a function called at reconcile time (useful when the plan
   * depends on settings read at invocation). */
  plan: ProvisionedSearch[] | (() => ProvisionedSearch[]);
  /** Optional lookup tables to seed before reconciling. */
  seedLookups?: SeedLookup[];
}

/** Minimal shape of a saved-search row as returned by the list
 * endpoint. We don't need the full schema here — just enough
 * to identify app-managed rows and diff against the plan. */
export interface SavedSearchRow {
  id: string;
  name?: string;
  description?: string;
  query?: string;
  earliest?: string | number;
  latest?: string | number;
  sampleRate?: number;
  schedule?: unknown;
}

interface SavedSearchListResponse {
  items?: SavedSearchRow[];
  count?: number;
}

/** Plan entry classified by what the reconciler needs to do. */
export type PlanAction =
  | { kind: 'create'; want: ProvisionedSearch }
  | { kind: 'update'; want: ProvisionedSearch; current: SavedSearchRow }
  | { kind: 'delete'; current: SavedSearchRow }
  | { kind: 'noop'; want: ProvisionedSearch; current: SavedSearchRow };

export interface ActionResult {
  action: PlanAction;
  ok: boolean;
  error?: string;
}

/** Abstract HTTP client so the same module can run inside the
 * browser (via `fetch`) and from a node-side driver (via a
 * fetch shim that injects a Bearer token). Both paths must
 * target the same endpoints and return parsed JSON. */
export interface HttpClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  patch(path: string, body: unknown): Promise<unknown>;
  del(path: string): Promise<unknown>;
}

/** Path builder — every saved-search URL is under this prefix. */
export function savedSearchesPath(id?: string): string {
  const base = '/m/default_search/search/saved';
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

/** Fetch every `<prefix>*` saved search currently on the server.
 * Pagination handles large workspaces; the hard cap on iterations
 * protects against a buggy server that would otherwise spin forever. */
export async function listProvisioned(
  http: HttpClient,
  prefix: string,
): Promise<SavedSearchRow[]> {
  const out: SavedSearchRow[] = [];
  const pageSize = 200;
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const resp = (await http.get(
      `${savedSearchesPath()}?limit=${pageSize}&offset=${offset}`,
    )) as SavedSearchListResponse;
    const items = resp?.items ?? [];
    for (const row of items) {
      if (typeof row?.id === 'string' && row.id.startsWith(prefix)) {
        out.push(row);
      }
    }
    if (items.length < pageSize) break;
    offset += items.length;
  }
  return out;
}

/** Compare the expected plan against the current server state
 * and classify every row into one of four actions. */
export function diffProvisioned(
  plan: ProvisionedSearch[],
  current: SavedSearchRow[],
): PlanAction[] {
  const byId = new Map<string, SavedSearchRow>();
  for (const row of current) byId.set(row.id, row);

  const actions: PlanAction[] = [];
  const planIds = new Set<string>();

  for (const want of plan) {
    planIds.add(want.id);
    const cur = byId.get(want.id);
    if (!cur) {
      actions.push({ kind: 'create', want });
      continue;
    }
    if (isSameAsPlan(want, cur)) {
      actions.push({ kind: 'noop', want, current: cur });
    } else {
      actions.push({ kind: 'update', want, current: cur });
    }
  }

  for (const row of current) {
    if (!planIds.has(row.id)) {
      actions.push({ kind: 'delete', current: row });
    }
  }

  return actions;
}

function isSameAsPlan(want: ProvisionedSearch, cur: SavedSearchRow): boolean {
  if (want.name !== cur.name) return false;
  if (want.description !== cur.description) return false;
  if (want.query !== cur.query) return false;
  if (String(want.earliest) !== String(cur.earliest)) return false;
  if (String(want.latest) !== String(cur.latest)) return false;
  if ((want.sampleRate ?? 1) !== (cur.sampleRate ?? 1)) return false;
  const serverSchedule =
    cur.schedule && typeof cur.schedule === 'object'
      ? (cur.schedule as Record<string, unknown>)
      : {};
  const wantSchedule: Record<string, unknown> = {
    enabled: want.schedule.enabled,
    cronSchedule: want.schedule.cronSchedule,
    tz: want.schedule.tz,
    keepLastN: want.schedule.keepLastN,
  };
  for (const key of Object.keys(wantSchedule)) {
    if (wantSchedule[key] !== serverSchedule[key]) return false;
  }
  return true;
}

export async function applyProvisioningPlan(
  http: HttpClient,
  actions: PlanAction[],
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const action of actions) {
    try {
      await executeAction(http, action);
      results.push({ action, ok: true });
    } catch (err) {
      results.push({
        action,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

async function executeAction(http: HttpClient, action: PlanAction): Promise<void> {
  switch (action.kind) {
    case 'create': {
      await http.post(savedSearchesPath(), planToBody(action.want));
      return;
    }
    case 'update': {
      await http.patch(savedSearchesPath(action.want.id), planToBody(action.want));
      return;
    }
    case 'delete': {
      await http.del(savedSearchesPath(action.current.id));
      return;
    }
    case 'noop':
      return;
  }
}

function planToBody(want: ProvisionedSearch): Record<string, unknown> {
  return {
    id: want.id,
    name: want.name,
    description: want.description,
    query: want.query,
    earliest: want.earliest,
    latest: want.latest,
    sampleRate: want.sampleRate ?? 1,
    schedule: {
      enabled: want.schedule.enabled,
      cronSchedule: want.schedule.cronSchedule,
      tz: want.schedule.tz,
      keepLastN: want.schedule.keepLastN,
    },
  };
}

/** Shape of POST /search/jobs. Cribl returns the created job wrapped
 * in an `items` array, NOT as a bare object with a top-level `id`.
 * Reading `.id` off the response yields undefined — see the note in
 * runSearchJobSync. */
interface JobCreateResponse {
  items?: Array<{ id?: string }>;
  id?: string;
}

function extractJobId(created: unknown): string {
  const r = created as JobCreateResponse | null;
  // `items[0].id` is what Cribl actually returns; the bare `id`
  // fallback keeps this working if that ever changes back.
  return r?.items?.[0]?.id ?? r?.id ?? '';
}

/** Run a search job synchronously: POST creates it, then we poll
 * /jobs/<id> until it reaches a terminal state. Returns the final
 * status string ("completed" / "failed" / "canceled") or "unknown" on
 * rejection / timeout / network error.
 *
 * Cribl Search jobs are async — the POST returns immediately with a
 * job id, but the job runs in the background. */
async function runSearchJobSync(
  http: HttpClient,
  query: string,
  earliest = '-5m',
  latest = 'now',
  timeoutMs = 15_000,
): Promise<string> {
  let jobId: string;
  try {
    const created = await http.post('/m/default_search/search/jobs', {
      query,
      earliest,
      latest,
    });
    jobId = extractJobId(created);
  } catch {
    return 'unknown';
  }
  if (!jobId) return 'unknown';

  const start = Date.now();
  // Cribl returns very fast for these tiny probe queries; 250ms
  // intervals are short enough to feel synchronous.
  while (Date.now() - start < timeoutMs) {
    try {
      const status = (await http.get(
        `/m/default_search/search/jobs/${encodeURIComponent(jobId)}`,
      )) as { status?: string };
      const s = status?.status ?? '';
      if (s === 'completed' || s === 'failed' || s === 'canceled') {
        return s;
      }
    } catch {
      // Transient — keep polling.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'unknown';
}

/** Probe-and-seed lookup creation. Cribl validates lookup names when
 * it plans a query, so any lookup the plan references must exist
 * before the searches that join it can be created.
 *
 * A seed query is `print … | export mode=overwrite to lookup <name>`
 * — it writes exactly one sentinel row. Seeding a lookup that already
 * holds real data therefore DESTROYS that data: 24h of op baselines,
 * the alert state machine's consecutive_bad / fire_count counters,
 * the attribute catalog. So the probe is not an optimization; it is
 * the only thing standing between a re-provision and data loss, and
 * it has to fail safe.
 *
 * The probe leans on the fact that Cribl resolves lookup names when it
 * PLANS a query, before it runs one: a job naming a missing lookup is
 * refused at create time with an HTTP 400 whose body says "Unknown
 * lookup table name". So existence is decidable from the create call
 * alone — `lookupExists` below — and only a lookup Cribl explicitly
 * calls unknown is ever seeded.
 *
 * That "explicitly" is load-bearing, because the two ways to be wrong
 * are not symmetric. Wrongly deciding "missing" silently overwrites
 * live data. Wrongly deciding "exists" merely fails the subsequent
 * search create with a legible "Unknown lookup table name" the user
 * can act on. So anything short of a definitive missing answer — a
 * network blip, a timeout, a 500 — leaves the lookup alone.
 *
 * (The previous probe was `dataset="otel" | … | limit 0`, which is
 * invalid KQL — Cribl rejects `limit 0` with "Limit value outside of
 * supported range" — so it 400d whether or not the lookup existed.
 * Paired with a `runSearchJobSync` that read the job id from the wrong
 * field and so never polled, it meant every reconcile re-seeded every
 * lookup, overwriting each one with its sentinel row. It also
 * hardcoded one app's dataset name; `print` needs no dataset at all.)
 *
 * Exported because `reconcile()` is not the only apply path: the
 * in-app ProvisioningPanel previews with `planOnly()` and applies
 * with `applyProvisioningPlan()`, and must seed in between. */
export async function seedLookups(http: HttpClient, lookups: SeedLookup[]): Promise<void> {
  for (const lookup of lookups) {
    if ((await lookupExists(http, lookup.name)) !== 'no') continue;
    // Definitively missing. Seed it, and wait for the export to land so
    // the searches created next can resolve the lookup.
    await runSearchJobSync(http, lookup.seedQuery);
  }
}

/** Does `name` resolve as a lookup? "unknown" means we couldn't get a
 * definitive answer and the caller must not act destructively. */
async function lookupExists(
  http: HttpClient,
  name: string,
): Promise<'yes' | 'no' | 'unknown'> {
  try {
    await http.post('/m/default_search/search/jobs', {
      query: `print x=1 | lookup ${name} on x`,
      earliest: '-5m',
      latest: 'now',
    });
    // Cribl planned the query, so the lookup resolved.
    return 'yes';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Both HTTP clients put the response body in the error message.
    return /unknown lookup table name/i.test(msg) ? 'no' : 'unknown';
  }
}

function resolvePlan(plan: ProvisionerConfig['plan']): ProvisionedSearch[] {
  return typeof plan === 'function' ? plan() : plan;
}

/** Top-level orchestrator: seed lookups, load the plan, list
 * current rows, diff, apply. Returns a structured summary the
 * caller can render however it likes. */
export async function reconcile(
  http: HttpClient,
  config: ProvisionerConfig,
): Promise<{
  plan: ProvisionedSearch[];
  current: SavedSearchRow[];
  actions: PlanAction[];
  results: ActionResult[];
}> {
  if (config.seedLookups?.length) {
    await seedLookups(http, config.seedLookups);
  }
  const plan = resolvePlan(config.plan);
  const current = await listProvisioned(http, config.prefix);
  const actions = diffProvisioned(plan, current);
  const results = await applyProvisioningPlan(http, actions);
  return { plan, current, actions, results };
}

/** Dry-run helper: return the actions without applying them. */
export async function planOnly(
  http: HttpClient,
  config: ProvisionerConfig,
): Promise<{
  plan: ProvisionedSearch[];
  current: SavedSearchRow[];
  actions: PlanAction[];
}> {
  const plan = resolvePlan(config.plan);
  const current = await listProvisioned(http, config.prefix);
  const actions = diffProvisioned(plan, current);
  return { plan, current, actions };
}

/** Dangerous: delete every `<prefix>*` saved search on the server,
 * no questions asked. Kept separate from `reconcile()` so it can't
 * be confused for an innocent "update". */
export async function unprovisionAll(
  http: HttpClient,
  prefix: string,
): Promise<ActionResult[]> {
  const current = await listProvisioned(http, prefix);
  const actions: PlanAction[] = current.map((row) => ({
    kind: 'delete' as const,
    current: row,
  }));
  return applyProvisioningPlan(http, actions);
}

/** Factory for the in-app HTTP client: wraps the browser's
 * `fetch` against the platform-injected CRIBL_API_URL. The
 * platform fetch proxy handles auth automatically. */
export function createBrowserHttpClient(): HttpClient {
  const w = window as unknown as { CRIBL_API_URL?: string };
  const base = (w.CRIBL_API_URL ?? '/api/v1').replace(/\/$/, '');
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const resp = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`${method} ${path} failed (${resp.status}): ${text.slice(0, 400)}`);
    }
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('json')) return resp.json();
    return resp.text();
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
  };
}

/** Factory for the node-side HTTP client used by `npm run provision`
 * and other deploy-time scripts. Performs the OAuth client-credentials
 * exchange via `getBearerToken` and returns a client that hits the
 * `/api/v1` surface of the configured Cribl Cloud workspace. */
export async function createNodeHttpClient(config: OAuthConfig): Promise<HttpClient> {
  const token = await getBearerToken(config);
  const apiBase = config.baseUrl.replace(/\/$/, '') + '/api/v1';
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const resp = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`${method} ${path} failed (${resp.status}): ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    del: (path) => request('DELETE', path),
  };
}
