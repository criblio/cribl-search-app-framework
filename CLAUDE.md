# Cribl Search App Framework

Shared libraries, skeleton template, and developer documentation for
building Cribl Search Apps (Vite + React + TypeScript apps that run
inside the Cribl Search sandboxed iframe).

## Repository structure

- `packages/app-utils/` — shared TypeScript utilities + components
  (search client, OAuth, settings, provisioner, cadence, dataset
  store, provisioning UI, CSS tokens)
- `skeleton/` — clone-ready app template built to the GoatTown App
  Builder blueprint: router + Capra bridge, `/configuration` page
  (settings, dataset, cadence, provisioning), `src/settings.ts`,
  `src/provisioning/plan.ts`, Vitest + Playwright configs, deploy
  scripts, Cribl MCP plumbing, `AGENTS.md`, and starter `CLAUDE.md`.
  GoatTown's App Builder skills assume these files exist; rename or
  move one and the skills must change with it
- `docs/skill.md` — Cribl App Platform developer skill (platform
  rules, KQL caveats, sandbox constraints, patterns)

## Creating a new app

1. Copy the `skeleton/` directory to a new repo.
2. Find-replace `APPNAME` with your app name in `package.json` and
   `package-lock.json`.
3. Run `npm ci` to install the template's tested graph. The `@criblio`
   packages are public on npmjs; no `.npmrc`, token or scope routing is
   needed. Native GoatTown runs this install inside its workspace sandbox.
   The app owns the lockfile: update dependencies with normal npm commands
   and commit both manifest and lockfile changes. Keep the template's lockfile
   current in this repository; it is independent of GoatTown's development image.
4. Copy `.env.example` to `.env` and fill in your Cribl Cloud
   credentials.
5. Optional: `scripts/cribl-mcp.sh start` to run the Cribl MCP
   server locally — Claude Code reads `.mcp.json` and gets live
   access to Cribl Search via the `mcp__cribl__*` tools.
6. Add your routes, pages, and sidebar items.
7. `npm run dev` for local development; `npm run deploy` to
   build, package, upload, and install on Cribl Cloud staging.
   If your app ships `scripts/provision.ts`, deploy.mjs runs it
   automatically after install.

## Developing

Read the docs that ship in the skeleton:

- `skeleton/AGENTS.md` — Cribl App Platform reference: host
  globals, fetch proxy, KV store, React Router, proxies.yml.
- `skeleton/CLAUDE.md` — starter conventions for any new app
  (deploy, release, PR style, KQL caveats, MCP setup).
- `docs/skill.md` — KQL workarounds, sandbox constraints, scheduled
  search patterns, UI patterns.

## Packages

### Version ranges: a caret on a 0.x is narrower than it looks

Every package here is pre-1.0, and for a `0.x` version npm reads
`^0.7.0` as `>=0.7.0 <0.8.0` — it does **not** admit 0.8.0. So
bumping a package's `version` silently strands every range that
names the previous minor, and the skeleton is the one that matters:
it pinned `@criblio/app-utils@^0.7.0` while the package shipped
0.8.0, so `https://esm.sh/@criblio/app-utils@^0.7.0` is a 404 and
every app GoatTown generates from the skeleton fails to bundle.

CI could not see it, and the reason will outlive this instance:
GitHub Packages still holds 0.5.0 through 0.8.0, so the scaffold job
resolved `^0.7.0` against 0.7.0 there and went green, while npmjs —
which starts at whatever the first publish was — has only 0.8.0. Any
registry that has been published to for longer satisfies ranges the
new one cannot, so a stale range is green here and 404 for a
consumer. When you bump a package's minor, grep `skeleton/` and the
docs for the old range in the same commit; an app generated before
that bump has its own pin to raise.

### @cribl/app-utils

Subpath imports keep Node-only modules (`dotenv`) out of the
browser TS graph. Common patterns:

**Search + auth + settings**

- `runQuery(kql, earliest, latest, limit)` — generic Cribl Search
  job client (create → poll → fetch NDJSON results)
- `runSearchJob(http, kql, options)` — the same strict job runner with
  an injected browser/Node HTTP client, cancellation, server-side job
  cleanup, bounded polling, pagination, and malformed-NDJSON failure
- `@cribl/app-utils/kql` — KQL serializers and read-only/predicate
  validators for every untrusted query boundary
- `apiUrl()` — base URL for Cribl API calls inside the iframe
- `getBearerToken(config)` — OAuth client-credentials exchange
  (Node side, used by deploy/provision scripts)
- `getCachedBearerToken(config, { refreshMarginMs = 60_000 })` — the same
  with a per-process cache keyed by endpoint + credentials, refetched when
  under a minute remains (a token handed out seconds before expiry failed
  API calls mid page-load); concurrent callers share one exchange and a
  failure is never cached. `fetchBearerToken` returns `{ accessToken,
  expiresAt }`; `clearBearerTokenCache()` resets. `createNodeHttpClient`
  uses the cache.
- `oauthEndpoints(baseUrl)` — pick prod vs staging OAuth domain
- `loadSettings(defaults?, { key? }) / saveSettings(settings, { key?, merge? })`
  — KV-store-backed app settings, at KV key `settings` unless `key` names
  the app's own. `merge: true` reads the stored object and shallow-merges
  over it so fields another page owns survive; a failed or misrouted read
  aborts with `KvError` and writes nothing (not atomic against a racing
  writer). `saveSettingsResult` takes the same options
- `kvGetJson(key)` / `kvGetText(key)` (`/kv`) — strict KV reads: the
  store's own 404 `{"message":"Key not found"}` is absence (`{found:false}`
  / `null`); an HTML body (misroute), a 403 or any other failure is a
  `KvError`. `kvGetText` returns the value verbatim — for raw strings such
  as a proxy-injected header value
- `loadDotEnv(path)` — `.env` parser for Node scripts
- `runWithLimit(items, limit, worker, { signal }?)` /
  `runWithLimitSettled(...)` (`@criblio/app-utils/search`) — bounded
  fan-out for per-item searches; results in input order. Cribl Search
  caps concurrent jobs per cluster at ~20 and a page already holds
  several, so APM's unbounded 22-query Spotlight returned 429s until it
  ran at 4 — use `SEARCH_FANOUT_LIMIT` (= 4). `runWithLimit` resolves `R[]` or rejects with the
  lowest-index error, but only after every item has settled (one failure
  never stops the rest); the settled form returns
  `PromiseSettledResult<R>[]` for per-item errors. Once `signal` aborts,
  unstarted items reject with its reason; the worker receives the signal
  as its third argument to cancel its own job.

  ```ts
  const rows = await runWithLimit(attrs, SEARCH_FANOUT_LIMIT, (attr, _i, signal) =>
    runQuery(distributionKql(attr), '-1h', 'now', 20, signal));
  ```

**Module-level stores** (`@criblio/app-utils/store`)

- `createStore<T>(initial: T): Store<T>` — `{ get(): T; set(v: T): void;
  subscribe(fn: (v: T) => void): () => void }`. `set` is a no-op when
  `Object.is`-equal; a throwing listener is swallowed so the others still
  see the change. `get`/`set`/`subscribe` are safe to destructure.
- `useStore(store): T` — React hook on `useSyncExternalStore`.
- Use it for any value non-React code must read (feature flags, query
  options). A flag is `createStore(false)` — no `createFlag` helper; the
  default is a required argument so "KV unreachable ⇒ feature dark" is
  stated per flag, never inherited. `dataset` and `cadence` are built on it.

  ```ts
  export const lowVolumeMode = createStore(false); // OFF until KV says otherwise
  const enabled = useStore(lowVolumeMode);
  ```

**Agent tools** (`@cribl/app-utils/agent-tools`, `/agent-tool-defs`,
`/cribl-api-tool`, `/openapi-digest`, `/cell-cribl`)

Definitions and executors for the tools an LLM agent calls. Subpath-only
— importing these from the root would pull the agent graph into every
browser bundle.

- `runSearchDefinition() / runMetricsQueryDefinition()` — the schemas
  for `createRunSearchTool` / `createRunMetricsQueryTool`. Keep each
  definition beside its executor: a field renamed on one side only is
  an argument that silently never arrives.
- `criblApiDefinition() / createCriblApiTool(deps)` — `cribl_api`, a
  three-action tool (`search` the OpenAPI digest → `describe` one
  operation → `call` it) so an agent can validate a real API
  interaction before app code is written against it.
- `@cribl/app-utils/openapi-digest.json` — 902 operations distilled
  from Cribl's 8 MB published spec by
  `npm run build:openapi-digest`. Pass it in as `deps.digest`;
  the TS module never imports it, so a host can ship its own.
- `@cribl/app-utils/cell-cribl` — fills every injection seam for a
  server-side host (a workerd cell has no iframe fetch proxy):
  `createCellSearchHttpClient`, `createCellRunQuery`,
  `createCellMetricsTransport`, `createCellMetricsCatalog`,
  `createCellApiClient`, all from one injected `bearer()`.

**Metrics discovery goes through the catalog API, not the dot-commands.**
`.labels` / `.metadata` / `.series <m>` over the metrics *query*
endpoint return a completed job with **zero rows** on some workspaces —
no error, indistinguishable from "this workspace has no metrics"
(verified against one holding 1,187 active metrics and 35,354 series).
`@cribl/app-utils/metrics-catalog` wraps the engine's real catalog API
instead. Browser metrics calls use it automatically; a server-side host
with a custom metrics transport passes the matching `catalog` explicitly.
Discovery falls back to the dot-command only when the catalog is unreachable —
those endpoints are `x-cribl-internal` and Cribl.Cloud-only, so a 404
is a deployment fact rather than a bug. Two path facts the spec does not
state: the engine id comes from `GET
/m/default_search/search/local_search/engines` (needs the group
context, and carries its own `metricsDatasetId`), while everything under
`/products/lakehouse_engine_metrics/…` takes **no** group context — the
exact reverse of `/search/*`. `metrics/summary` is ~1 MB and honours no
`limit`, so the client projects it down to totals plus the highest-
cardinality metrics rather than passing it through.

**`cribl_api` search is AND-first with a partial FALLBACK, ranked by
score and never by term coverage.** An operation matching every term
wins outright and, if any exist, they are the whole result — that AND is
what stops "search unicorns" returning the several hundred endpoints
that merely say "search". But when nothing matches every term the answer
must not be silence: a model hunting Stream metrics wrote *"Stream
worker input output metrics statistics event bytes per second"*, ten
terms, and the AND-only version reported "no endpoints matched" about a
spec that documents `/system/metrics/query` one summary line away.
Under the fallback that endpoint ranks third. Rank the fallback by
score, **not** by how many terms an operation covers: on that same query
the highest-coverage hits were `/system/inputs/{id}/pq` and
`/search/event-breaker-preview` — "input"+"per" (from *persistent*) and
"output"+"event" — while every `/system/metrics*` endpoint matched the
one term that mattered. Broad words pair up by accident; a single strong
path hit does not. A `SearchHit` carries the terms it matched so the
tool can name what it ignored, and `unmatchedTerms()` answers the
different question "is this word in the spec at all" — a query emptied
by a `method`/`writesOnly` filter needs the filter dropped, not
rewording, and one generic dead-end message for both sends a model in a
circle.

**Writes through `cribl_api` require per-call human approval.** A write
(anything not GET/HEAD/OPTIONS) is *not* executed on first call: the
tool records a `PendingWrite` and returns an approval id. The user
approves through a host route the agent cannot reach; the agent retries
with `approvalId`; the tool calls `approvals.consume(id, digest)` —
atomic check-and-burn — before the request. The approval is bound to a
canonical digest of the exact request (so a changed body voids it) and
is single-use (so it can't be replayed). A host with no `approvals`
store refuses writes outright rather than running them.

This gates the *agent*, not the human — anyone who can drive the
session can approve, and the bearer's own permissions bound the damage.
Its guarantee is narrow and worth keeping: no write happens without a
person deciding.

**GoatTown session client** (`@cribl/app-utils/goattown`,
`/goattown/proposal-panel`)

The shared client for a GoatTown session service: `GoatTownClient`
(create/send/observe/lifecycle), `observeSession`, `conclusionFromEntries`,
typed `GoatTownError`, `SessionDiagnostics`, and the provisioning helpers.
Wire types live in `@criblio/agent-protocol`, which the service imports too
— that shared dependency is what stops the two sides drifting.

Three rules, each of which has already cost a consumer a debugging session:

- **`idle` is not completion.** It means "between turns" and is reached
  before the first answer as well as after the last, so a consumer that
  stops on idle returns an empty answer that parses downstream as a real
  one. Completion is a terminal `execution` receipt AND a local cursor that
  has reached its `finalSeq` — `assistantDone` ends one assistant *message*,
  not a request, and one request can span several tool/model rounds. A
  `null` execution means legacy or untracked, never success.
- **The conclusion is often not in an assistant message.** An agent that
  concludes with a report tool puts the verdict in the tool RESULT.
  `conclusionFromEntries` reads report and summary payloads first and
  assistant prose second; a hand-rolled scan of assistant entries returns
  empty exactly when the agent behaved correctly. It lives in
  `@cribl/app-utils/investigator` — the mistake is not transport-specific —
  and is re-exported here.
- **No credential belongs in the browser.** The platform proxy injects the
  app credential for domains declared in `config/proxies.yml` and strips
  any `authorization` the page sets, so APM's historical
  `kv.sharedCellToken` bought no access and leaked a long-lived secret.
  `assertNoBrowserCredential` throws rather than warns.

Provisioning follows the same shape: the producer comes from the credential
(`proposalScope.producerInput: 'credential'`), so proposal YAML must omit a
top-level `producer:` or the service rejects it with `producer_mismatch`.
`stageProposal` validates before storing — a store writes an immutable
revision, so a malformed proposal that skips validation leaves a permanent
bad revision in the tenant's history. Activation is always human;
`openReviewPage` opens the review tab with the opener severed.

Image sends are validated locally against the ceilings `/protocol`
advertises. Those count **base64 characters, not decoded bytes** — checking
byte counts accepts payloads ~33% over the real ceiling, which then fail
server-side after the whole upload. A 422 `image_input_unavailable` is
surfaced, never retried as text: resending without the attachments produces
a confident answer about an image the model never saw.

**Saved-search provisioner** (`@cribl/app-utils/provisioner`)

- `reconcile(http, config)` / `planOnly(http, config)` — diff the
  app's declared scheduled-search plan against the workspace and
  upsert/delete as needed
- `unprovisionAll(http, prefix)` — bulk delete by prefix
- `listProvisioned / diffProvisioned / applyProvisioningPlan` —
  lower-level building blocks
- `createBrowserHttpClient() / createNodeHttpClient(config)` —
  HTTP clients with the right auth headers for either environment
- `applyProvisioningActions(http, config, actions)` — the ONE apply
  path (`reconcile` and `<ProvisioningPanel>` both use it): validate,
  seed lookups, unbind deleted searches, write, ensure notification
  targets, bind notifications. Returns `{ results, notifications, targets }`
- `ProvisionerConfig.guard` / `.validate` / `.notifications` /
  `.notificationTargets` — see below

**Background searches stay true** (`/provision-guard`,
`/provision-canary`, `/notifications`, `/vt-results`)

Every failure these exist for reported success in every API layer.

- `validateProvisionPlan(searches, { prefix?, seedLookups?, disableRules? })`
  → `{ ok, problems: { searchId, rule, message }[] }`. Rules: missing or
  empty `dataset=`; `(?i)` or `mv-expand` upstream of `export … to lookup`;
  an overwrite export (no `mode=` counts) not starting with a `print`
  sentinel row; empty lookup name; names outside `^[a-zA-Z0-9 _-]+$`
  (Cribl 400); duplicate ids; ids outside the prefix. `//` comment lines
  are ignored. **Runs by default** inside `reconcile`, `planOnly`,
  `applyProvisioningActions` and the low-level `applyProvisioningPlan`;
  a failing plan throws `ProvisionPlanError` (`.problems`) before any
  write, and the panel lists the problems with no Apply button.
  `config.guard: { disableRules: [...] }` skips one rule; `guard: false`
  turns it off. `config.validate(plan, ctx)` ADDS app rules — it never
  replaces the built-in ones. Also run it in CI against the real plan.
  `ProvisionProblem.rule` is `ProvisionProblemRule` =
  `ProvisionRule | (string & {})`, so an app rule carries its own name
  through `ProvisionPlanError` and `InvalidPlanView` (it used to have to
  borrow a built-in, which mislabelled it and let `disableRules` for that
  built-in drop it). `disableRules` stays typed to the built-ins.
- `runProvisionCanary(http, { sentinelSearchId, lookupProbe?: { name, kql },
  extraProbes?, firstInstall?, sentinelWindow?, timeoutMs? })` →
  `{ ok, probes: { name, ok, tolerated, rowCount, message }[] }`. The
  sentinel must have `$vt_results` rows (default `-2h`); `lookupProbe.kql`
  returns one row of `total`/`joined` over sampled live keys. First install
  tolerates empties (`tolerated: true`), never query errors. Pass the same
  options as `<ProvisioningPanel canary={…}>` to run it after Apply (first
  install inferred from "this Apply created the sentinel") and from a
  "Run health check" button.
- `ensureNotificationTarget(http, { id, type, … })`,
  `ensureSavedSearchNotification(http, { searchId, targetId, conf? })`,
  `removeSavedSearchNotification`, `removeNotificationsForSearch` —
  bindings live at `/m/<group>/notifications`; **inline
  `schedule.notifications` is dropped by the server**. Or declare
  `config.notifications: [{ searchId, targetId, conf }]` and the apply
  path binds after writing the search and unbinds before deleting it.
  A target the app creates goes in `config.notificationTargets` (an array,
  or a sync/async function called at apply time): it is ensured after the
  searches and BEFORE the bindings, and a binding whose target failed is
  skipped and reported. Do not create it in `<ProvisioningPanel
  afterReconcile>` — that runs after the bindings, which is why APM had to
  keep binding by hand.
- `readVtResults(jobNames, { earliest?, latest?, limit?, signal?,
  latestRunOnly?, runQuery? })` → `Map<jobName, rows[]>` from ONE
  `dataset="$vt_results" | where jobName in (…)` job (the `jobName=[…]`
  form does not parse). Keeps each job's newest run (`latestRunRows`);
  a job with no rows is an ABSENT key — fall back to the live query.
  Default limit 10 000 (`runQuery`'s 200 truncates a batch).
  `runStartedMs(jobId)` reads the run's epoch ms.

**Cadence** (`@cribl/app-utils/cadence`, `/cadence-picker`)

- `CADENCE_OPTIONS / DEFAULT_CADENCE / cadenceToCron` — cadence
  catalog and cron mapper
- `offsetCron(cron, minutes)` — stagger a dependent search after its
  source at the same cadence (`*/5` → `1-59/5`; every-minute is left
  alone, never rewritten to an hourly `1 * * * *`). The offset is
  relative to the cron it is given and **composes**: `1-59/5` + 2 →
  `3-59/5`. Pass the source's cron (`getSearchCadenceCron()`), never an
  already-offset schedule read back from a saved search, or the dependent
  drifts on every reconcile. APM's former local copy returned `a-59/N`
  unchanged; that was not parity, and the framework does not copy it
- `getSearchCadence / setSearchCadence / subscribeSearchCadence /
  getSearchCadenceCron` — module-level pub/sub for the active
  scheduled-search cadence
- `<CadencePicker>` — Settings-page UI for picking the cadence

**Dataset store** (`@cribl/app-utils/dataset`, `/dataset-provider`)

- `getCurrentDataset / setCurrentDataset / subscribeDataset` —
  module-level pub/sub for the active Cribl dataset
- `useDataset()` — React hook backed by `useSyncExternalStore`
- `<DatasetProvider defaultDataset onError? settingsKey? loadDataset?>` —
  puts `defaultDataset` in the store before children render (only if the
  store is empty), then loads the saved dataset and pushes it in; nothing
  saved ⇒ the app default. The saved value is `dataset` at KV key
  `settings`; `settingsKey` reads the app's own key, `loadDataset` replaces
  the read (read through a ref, like `onError`)
- `loadDataset({ signal, isCancelled })` — the load is aborted on unmount,
  on a `defaultDataset`/`settingsKey` change, and in StrictMode's discarded
  first effect; a cancelled load's result or error is dropped. A loader
  with side effects of its own (APM applies feature flags from the same
  read) checks `isCancelled()` before each one, or passes `signal` to its
  fetch. A zero-argument loader still type-checks and works
- **Never build KQL at import time.** The default is applied during the
  provider's first render, so a module-scope constant that calls
  `kqlDatasetId(getCurrentDataset())` (APM's MetricsBackfillPanel built its
  emitters this way) sees `''` and throws `KqlSafetyError` ("dataset ID is
  empty — was KQL built at import time…"), blanking the page. Build
  queries in functions/effects (the skeleton's `source()` is a function for
  this reason), or call `setCurrentDataset()` at module scope in an entry
  module imported before any KQL-building module
- A failed KV read keeps the app default but is not silent: it lands in
  `useDatasetLoadError()` / `getDatasetLoadError()` /
  `subscribeDatasetLoadError` (`/dataset`), goes to `onError(err: Error)`,
  and is `console.warn`ed when there is no `onError`. The next good load
  clears it. `onError` is read through a ref, so an inline arrow does not
  re-run the load.
- Pair with `<Outlet key={dataset} />` in your shell so route
  subtrees fully remount on dataset change.

**Provisioning UI** (`@cribl/app-utils/provisioning-panel`,
`/provisioning-banner`)

- `<ProvisioningPanel>` — Settings-page diff → preview → apply
  flow with a two-click "Unprovision all" escape hatch
- `<Banner>` + `useProvisioningBanners(sources)` — persistent
  banners at the top of any page when provisioning is incomplete.
  A source that throws yields an `info` "Couldn't check …" banner,
  never silence. Router-agnostic — caller supplies their own `<Link>`
  to its configuration page (route it at `/configuration`: the host
  shell intercepts app routes containing "settings").

**Dataset-level provisioner** (`@cribl/app-utils/dataset-provisioner`)

- `ensureAcceleratedFields(http, path, fields)` — idempotent push
  of indexed-field ids onto a dataset's `acceleratedFields` array
- `ensureRulesetRule(http, path, rule, { validate, insertBefore })` —
  insert or refresh a single rule in a dataset ruleset, with an
  optional acceptance callback for the body
- `getAcceleratedFieldsStatus / getRulesetRuleStatus` — read-only
  checks for boot-time banner detection
- `datasetPath(id, group?) / rulesetPath(group?)` — API path
  helpers (default group is `'default_search'`)

**Metrics backfill** (`@criblio/app-utils/metrics-backfill`)

- `runMetricsBackfill(emitters, deps, { horizonSec, nowSec, signal?, onProgress?, minChunkSeconds? })`
  — re-run each `export to metrics` emitter over the history its family
  lacks. Coverage is read from the metrics store (earliest sample per
  family), so only the gap `[horizon, earliestCovered)` is filled, newest
  window first (resumable; adding a family backfills only that family).
  Fixed 6h windows by default (`emitter.windowSeconds`, or
  `deps.planWindows` + `planDensityWindows(bins, binSec, max, gap)` for
  per-event emitters). `planWindows` output must tile the gap exactly —
  contiguous, non-overlapping, inside it — or that emitter fails
  (`status: 'failed'`, `error` says why) before any export: a window past
  the gap's top re-writes covered minutes and the store doubles them.
  `windowTilingError(windows, gap)` is the check. Pass `gap` to
  `planDensityWindows` and it ignores bins outside the gap, clamps to it
  and bridges empty bins (count bins are coarser than the minute-aligned
  gap); without it the windows follow the bins, holes included.
- The store is not idempotent, so: probe once per emitter, never per window
  (a window's top edge IS the first covered bin, so a per-window probe
  skips it — APM got 6h holes); halve-and-retry a window that drops events,
  newer half first; stop an emitter whose export drops 100% (a rejected
  query such as `invalid_type`, which splitting cannot fix).
- `runMetricsExport(http, query, earliestMs, latestMs)` and
  `readExportStats(rows)` read `eventsOut`/`eventsDropped`/`dropReasons`
  from the export's own row — a `completed` job can drop every event.
  `createMetricsCoverageProbe()` is the matching `earliestCoveredSec`
  (histograms probe via `histogram_quantile`; a bare `count()` of one is
  empty). From a Node script give it
  `createNodeMetricsTransport(oauth)` (`/provisioner`, beside
  `createNodeHttpClient`): the metrics query path with a
  `getCachedBearerToken` Bearer, looked up per query so a long run
  refreshes; a non-2xx throws.
- `emitter.coverageLabels: { quantile: 'p95' }` restricts the default
  probe to those exact label values (`count(m{quantile="p95"})`) for an
  emitter that writes one series of a shared family.
  `coverageProbeQuery(metric, kind, { splitBy?, labels? })` (a string third
  argument is still `splitBy`); names are validated, values escaped.
- `emitter.coverageSplit: { label, values }` — probe per label value for
  families whose series share one name (percentile gauges with a
  `quantile` label). `count(metric)` is covered wherever ANY series
  exists, so a covered p95 hid an empty p99. With a split the probe runs
  `count by (label) (metric)` and coverage starts at the LATEST of each
  value's earliest sample (`splitCoverageSec`) — the gap is wherever any
  required series is missing; a listed value with no sample is
  uncovered. The emitter re-writes the older series over that gap, so use
  it for gauges, not counters.

```ts
const result = await runMetricsBackfill(emitters, {
  runExport: (q, e, l) => runMetricsExport(http, q, e, l),
  earliestCoveredSec: createMetricsCoverageProbe(),
}, { horizonSec: 86_400, nowSec: Date.now() / 1000, onProgress, signal });

// Node (deploy script): same algorithm, Node transports.
const http = await createNodeHttpClient(oauth);
const deps = {
  runExport: (q, e, l) => runMetricsExport(http, q, e, l),
  earliestCoveredSec: createMetricsCoverageProbe({ transport: createNodeMetricsTransport(oauth) }),
  planWindows: async (emitter, gap) => planDensityWindows(await countBins(gap), 300, SAFE_MAX_EXPORT_EVENTS, gap),
};
```

**Generated events** (`@criblio/app-utils/generated-events`)

- Write app events with `| export tee=true to search "<dataset>"`
  (`exportToSearchClause(dataset)`); `| send group="search"` silently
  stopped persisting.
- Read the datatype with `STORED_DATATYPE_EXPR`
  (`coalesce(tostring(data_datatype), tostring(datatype))`) — `send` rows
  stored it as `data_datatype`. `storedDatatypePredicate(types)`,
  `eventIdExpr(fallbackFields)` for a stable dedupe id over legacy rows.
- `defineGeneratedEvents({ datatypes, schemaVersion, canaryProducer, canaryFields? })`
  binds an app's datatypes into `predicate`, `canarySend`, `canaryRead`,
  `canaryVerdict`; `runGeneratedEventCanary(events, run, { dataset })`
  proves the write→read round trip after provisioning.
- `canaryFields[datatype]` is an object of literals (strings, numbers,
  booleans, always serialised as literals — a string `'now()'` stays the
  string) or `kqlExpr('now()')` expressions, or a callback
  `(canaryId) => fields` for per-run values (`evaluation_id`, `version`).
  Callback results are validated like static fields on every send.
  `kqlExpr` is the only way in unquoted — trusted code only; it refuses
  empty text, newlines, `|` and `;`, and a look-alike `{ kql }` object is
  rejected.

```ts
const events = defineGeneratedEvents({
  datatypes: ['myapp_alert'], schemaVersion: 1, canaryProducer: 'myapp_canary',
  canaryFields: { myapp_alert: (id) => ({ evaluation_id: `canary-${id}`, evaluated_at: kqlExpr('now()') }) },
});
const verdict = await runGeneratedEventCanary(events, runQuery, { dataset: 'main' });
```

**Alert state machine** (`@criblio/app-utils/alert-state`)

- `nextAlertState({ prevStatus, isBad, newBad, newGood }, { fireAfter, clearAfter })`
  → `{ status, transitionedTo, fireCountDelta }`; ok → pending → firing →
  resolving → ok, plus pending → ok and resolving → firing.
- `alertStateKql(opts)` / `alertCaseKql(opts)` / `alertTransitionKql(opts)`
  emit the same machine as KQL for the scheduled evaluator. Both come from
  one arm table, and the tests run the emitted KQL against the TS for every
  transition, so the UI and the evaluator cannot drift.
- `alertStateKql({ defaultPrevStatus: false })` omits the leading
  `prev_status=iff(isnotempty(prev_status), prev_status, "ok")` stage for a
  consumer that defaults upstream (then a null/empty prior status reads
  `ok`, not `pending`, so default it yourself). To splice your own stages,
  `alertStateStages(opts)` returns `{ defaultPrevStatus, counters, state }`
  (joined with `\n` they ARE `alertStateKql`) and
  `alertArmConditions(opts)` returns `{ arms: [{ condition, next,
  transition }], fire, clear }` — the exact condition strings embedded.

```ts
const kql = `${evaluatorRows}\n${alertStateKql({ fireAfter: 2, clearAfter: 3 })}\n${exportToSearchClause(ds)}`;
```
**Viz** (`@cribl/app-utils/viz`, `/graph`)

- `<LineChart>`, `<StackedColumnChart>`, `<Sparkline>`, `<BarList>`,
  `<StatTile>`, `<Panel>`, `<DataTable>` — d3 charts on the design tokens.
  `StackedColumnChart` takes LineChart's props for the shared concerns
  (`title, subtitle, series, yFormat, height, error, refreshing,
  emptyMessage`; series order = stack order, bottom up) and shares its
  stylesheet so sibling panels match:
  `<StackedColumnChart title="Status mix" series={[{ name: '2xx', color: SERIES_COLORS[1], data }]} />`.
  `stackColumns(series)` is its pure layout.
- `entityColor(id, lightness = 50)` / `entityHue(id)` — deterministic
  identity colour (`hsl(hash % 360, 60%, L%)`). Identity is not health: a
  waterfall must keep a call chain followable, so health is added as a
  second channel, never substituted. `SERIES_COLORS` is for ≤8 series in
  one chart; `entityColor` is "the same entity looks the same everywhere".
- `buildTimeline(items, { id, parentId, start, end, windowStart?, windowEnd? })`
  → `{ windowStart, windowEnd, duration, rootId, rows }`, rows depth-first
  with `depth`, `offset`/`width` fractions, `clippedStart`/`clippedEnd`,
  `inWindow`. Scaled to the ROOT item, not min/max of all items — a
  clock-skewed child stamped before its parent squashed the real work into
  the right 8% of the axis. Orphans become roots; cycles are kept.
- `/graph`: `<NetworkGraph>`, `useForceLayout`, `usePanZoom`, `linkKeys`.
  Links are identified by `id` if given, else `source>target` (+`#n` for
  parallel edges); data-only updates match by that key, not array index.

**Styles**

- `styles/tokens.css` — Cribl Design System custom properties
- `styles/base.css` — CSS reset + base element styles

**Runtime containment**

- `<ResilienceBoundary>` — router-free root/panel render containment
  with retry and an optional app-owned fallback renderer

**Time, URL state, page loads** (`@cribl/app-utils/time`, `/url-state`,
`/page-load`, `/partial-failure-banner`)

- `TIME_RANGES: readonly TimeRangeOption[]` (`{ label, value, binSeconds }`,
  15m/1h/6h/24h), `binSecondsFor(range, ranges?) → number`,
  `previousWindow(earliest, latest = 'now') → { earliest, latest } | null`,
  `relativeTimeMs(rel) → number | null`, `durationMs(range, fallback) →
  number`. Pure, cell-safe. Unparseable input is `null`, never a one-hour
  guess — a guessed window makes a "vs previous" delta lie.
  `previousWindow('-1h')` → `{ earliest: '-2h', latest: '-1h' }`.
  **`relativeTimeMs('now')` is `0`, not `null`, so `relativeTimeMs(r) ??
  3_600_000` keeps the 0** and a rate divided by that window is wrong. For
  a lookback window's length use `durationMs(r, fallback)`, which falls back
  for both unparseable and zero-length ranges.
- `useQueryParam(name, default, { legacy?, history?: 'replace' | 'push' })
  → [value, set]` and `useRangeParam(default, opts)` (`?range=`). One
  functional `setSearchParams` write that omits the param at its default
  and deletes `legacy` keys: React Router builds every write from the
  render's params, so a second write in the same handler reverts the
  first (APM's legacy `?lookback=` bug). The ONLY module that imports a
  router — `react-router-dom` is an optional peer for this subpath alone,
  and it is never re-exported from the root.
  `const [range, setRange] = useRangeParam('-1h', { legacy: ['lookback'] });`
- `usePageLoad(load, deps, { errorKey?, silentFailures?: 'replace' | 'keep' })
  → { phase: 'initial' | 'refreshing' | 'idle', failures, updatedAt, retry(),
  refresh({ silent? }), report(key, err | null, token?), token() }`,
  `load(ctx: { silent, signal, isCurrent, fail(key, err), ok(key) })`. Full
  loading only before the first load settles; each load is a new query
  generation; superseded results and aborted reads never become failures;
  the load's own failures are replaced when it settles, not cleared when it
  starts (no banner flicker on polls). Own subpath so `/query-generation`
  stays React-free for cells. `createPageLoadController` is the same
  machine without React (it has `report`/`token` too). One per page.
  - `silentFailures: 'keep'` — a `refresh({ silent: true })` poll can
    neither show nor clear a load failure (its `fail`/`ok` are no-ops and
    its settle leaves them); only mount, a deps change or `retry` changes
    them. Default `'replace'` is the old behaviour. APM's Alerts page polls
    every 30 s and must not flash or hide its error on a poll.
  - `report(key, err | null, token?)` — failures from sibling effects
    OUTSIDE the loader (APM ServiceDetail's deferred KQL panels, alert
    status/history, metric cards). Owned separately: a settling load
    replaces only its own keys, so it no longer wipes theirs, and only
    `report(key, null)` clears one. Use distinct keys from the loader's.
    Aborts are ignored. `token()` changes on a deps change or unmount, not on
    retry/refresh; pass one captured in the effect to drop a report from a
    superseded page — but only from an effect that re-runs with the page's
    deps, or its report goes stale and is dropped for good.
- `<PartialFailureBanner failures={Record | Map} onRetry? />` — Capra
  `Alert`: "Some data is unavailable. Empty values below are not evidence
  of health." plus one line per failed panel and a Retry button.
  `<PartialFailureBanner failures={failures} onRetry={retry} />`

### The cell harness is no longer here

`@criblio/cell-harness` moved to **`criblio/goattown`** (`cell/src/harness/`)
on 2026-08-29 and this repo no longer builds or publishes it. Read
`cell/src/harness/CONTEXT.md` there before touching compaction, `history()`,
or the turn runner's terminal conditions.

Why, so nobody re-extracts it out of tidiness: the sharing had stopped being
real. APM's cell is ~770 lines pinned at `^0.1.1`; GoatTown's payload is ~14k
on `^0.6.0`; and nothing inside this repo ever imported the harness, so there
was no third consumer to serve. **Removal cannot break APM** — a `0.x` caret
never resolves out of `0.1.x`, and npm does not unpublish, so every version
APM can resolve still exists on GitHub Packages forever.

What stays here is the line worth keeping: `app-utils` is the Cribl *domain*
layer every app wants the same behavior from, `agent-protocol` is the contract
an app uses to register agents with GoatTown (more valuable now, not less), and
`cell-workspace` is genuinely generic. The harness was the one piece where
"shared" meant "shared with a single cell that never upgrades".

### The scaffold contract: `skeleton/` is an overlay, not a fork

The platform scaffolds apps with `npx @cribl/apps create` and keeps them
current with `apps upgrade`. `skeleton/` is that scaffold plus our
additions, and it has to stay that way: the previous fork drifted until
`apps upgrade` could no longer repair it — `vite.config.ts` held the
watched config files inline rather than in the named
`WATCHED_CONFIG_FILES` const the live-preview migration edits — and
backend functions were broken for every generated app until a customer
reported it.

`apps build` bundles each endpoint and `apps package` ships
`default/backend.yml` beside the bundles, so **an app that does not run
both cannot deploy a backend endpoint at all.** Live preview is the
visible symptom; the artifact is the disease.

**`apps upgrade` cannot police the overlay.** It is VERSION-gated: once
`cribl.createAppScriptVersion` names the current contract it skips every
migration without reading a file, so deleting the backend plugins from
`vite.config.ts` leaves it a clean no-op. Verified that way round.
`npm run check:scaffold-contract` compares against the assets
`@cribl/apps` actually ships — plugins invoked, files watched, subpaths
imported, config templates present, contract marker current — and derives
all of it at check time, so a new platform plugin fails the build on the
next `@cribl/apps` bump rather than going quietly stale.

Additions on our side are fine; the rule is "everything the platform
ships is present", never "nothing else is". `resolve.dedupe` in
`vite.config.ts` is one such addition and is load-bearing: `app-utils`
peers on React, and two React copies break hooks at runtime.

Two platform behaviors worth knowing before they surprise you:

- **`apps package` increments `package.json` before packing.** A release
  left to the default attests an artifact one patch ahead of its own tag,
  so the release-build action takes an `app-version` input that pins it.
- **`@cribl/apps` pins esbuild ~0.17**, which carries a moderate
  dev-server advisory. The skeleton's shipped tree stays strict at `low`
  and is clean; the dev tree is gated at `high`, because nothing in it
  reaches the packaged app.

### @cribl/app-tooling

Node-only commands shared by every consumer app. The split with the
platform CLI is by layer: `@cribl/apps` **produces** the artifact
(scaffold, build, package, preview plugins) and this package **verifies
and delivers** it. Four of the five commands consume an archive, which is
why only the packer was superseded.

- `cribl-app-package` — **deprecated**; use `apps package`. It cannot
  ship `config/backend.yml` or the bundles `apps build` produces, so an
  app with endpoints packs an archive that installs and then 404s; it also
  drops `policies.yml`, `schedules.yml` and README.md. The warning it
  prints on every run lists the migration (devDependency `@cribl/apps`,
  `"package": "apps package"`, app-tooling >= 0.4.2 so deploy follows the
  version bump). Still works for apps with no backend endpoints that were
  generated before the contract.
- `cribl-app-inspect` — archive shape, manifest, static asset, backend
  manifest/bundle correspondence, and optional proxy policy validation.
  `apps build` and `apps package` run separately, so a manifest can name
  a bundle nobody built; inspect fails on either direction of that drift.
  Also `--require-empty-proxies`, or
  `--proxies-manifest <path>` to deep-compare the packaged
  `proxies.yml` against a committed expected manifest (any extra or
  missing domain, path entry, injected header, or timeout fails;
  an empty manifest is equivalent to `--require-empty-proxies`)
- `cribl-app-deploy` — exact-artifact upload, server preinstall policy,
  idempotent install/upgrade without force, and optional provisioning.
  `POST /api/v1/apps` has been seen returning 500 `UnknownError` *after*
  committing, so an install error is reconciled by reading the installed
  record back rather than retried — a blind repeat is a second mutation
  whose first attempt may have succeeded. The reconciliation only claims
  success where the version proves it (absent→installed, or an upgrade that
  moved the version). A same-version redeploy is skipped and reported as
  unconfirmable: the platform exposes no installed artifact digest or
  operation receipt, so same-version records are indistinguishable and only
  a version bump is certain. `--dry-run` builds and inspects the artifact,
  reads the installed version and prints install / upgrade / skip — no
  upload (it is itself a write, so the server preinstall check cannot run),
  install or provisioning, and a package.json bumped by packaging is put
  back. The artifact is named from package.json as it reads AFTER
  `npm run package`, because `apps package` increments the version first;
  before 0.4.2 deploy named it from the pre-package version and picked up
  the previous run's archive.
- **Every bin rejects an unknown option, a missing value or a stray
  argument** with usage and exit 2 before doing anything. They used to
  pick known flags out of argv and ignore the rest, so `npm run deploy --
  --dry` was a real deploy. `--help` on each lists its options.
- `cribl-app-release-evidence` — checksum, source/framework metadata,
  and deterministic production CycloneDX SBOM
- `cribl-app-security` — SHA-pinned Action, dependency-license, and
  tracked-secret gates
- `@criblio/app-tooling/playwright` — live-workspace test helpers (needs
  `@playwright/test` and `@criblio/app-utils` in the app): `installCriblHostGlobals`,
  `gotoApp`, `appFrame` (both also take `{ appPath }` and parse the id
  with `appIdFromPath`), `dismissHostAnnouncements`, `loginSetup`,
  `runSearch`, `loadTestEnv`, `criblCredentialsFromEnv`. Opening
  `/app-ui/<app>/` directly gives an empty `#root` and 401s, because the
  host globals and Bearer fetch wrapper are missing; these put them back.
  `docs/testing.md` has the recommended `playwright.config.ts`,
  `auth.setup.ts` and `vitest.config.ts`.
- **Every subpath ships hand-written `.d.ts`** beside its `.mjs`, wired as
  the `types` condition in `exports` (`types` first). `./proxies` shipped
  with none until 0.4.1, so a strict TS app got TS7016 importing
  `parseProxiesYaml`. `npm run typecheck` compiles a strict NodeNext
  consumer (`test-types/consumer.ts`) through the exports map by package
  name, and `test/declarations.test.mjs` fails when a runtime export or a
  new subpath has no declaration — update the `.d.ts` with the `.mjs`.

The tooling package owns mechanisms. Consumer package scripts and CI
provide app policy such as `--require-empty-proxies` /
`--proxies-manifest`, live workspace credentials, and the
app-specific smoke spec list.

## Working in this repo

The framework CI independently gates `app-utils` and `app-tooling`.
The **skeleton** also ships pinned consumer CI/release workflows.
When making framework changes:

1. Edit `packages/app-utils/src/*` for the shared library.
2. Edit `skeleton/*` for the clone-ready template. Changes here
   ship to every NEW app, but do NOT auto-propagate to existing
   apps — those copies were taken at scaffold time.
3. Consumer apps pull `@criblio/app-utils` and `@criblio/app-tooling`
   as versioned deps from public **npmjs** (`publish.yml` publishes every
   workspace version not yet there on each master push; GitHub Packages
   holds only the old 0.5–0.8 line and gets nothing new), so framework
   changes reach them through a publish plus a semver bump — not a
   `file:` path or a SHA pin. Skeleton CI installs from npmjs the same
   way, with no credential, which is what keeps the template honest
   about what a real app resolves.
4. Run `npm test && npm run typecheck` inside `packages/app-utils/`;
   consumers run their own lint + build as an integration gate.

**A version bump takes TWO PRs, and the second one is the skeleton.**
The `skeleton` CI job scaffolds the template and `npm install`s from
npmjs, so `skeleton/package.json` may only name a version that
is already **published** — and publishing happens on the master push,
after the bump merges. Raising `@criblio/app-utils` to `^0.8.0` in the
same PR that sets `version: 0.8.0` fails that job with
`ETARGET notarget No matching version found`, which reads like a broken
change and is only an ordering problem. So: bump the package version and
the sibling *devDependency* ranges (those resolve through the workspace,
not the registry) in the first PR; move the skeleton range in a
follow-up once the publish lands. The gate arrived in #44, one PR after
the last bump, so #46 was the first to meet it.

## Conventions

- Everything here is **Apache-2.0**. A new package needs the
  `license` field *and* a copy of the root `LICENSE` in its own
  directory — `npm run check:publish-config` fails on either, because
  npm itself warns about neither and a published version is
  immutable. `app-utils@0.8.0`, `agent-protocol@0.4.0` and
  `cell-workspace@0.1.3` shipped with no license field and cannot be
  fixed; they can only be superseded.
- Keep exports composable. UI primitives should not pull in
  routing-aware code — `<Banner>` accepts a `children` slot for
  the action so apps plug their own `<Link>` in. This keeps
  `@cribl/app-utils` router-dep-free.
- New entry points get a subpath alongside the root re-export.
  The root re-export is convenient, but importing `@cribl/app-utils`
  pulls every transitive module into the consumer's TS graph —
  including Node-only ones like `dotenv`. Subpath imports
  (`@cribl/app-utils/dataset`, `/provisioner`, etc.) avoid that.
- App-specific values (rule bodies, field lists, KQL queries)
  stay in the consumer repo. The framework provides the shape; the
  app provides the data.
