# Cribl Search App Framework

Shared libraries, skeleton template, and developer documentation for
building Cribl Search Apps (Vite + React + TypeScript apps that run
inside the Cribl Search sandboxed iframe).

## Repository structure

- `packages/app-utils/` — shared TypeScript utilities + components
  (search client, OAuth, settings, provisioner, cadence, dataset
  store, provisioning UI, CSS tokens)
- `skeleton/` — clone-ready app template with sidebar, settings
  page, deploy scripts, Cribl MCP plumbing, `AGENTS.md`, and
  starter `CLAUDE.md`
- `docs/skill.md` — Cribl App Platform developer skill (platform
  rules, KQL caveats, sandbox constraints, patterns)

## Creating a new app

1. Copy the `skeleton/` directory to a new repo.
2. Find-replace `APPNAME` with your app name in `package.json`.
3. Run `npm install`. The `@criblio` packages come from GitHub
   Packages, which requires auth even for public reads, so export a
   token first: `export NODE_AUTH_TOKEN=$(gh auth token)`. The
   skeleton's `.npmrc` wires the scope to that registry; without the
   token npm falls through to npmjs and reports a bare 404 rather
   than an auth failure. In CI, `${{ github.token }}` plus
   `permissions: packages: read` is enough.
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
- `oauthEndpoints(baseUrl)` — pick prod vs staging OAuth domain
- `loadSettings() / saveSettings()` — KV-store-backed app settings
- `loadDotEnv(path)` — `.env` parser for Node scripts

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
instead; pass a `catalog` to `createRunMetricsQueryTool` (or to
`listLabels`/`listMetricMetadata`/`listSeries`) and discovery uses it,
falling back to the dot-command only when the catalog is unreachable —
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

**Saved-search provisioner** (`@cribl/app-utils/provisioner`)

- `reconcile(http, config)` / `planOnly(http, config)` — diff the
  app's declared scheduled-search plan against the workspace and
  upsert/delete as needed
- `unprovisionAll(http, prefix)` — bulk delete by prefix
- `listProvisioned / diffProvisioned / applyProvisioningPlan` —
  lower-level building blocks
- `createBrowserHttpClient() / createNodeHttpClient(config)` —
  HTTP clients with the right auth headers for either environment

**Cadence** (`@cribl/app-utils/cadence`, `/cadence-picker`)

- `CADENCE_OPTIONS / DEFAULT_CADENCE / cadenceToCron` — cadence
  catalog and cron mapper
- `getSearchCadence / setSearchCadence / subscribeSearchCadence /
  getSearchCadenceCron` — module-level pub/sub for the active
  scheduled-search cadence
- `<CadencePicker>` — Settings-page UI for picking the cadence

**Dataset store** (`@cribl/app-utils/dataset`, `/dataset-provider`)

- `getCurrentDataset / setCurrentDataset / subscribeDataset` —
  module-level pub/sub for the active Cribl dataset
- `useDataset()` — React hook backed by `useSyncExternalStore`
- `<DatasetProvider defaultDataset>` — loads the saved dataset
  from `loadSettings()` on mount and pushes it into the store
- Pair with `<Outlet key={dataset} />` in your shell so route
  subtrees fully remount on dataset change.

**Provisioning UI** (`@cribl/app-utils/provisioning-panel`,
`/provisioning-banner`)

- `<ProvisioningPanel>` — Settings-page diff → preview → apply
  flow with a two-click "Unprovision all" escape hatch
- `<Banner>` + `useProvisioningBanners(sources)` — persistent
  banners at the top of any page when provisioning is incomplete.
  Router-agnostic — caller supplies their own `<Link>` to the
  Settings page.

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

**Styles**

- `styles/tokens.css` — Cribl Design System custom properties
- `styles/base.css` — CSS reset + base element styles

**Runtime containment**

- `<ResilienceBoundary>` — router-free root/panel render containment
  with retry and an optional app-owned fallback renderer

### @criblio/cell-harness

**A long session used to die silently, and nothing bounded its history.**
Both are fixed; the policy and how to reverse it are in
`packages/cell-harness/CONTEXT.md`, which is the file to read before
touching `compaction.ts`, `history()`, or the turn runner's terminal
conditions. Three facts worth carrying without reading it:

- **An empty assistant message is a failure, not an answer.** `done` is
  computed from "no tool calls", so an empty reply used to be
  indistinguishable from "the model is finished" — the session appended
  `done` and parked at `idle` reporting success, with no error frame.
  `classifyReply()` names that case (and `finish_reason: length` with
  nothing in it); both take the failed-turn path, are not persisted, and
  get one compact-then-retry before failing out loud.
- **Compaction is a separate alarm step, never part of a turn.** A
  summarizer call inside the turn it protects adds its latency to the
  same ~300s handler budget, and blowing that kills the celld *process*.
  If the summarizer fails, the cut happens anyway with a mechanical
  digest — an outage there must not park a session.
- **`contextWindow` is inert.** pi-agent-core never reads it (its own
  default is 0), so it clamps nothing; a 205k-token prompt was measured
  going out and being served. Its real job is being the number every
  compaction threshold derives from, which is what makes "use the
  model's bigger window" a config change (`LLM_CONTEXT_WINDOW`) rather
  than a code change. Raising it alone buys nothing.

### @cribl/app-tooling

Node-only commands shared by every consumer app:

- `cribl-app-package` — deterministic Cribl App tgz construction
- `cribl-app-inspect` — archive shape, manifest, static asset, and
  optional proxy policy validation: `--require-empty-proxies`, or
  `--proxies-manifest <path>` to deep-compare the packaged
  `proxies.yml` against a committed expected manifest (any extra or
  missing domain, path entry, injected header, or timeout fails;
  an empty manifest is equivalent to `--require-empty-proxies`)
- `cribl-app-deploy` — exact-artifact upload, server preinstall policy,
  idempotent install/upgrade without force, and optional provisioning
- `cribl-app-release-evidence` — checksum, source/framework metadata,
  and deterministic production CycloneDX SBOM
- `cribl-app-security` — SHA-pinned Action, dependency-license, and
  tracked-secret gates

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
   as versioned deps from GitHub Packages, so framework changes reach
   them through a publish plus a semver bump — not a `file:` path or a
   SHA pin. Skeleton CI installs from the registry the same way, which
   is what keeps the template honest about what a real app resolves.
4. Run `npm test && npm run typecheck` inside `packages/app-utils/`;
   consumers run their own lint + build as an integration gate.

**A version bump takes TWO PRs, and the second one is the skeleton.**
The `skeleton` CI job scaffolds the template and `npm install`s from
GitHub Packages, so `skeleton/package.json` may only name a version that
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
