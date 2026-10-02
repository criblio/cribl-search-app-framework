# Cribl App Development Skill

Use this skill when working on Cribl Search App packs (Vite + React
+ TypeScript apps that run inside the Cribl Search iframe).

## Platform rules

### Fetch proxy
The Cribl host wraps `window.fetch()` to:
- Inject auth headers (your app never handles tokens)
- Rewrite pack-scoped URLs to the correct API endpoint
- Route external domain calls through `proxies.yml`
- Apply a 30-second timeout

### proxies.yml
Every external domain your app calls must be declared in
`config/proxies.yml` with path allowlists and header injection.
Calls to undeclared domains return a JSON error, not a network error.

### Globals
- `window.CRIBL_API_URL` — full URL to `/api/v1` (injected by host)
- `window.CRIBL_BASE_PATH` — React Router basename (e.g., `/app-ui/mypack/`)
- `window.getCriblUser()` — memoized Promise of the signed-in member
  (`{ id, username, email?, firstName?, lastName?, initials? }`). Call
  once at startup. Identity only: **no roles or permissions**, and it
  never leaves the browser (no signed token, and `proxies.yml` injection
  can't assert a user), so it's for separating members' data — per-member
  KV keys, an avatar — not for gating access. Let the API enforce that.

### React Router
Always use `basename={window.CRIBL_BASE_PATH}` on `<BrowserRouter>`.

### Route conflicts
Avoid `/settings` in pack routes — the Cribl host shell intercepts
paths containing "settings".

### KV store
Pack-scoped key-value store at `CRIBL_API_URL + '/kvstore/...'`.
- Use `content-type: text/plain` for PUT (JSON content-type causes
  the value to be served back as `[object Object]`)
- 404 on missing keys — normalize to `null`

### Notification targets
Product-level notification targets (Slack, PagerDuty, email, webhooks)
are available at `GET /api/v1/notification-targets`. They're configured
by the Cribl admin and shared across Stream and Search. Reference them
by ID — never ask users to paste webhook URLs into your app.

## KQL caveats

### Known crashes
- `(?i)` inline regex flag crashes in complex pipelines (summarize +
  extend + negation). Use character-class alternation `[Cc]onsume`
- `summarize → summarize max(iff(...))` crashes on real data (works
  on synthetic rows, fails on 36+ real rows from a prior summarize).
  Split into separate searches joined via lookups.

### Unsupported functions
- `any()` — not supported in all Cribl Search versions. Use `max()`
- `percentileif()` — not available. Use conditional filtering before
  `percentile()`

### Operators
- `| lookup <name> on <columns>` — LEFT JOIN against a lookup table
- `| export mode=overwrite to lookup <name>` — write to lookup
  (consumes rows — they don't go to `$vt_results`)
- An overwrite export of zero rows can delete the lookup file. Start the
  query with the sentinel: `print k="__sentinel__" | union (<real query>)
  | export mode=overwrite to lookup <name>` — the reverse order
  (`<real> | union (print …)`) skips the export when `<real>` is empty
- `mv-expand` upstream of `export to lookup` fails the write; split into
  a compute search and an export search
- `| export tee=true to search "<dataset>"` — write result rows back
  to a dataset as durable events (`tee=true` also passes them to
  `$vt_results`). Use `exportToSearchClause` from
  `@criblio/app-utils/generated-events`. Do NOT use
  `| send group="search"`: it silently stopped persisting (the job
  completes, nothing lands), and rows it did write stored `datatype`
  as `data_datatype` — read with `STORED_DATATYPE_EXPR`, which
  coalesces both.
- `| export to metrics …` — the job reports `completed` even when it
  drops every event. Read `eventsOut`/`eventsDropped`/`dropReasons`
  from its result row (`readExportStats` in
  `@criblio/app-utils/metrics-backfill`).
- `$vt_results` — read scheduled search output. Filter by `jobName`.
- `ago(1h)` — works for time splitting within queries

### Query patterns
- Two-window comparison: use separate searches for current and previous
  windows, join via lookup. Don't try to pivot with `max(iff(...))`.
- State machine in KQL: `case()` with `iff()` for conditional logic,
  `| lookup` for previous state, `| export to lookup` for persistence.

## Sandboxed iframe constraints

- **No `allow-downloads`** — can't trigger file downloads via
  `<a download>`
- **No `allow-popups`** — `window.open()` blocked
- **CSP blocks `blob:` URLs for images** — use `data:` URLs instead
- **Cross-origin frame access blocked** — don't use `html2canvas` or
  libraries that traverse `window.parent`
- **DOM-to-PNG**: use SVG foreignObject with inline styles. Clone the
  DOM, inline all computed styles, serialize to SVG, render to canvas.

## Scheduled search patterns

### Provisioning
Declare searches in a plan file. The provisioner diffs against the
server and creates/updates/deletes as needed. Choose a pack-specific
prefix (e.g., `mypack__`) for managed search IDs to avoid touching
user-created searches.

### Plan guard
Never apply a plan nobody validated. `reconcile`, `planOnly` and
`<ProvisioningPanel>` run `validateProvisionPlan` from
`@criblio/app-utils/provision-guard` by default and refuse a failing
plan with `ProvisionPlanError`; add a CI test that calls it on your real
plan so a bad search fails the build, not a user's Apply:

```ts
import { validateProvisionPlan } from '@criblio/app-utils/provision-guard';
expect(validateProvisionPlan(getPlan(), { prefix: 'myapp__', seedLookups: SEEDS }).problems).toEqual([]);
```

App-specific rules go in `ProvisionerConfig.validate`; they add to the
built-in rules. Disable a single misfiring rule with
`guard: { disableRules: ['…'] }` rather than `guard: false`.

### Panel caching
Scheduled searches write to `$vt_results`. Read all panels in one
batched job with `readVtResults(jobNames)` from
`@criblio/app-utils/vt-results`; a missing key is a cache miss — fall
back to the live query:

```ts
const cached = await readVtResults(['myapp__summary', 'myapp__series']);
const summary = cached.get('myapp__summary') ?? await runQuery(liveSummaryKql);
```

### Post-reconcile canary
After provisioning, prove the searches produce:
`runProvisionCanary(http, { sentinelSearchId, lookupProbe, firstInstall })`
from `@criblio/app-utils/provision-canary`, or pass the same options as
`<ProvisioningPanel canary={…}>`.

### Notifications
Bind a scheduled search to a notification target with
`ensureSavedSearchNotification(http, { searchId, targetId, conf })` from
`@criblio/app-utils/notifications`, or declare
`ProvisionerConfig.notifications`. `schedule.notifications` in the
saved-search body is silently dropped by the server.

### Lookup seeding
`| export to lookup` requires the lookup to exist at search creation
time. Seed lookups with an init query in the provisioner before
creating searches that reference them.

### Alert state machine
One evaluator search, no mutable state lookup:
1. Previous-window summary → export to lookup (the baseline)
2. Evaluator → computes `is_bad` per alert, joins the latest persisted
   evaluation event for `prev_status`/`prev_bad`/`prev_good`/
   `prev_fire_count`, applies the state machine, and writes the result
   rows with `| export tee=true to search "<dataset>"` — the durable
   history and the UI's `$vt_results` in one write.

Lifecycle: ok → pending → firing → resolving → ok, plus pending → ok
(a flap that never fired) and resolving → firing (a relapse, not a new
fire). Generate the KQL with `alertStateKql({ fireAfter, clearAfter })`
from `@criblio/app-utils/alert-state` and reason about it in TS with
`nextAlertState` — the two share one arm table, so they cannot drift.
An alert arm that only emits rows while bad never sees a good
evaluation and so never resolves: emit a row for every evaluated key.
Prove the event write path after provisioning with
`runGeneratedEventCanary`.

### Cadence
Make scheduled search cadence configurable via a Settings page
dropdown. Store in KV, read by both browser and CLI provisioners.
Derive eval cadence (1 minute offset) from panel cadence so the
evaluator runs after the data it depends on is available — with
`offsetCron(getSearchCadenceCron(), 1)` from `@criblio/app-utils/cadence`,
not a regex. Rewriting `* * * * *` to `1 * * * *` turns the 1m cadence
into an hourly one; `offsetCron` leaves every-minute alone and shifts
`*/5` to `1-59/5`.

## UI patterns

### Non-destructive refresh
Never set all loading states to `true` at the start of a refresh.
Keep existing data visible while new queries run. Only show skeletons
on the initial load (no data yet). Each panel updates in place when
its query resolves. Show a thin progress bar to indicate a refresh
is in progress.

Use `usePageLoad` (`@criblio/app-utils/page-load`) rather than writing
this by hand. It starts a query generation per load (aborting the last
one's reads), drops results and failures from superseded loads, never
reports an aborted read as a failure, and only reports `initial` before
the first load settles:

```tsx
const { phase, failures, retry, refresh } = usePageLoad(async ({ isCurrent, fail }) => {
  await Promise.allSettled([
    runQuery(RATE_KQL, range, 'now', 100)
      .then((rows) => { if (isCurrent()) setRate(rows); })
      .catch((e) => fail('Request rate', e)),
  ]);
}, [range]);
// phase: 'initial' → skeletons; 'refreshing' → keep data, dim it; 'idle'.
// Polling: setInterval(() => refresh({ silent: true }), 60_000)
```

### Partial failures are not health
A failed query must never render as an empty table or "0 errors". Show
`<PartialFailureBanner failures={failures} onRetry={retry} />`
(`@criblio/app-utils/partial-failure-banner`, Capra) above the panels —
it says "Empty values below are not evidence of health" and names each
failed panel — and render a failed panel's values as unknown, not zero.

### Page state lives in the URL
Range, filters and tabs go in the query string so drill-downs, reloads,
back/forward and shared links keep them: `useRangeParam('-1h')` /
`useQueryParam(name, default, { legacy, history })` from
`@criblio/app-utils/url-state` (needs `react-router-dom`). Each setter is
one functional `setSearchParams` write. React Router builds every write
from the current render's params, so two writes in one handler lose one —
never write the same URL twice in a handler. Pick ranges from
`TIME_RANGES`, bin with `binSecondsFor(range)`, and compare against
`previousWindow(range)` from `@criblio/app-utils/time`.

### Bounded search fan-out
Never fire one search per item with a bare `Promise.all`. Cribl Search
allows ~20 concurrent jobs per cluster (`Search queue limit reached
(max: 20)`), the page already holds several, and the overflow returns
429s — APM's 22-query Spotlight did exactly that. Use
`runWithLimit(items, SEARCH_FANOUT_LIMIT, worker, { signal })` from
`@criblio/app-utils/search` (or `runWithLimitSettled` for per-item
errors); results come back in input order and one failure never stops
the rest.

### Shared app state
Feature flags and other values that query builders read outside React
belong in `createStore(initial)` from `@criblio/app-utils/store`, read
in components with `useStore(store)`. Give every flag an explicit
default that is safe when KV is unreachable — normally OFF, so a new
feature ships dark.

### Graph stability
When using d3-force or similar layout engines, compute a topology
key from node IDs + link endpoints. Only recreate the simulation
when topology changes. Data-only updates (same nodes, new metric
values) should mutate existing objects in place — no simulation
restart, no visual movement.

## Testing patterns

### CI
Run unit tests (Vitest), type checking (tsc --noEmit), and build
on every push/PR via GitHub Actions.

### Playwright (e2e)
- Auth via `installCriblHostGlobals(page)` which injects
  `CRIBL_BASE_PATH`, `CRIBL_API_URL`, and a Bearer token fetch
  wrapper via `addInitScript`
- Navigate with a helper function that prepends the pack base path
- Can't navigate directly to sub-routes (server returns 404) —
  must load the base path first, then use React Router navigation
  or click nav links

### KQL assertions
Use a `runQuery()` helper for server-side validation in tests:
```typescript
const rows = await runQuery('dataset="$vt_results" | where ...');
assert(rows.length > 0);
```

### Eval harness
Scenario-driven evaluation for detection quality:
1. Flip a feature flag (via flagd or similar)
2. Wait for telemetry to flow through the pipeline
3. Run surface checks (Playwright locators on the UI)
4. Run KQL checks (query polling for server-side state)
5. Optionally run an AI investigator for root-cause validation
6. Score = surface checks × 0.7 + investigator × 0.3

Run scenarios sequentially — staging worker pools can't handle
parallel query load. Allow 10+ minutes between scenarios for
signal decay from the previous scenario.

### Validate every UI change
Every new UI feature must be validated via Playwright against
staging before reporting it as done. Write a short script that
navigates, asserts key elements, and captures a screenshot.

## Performance review process

After making significant view/navigation changes, audit the data
loading patterns across all pages:

### Static code audit
1. List every page and what data it fetches
2. Check whether each fetch uses the panel cache ($vt_results
   batched read) or fires live queries
3. Flag pages that COULD read from cached scheduled search output
   but don't — these are easy wins
4. Check cache hit conditions: most caches only work on `-1h`
   range with stream filter enabled. Pages that always fire live
   queries regardless of range are candidates for caching.
5. Check for redundant fetches — data that's loaded on page A
   and then re-loaded when navigating to page B (consider
   lifting to a shared context or React Router loader)

### Eval framework performance checks
The eval harness should time each page load and flag slow ones:
1. Measure time from navigation to first meaningful content
2. Compare cached vs live query paths
3. Flag pages that take >3s on the cached path or >10s on live
4. Suggest specific scheduled searches that could cache the
   slow live queries

### Panel cache checklist
For each page, verify:
- [ ] Uses `listCachedXxxPanels()` on the default range
- [ ] Falls back to live queries on non-default ranges
- [ ] Shows stale-cache indicator when cache is old
- [ ] Non-destructive refresh (keeps previous data visible)

## Server-side agent sessions (GoatTown)

Use `@criblio/app-utils/goattown`. Do not write a session transport by
hand — the traps below are the reason this module exists, and each has
already shipped as a bug in an app that rolled its own.

### Knowing when a request is finished

```ts
import { GoatTownClient, observeSession, conclusionFromEntries } from '@criblio/app-utils/goattown';
import { applyLoopEvent } from '@criblio/app-utils/investigator';

const receipt = await client.sendMessage(id, 'is this a hot dog?');
let entries = [];
await observeSession(client, id, {
  requestId: receipt.requestId,
  onEvent: (ev) => { entries = applyLoopEvent(entries, ev); },
});
const answer = conclusionFromEntries(entries);
```

- **Never stop on `idle`.** It means "between turns" and is reached
  *before* the first answer as well as after the last one. Stopping there
  ends observation before the answer arrives, and an empty answer reads
  downstream as "couldn't tell" while the session looks perfect in
  GoatTown.
- **Never stop on `assistantDone`.** It ends one assistant *message*. A
  single request can span several tool and model rounds.
- **A terminal receipt is not a consumed one.** The service commits
  `complete` together with the final events; pages are bounded at 100
  frames, so the last page routinely arrives after the state flips. Drain
  until the cursor reaches `finalSeq`.
- **`execution: null` is not success.** It means legacy or untracked. Fall
  back to a terminal *session* status — never to `idle`.

### Reading the answer

The verdict is usually **not** in an assistant message. An agent with a
report tool puts it in the tool RESULT, so scanning assistant entries
returns `''` exactly when the agent did the recommended thing. Use
`conclusionFromEntries`, and check `source` before trusting an empty
result: `'none'` with a non-zero `entryCount` means events arrived and
none of them was an answer, which is a different bug from no events at
all.

### Events

Dedupe by service `seq` only — never by `turnId` or text, both of which
legitimately repeat. `userMessage` is wire-only: render it as the user's
own bubble and never feed it to `applyLoopEvent`, which has no case for
it and will drop it silently. Wire `error` carries `message: string` and
must become a real `Error`, or the error card renders blank.

### Images

Validate before sending; the advertised ceilings count **base64
characters, not decoded bytes**. A 422 `image_input_unavailable` means the
session's model has no vision — surface it. Retrying without the images
produces a confident answer about a picture the model never saw.

### Credentials

None in the browser. The platform proxy injects the app credential for
domains declared in `config/proxies.yml` and strips any `authorization`
the page sets, so a stored token adds no access and leaks a secret. If you
find a `kv.sharedCellToken`-style pattern, delete it.
