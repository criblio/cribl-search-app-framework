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
3. Run `npm install`.
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

## Working in this repo

The framework itself doesn't ship a CI workflow (the **skeleton**
does — that workflow ships into every consumer app). When making
framework changes:

1. Edit `packages/app-utils/src/*` for the shared library.
2. Edit `skeleton/*` for the clone-ready template. Changes here
   ship to every NEW app, but do NOT auto-propagate to existing
   apps — those copies were taken at scaffold time.
3. Existing consumer apps (APM, Customer Analytics) pull
   `@cribl/app-utils` via `file:` paths in their `package.json`,
   so library changes are immediately visible to them — no publish
   step.
4. Run `npm test && npm run typecheck` inside `packages/app-utils/`;
   consumers run their own lint + build as an integration gate.

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
