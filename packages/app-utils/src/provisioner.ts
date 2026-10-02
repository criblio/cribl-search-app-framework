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
import { getCachedBearerToken, type CachedBearerTokenOptions, type OAuthConfig } from './auth.js';
import { metricsQueryPath, type MetricsTransport } from './metrics.js';
import {
  ProvisionPlanError,
  validateProvisionPlan,
  type ProvisionProblem,
  type ProvisionRule,
  type ProvisionValidation,
} from './provision-guard.js';
import {
  ensureNotificationTarget,
  ensureSavedSearchNotification,
  removeNotificationsForSearch,
  type NotificationTarget,
  type SavedSearchNotification,
} from './notifications.js';

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
    /**
     * Sent as the saved search's `schedule.notifications`, but **the
     * server does not store it**: an inline notification is dropped and
     * the saved search reads back with `notifications: {}`. A notification
     * that actually fires is a separate `/notifications` resource bound
     * to the saved search by id — declare it in
     * `ProvisionerConfig.notifications` (or call
     * `ensureSavedSearchNotification` from `/notifications`).
     *
     * Kept so existing plans still type-check, and excluded from drift
     * detection: compared against the `{}` the server returns it never
     * matched, so every reconcile reported an update and re-patched the
     * search forever. Omit it.
     */
    notifications?: unknown;
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
  /**
   * The built-in plan guard (`validateProvisionPlan`) runs by default
   * before anything is written, on every apply path. `false` turns it off
   * entirely; `{ disableRules }` skips individual rules — prefer that, so
   * one false positive does not cost the rest of the guard.
   */
  guard?: false | { disableRules?: ProvisionRule[] };
  /** App-specific plan rules, run IN ADDITION to the built-in guard (a
   * custom rule never silently replaces the dataset/lookup checks). Any
   * problem refuses the plan exactly like a built-in one. */
  validate?: ProvisionPlanValidator;
  /**
   * Saved-search → notification-target bindings to keep in place. When
   * set (even to `[]`), the apply path also ensures each binding after its
   * search is written, and removes every binding of a search it deletes
   * before deleting it. A target must exist before its binding is
   * written: declare it in `notificationTargets` (ensured first, on the
   * same apply), or create it yourself beforehand.
   */
  notifications?: SavedSearchNotification[] | (() => SavedSearchNotification[]);
  /**
   * Notification targets to create or update (`ensureNotificationTarget`)
   * on the apply path, AFTER the searches are written and BEFORE any
   * binding in `notifications`. A binding whose target failed to ensure is
   * skipped and reported rather than written against a missing target.
   *
   * A function is called at apply time and may be async — for a target
   * whose body depends on something read then (a webhook URL from
   * settings). This is the supported replacement for creating a target in
   * `<ProvisioningPanel afterReconcile>`: that hook runs after the
   * bindings, so a binding to a target it creates never had one.
   * If the function throws, no target is ensured and every binding is
   * skipped; that is reported as one failed target with id `*`.
   */
  notificationTargets?: NotificationTarget[] | (() => NotificationTarget[] | Promise<NotificationTarget[]>);
}

/** Extra plan rules for `ProvisionerConfig.validate`. */
export type ProvisionPlanValidator = (
  plan: ProvisionedSearch[],
  context: { prefix: string; seedLookups: SeedLookup[] },
) => ProvisionProblem[] | ProvisionValidation;

/** Outcome of ensuring one `ProvisionerConfig.notificationTargets` entry. */
export interface NotificationTargetResult {
  targetId: string;
  ok: boolean;
  /** `created` / `updated`. */
  detail?: string;
  error?: string;
}

/** Outcome of one notification step on the apply path. */
export interface NotificationResult {
  searchId: string;
  step: 'ensure' | 'remove';
  ok: boolean;
  /** `created` / `updated` for ensure; the deleted ids for remove. */
  detail?: string;
  error?: string;
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
  // `schedule.notifications` is deliberately not compared. The server
  // drops inline notifications and reads back `{}`, so a plan that sets
  // them never matched and every reconcile re-patched the search forever.
  // See `ProvisionedSearch.schedule.notifications`.
  return true;
}

/**
 * Execute an action list as-is. Low-level: it does not seed lookups or
 * touch notifications (use `applyProvisioningActions` for that), but it
 * DOES run the built-in guard over the searches it would write, unless
 * `opts.guard` is `false` — so even a hand-rolled apply path cannot skip
 * it by default. Throws `ProvisionPlanError` before any write.
 */
export async function applyProvisioningPlan(
  http: HttpClient,
  actions: PlanAction[],
  opts: { guard?: false | { disableRules?: ProvisionRule[] } } = {},
): Promise<ActionResult[]> {
  if (opts.guard !== false) {
    const { ok, problems } = validateProvisionPlan(plannedSearches(actions), {
      disableRules: opts.guard?.disableRules,
    });
    if (!ok) throw new ProvisionPlanError(problems);
  }
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
      ...(want.schedule.notifications !== undefined
        ? { notifications: want.schedule.notifications }
        : {}),
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
 * `applyProvisioningActions()` (and so `reconcile()` and the
 * ProvisioningPanel) calls this; exported for apps that drive the
 * low-level `applyProvisioningPlan()` themselves. */
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

/**
 * Run the built-in guard (unless `config.guard === false`) plus
 * `config.validate` over a plan and its seed lookups. Pure; never throws
 * for a bad plan — `reconcile`, `planOnly` and `applyProvisioningActions`
 * do that with a `ProvisionPlanError`.
 */
export function validateProvisionerPlan(
  config: ProvisionerConfig,
  plan: ProvisionedSearch[] = resolvePlan(config.plan),
): ProvisionValidation {
  const seedLookups = config.seedLookups ?? [];
  const problems: ProvisionProblem[] = [];
  if (config.guard !== false) {
    problems.push(
      ...validateProvisionPlan(plan, {
        prefix: config.prefix,
        seedLookups,
        disableRules: config.guard?.disableRules,
      }).problems,
    );
  }
  if (config.validate) {
    const extra = config.validate(plan, { prefix: config.prefix, seedLookups });
    problems.push(...(Array.isArray(extra) ? extra : extra.problems));
  }
  return { ok: problems.length === 0, problems };
}

function assertValidPlan(config: ProvisionerConfig, plan: ProvisionedSearch[]): void {
  const { ok, problems } = validateProvisionerPlan(config, plan);
  if (!ok) throw new ProvisionPlanError(problems);
}

/** The plan entries an action list was computed from (every non-delete). */
function plannedSearches(actions: PlanAction[]): ProvisionedSearch[] {
  return actions.flatMap((a) => (a.kind === 'delete' ? [] : [a.want]));
}

/**
 * Apply a previewed action list the way `reconcile()` does: validate,
 * seed lookups, remove notifications of searches being deleted, write the
 * searches, ensure notification targets, then ensure notification bindings. The single apply path for
 * a CLI and `<ProvisioningPanel>`, so the two cannot diverge — the
 * reference app's UI Apply ran no guard while its CLI did.
 *
 * Throws `ProvisionPlanError` (before any write) when the plan fails
 * validation. Per-search and per-binding failures are reported in the
 * result, never thrown.
 */
export async function applyProvisioningActions(
  http: HttpClient,
  config: ProvisionerConfig,
  actions: PlanAction[],
): Promise<{ results: ActionResult[]; notifications: NotificationResult[]; targets: NotificationTargetResult[] }> {
  assertValidPlan(config, plannedSearches(actions));
  if (config.seedLookups?.length) {
    await seedLookups(http, config.seedLookups);
  }
  const bindings = config.notifications === undefined ? undefined : resolveBindings(config.notifications);
  const notifications: NotificationResult[] = [];
  if (bindings) {
    // Unbind before deleting, so a failure can never leave a binding
    // pointing at a search that no longer exists.
    for (const action of actions) {
      if (action.kind !== 'delete') continue;
      const searchId = action.current.id;
      try {
        const removed = await removeNotificationsForSearch(http, searchId);
        notifications.push({ searchId, step: 'remove', ok: true, detail: removed.join(', ') || 'none' });
      } catch (err) {
        notifications.push({ searchId, step: 'remove', ok: false, error: errorMessage(err) });
      }
    }
  }
  const results = await applyProvisioningPlan(http, actions, { guard: false });
  // Targets before bindings: a binding names its target by id, and one
  // written before the target exists can never fire.
  const targets = config.notificationTargets === undefined ? [] : await ensureTargets(http, config.notificationTargets);
  const failedTargets = new Map(targets.filter((t) => !t.ok).map((t) => [t.targetId, t.error ?? 'failed']));
  if (bindings) {
    const written = new Set(
      results.filter((r) => r.ok && r.action.kind !== 'delete').map((r) => (r.action as { want: ProvisionedSearch }).want.id),
    );
    const planned = new Set(plannedSearches(actions).map((p) => p.id));
    for (const binding of bindings) {
      const { searchId } = binding;
      if (!written.has(searchId)) {
        notifications.push({
          searchId,
          step: 'ensure',
          ok: false,
          error: planned.has(searchId)
            ? 'skipped: the saved search failed to write'
            : 'skipped: no saved search with this id in the plan',
        });
        continue;
      }
      const missing = (Array.isArray(binding.targetId) ? binding.targetId : [binding.targetId]).find(
        (id) => failedTargets.has(id) || failedTargets.has('*'),
      );
      if (missing !== undefined) {
        const why = failedTargets.get(missing) ?? failedTargets.get('*');
        notifications.push({
          searchId,
          step: 'ensure',
          ok: false,
          error: `skipped: notification target ${missing} could not be ensured (${why})`,
        });
        continue;
      }
      try {
        const outcome = await ensureSavedSearchNotification(http, binding);
        notifications.push({ searchId, step: 'ensure', ok: true, detail: outcome });
      } catch (err) {
        notifications.push({ searchId, step: 'ensure', ok: false, error: errorMessage(err) });
      }
    }
  }
  return { results, notifications, targets };
}

async function ensureTargets(
  http: HttpClient,
  declared: NonNullable<ProvisionerConfig['notificationTargets']>,
): Promise<NotificationTargetResult[]> {
  let list: NotificationTarget[];
  try {
    list = typeof declared === 'function' ? await declared() : declared;
  } catch (err) {
    return [{ targetId: '*', ok: false, error: `notificationTargets: ${errorMessage(err)}` }];
  }
  const out: NotificationTargetResult[] = [];
  for (const target of list) {
    const targetId = typeof target?.id === 'string' && target.id ? target.id : '(missing id)';
    try {
      out.push({ targetId, ok: true, detail: await ensureNotificationTarget(http, target) });
    } catch (err) {
      out.push({ targetId, ok: false, error: errorMessage(err) });
    }
  }
  return out;
}

function resolveBindings(
  bindings: NonNullable<ProvisionerConfig['notifications']>,
): SavedSearchNotification[] {
  return typeof bindings === 'function' ? bindings() : bindings;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Top-level orchestrator: load the plan, validate it, list current
 * rows, diff, then apply via `applyProvisioningActions`. Throws
 * `ProvisionPlanError` — having written nothing — when the plan fails
 * validation. */
export async function reconcile(
  http: HttpClient,
  config: ProvisionerConfig,
): Promise<{
  plan: ProvisionedSearch[];
  current: SavedSearchRow[];
  actions: PlanAction[];
  results: ActionResult[];
  notifications: NotificationResult[];
  targets: NotificationTargetResult[];
}> {
  const plan = resolvePlan(config.plan);
  assertValidPlan(config, plan);
  const current = await listProvisioned(http, config.prefix);
  const actions = diffProvisioned(plan, current);
  const { results, notifications, targets } = await applyProvisioningActions(http, config, actions);
  return { plan, current, actions, results, notifications, targets };
}

/** Dry-run helper: return the actions without applying them. Throws
 * `ProvisionPlanError` for a plan that fails validation — a dry run that
 * reports "would create 17 searches" for a plan that must not be applied
 * is the wrong answer. */
export async function planOnly(
  http: HttpClient,
  config: ProvisionerConfig,
): Promise<{
  plan: ProvisionedSearch[];
  current: SavedSearchRow[];
  actions: PlanAction[];
}> {
  const plan = resolvePlan(config.plan);
  assertValidPlan(config, plan);
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
  return applyProvisioningPlan(http, actions, { guard: false });
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
    // Search results are NDJSON, which a `json` content-type check would
    // hand to resp.json() and fail on the second line; the search-job
    // runner parses the text itself (same rule as `/search`'s client).
    if (path.includes('/results?')) return resp.text();
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
 * exchange via `getCachedBearerToken` (so a test suite creating one
 * client per call reuses one token) and returns a client that hits the
 * `/api/v1` surface of the configured Cribl Cloud workspace. */
export async function createNodeHttpClient(config: OAuthConfig): Promise<HttpClient> {
  const token = await getCachedBearerToken(config);
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

export interface NodeMetricsTransportOptions extends CachedBearerTokenOptions {
  /** Injected fetch for the metrics GET (tests). Defaults to the global.
   * The OAuth exchange always uses the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Node-side `MetricsTransport`: GETs `/api/v1` + {@link metricsQueryPath}
 * on the configured workspace with a Bearer token from
 * `getCachedBearerToken`, and returns the raw NDJSON body. The token is
 * looked up per query, so a long-running script (a metrics backfill) picks
 * up a refreshed token instead of failing an hour in. A non-2xx response
 * throws with its status and the start of its body. Pass it as
 * `transport` to `/metrics` queries or to `createMetricsCoverageProbe`:
 *
 * ```ts
 * earliestCoveredSec: createMetricsCoverageProbe({ transport: createNodeMetricsTransport(oauth) })
 * ```
 *
 * Node only: in the app iframe use the default transport (the fetch proxy
 * supplies auth); a browser cannot call the workspace with client
 * credentials.
 */
export function createNodeMetricsTransport(
  oauth: OAuthConfig,
  opts: NodeMetricsTransportOptions = {},
): MetricsTransport {
  const apiBase = `${oauth.baseUrl.replace(/\/$/, '')}/api/v1`;
  const tokenOptions: CachedBearerTokenOptions = { refreshMarginMs: opts.refreshMarginMs };
  return async (query, queryOpts) => {
    const token = await getCachedBearerToken(oauth, tokenOptions);
    const doFetch = opts.fetch ?? fetch;
    const resp = await doFetch(`${apiBase}${metricsQueryPath(query, queryOpts)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: queryOpts.signal,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`metrics query failed (${resp.status}): ${text.slice(0, 400)}`);
    return text;
  };
}
