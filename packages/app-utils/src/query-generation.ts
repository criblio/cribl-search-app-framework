/**
 * Navigation-scoped query cancellation.
 *
 * The browser caps concurrent connections per host (~6). A data-dense
 * page fires many reads at once — fast metrics queries AND slow KQL
 * search jobs (create → poll → poll → … → results, many round-trips
 * each). Without cancellation, the PREVIOUS view's in-flight requests
 * keep hogging connections (and a KQL job keeps a worker-pool slot +
 * keeps polling) after the user navigates away, starving the new view.
 *
 * Each view calls `newQueryGeneration()` at the start of its data
 * fetch. That aborts the prior generation's signal, which:
 *   - cancels in-flight metrics `fetch`es (they pass this signal), and
 *   - makes the search-job runner abort its create/results fetch and
 *     break its poll loop, releasing the connections + worker slot.
 *
 * The framework's `runQuery` (and any read that calls
 * `withGenerationSignal`) defaults to the current generation, so an app
 * gets nav-scoped cancellation just by calling `newQueryGeneration()`
 * on navigation. An app that never calls it keeps the single initial
 * controller, whose signal never aborts — so the default is a no-op and
 * fully backward compatible.
 *
 * Callers may still pass an explicit AbortSignal for finer scoping; the
 * generation signal is only the default when none is given.
 *
 * The controller is created ON FIRST USE, not at module scope. A workerd
 * isolate (celld, Cloudflare Workers) forbids "generating random values"
 * and I/O setup in global scope, and it counts `new AbortController()` as
 * such — so an eager one killed the whole worker at startup with
 * "Disallowed operation called within global scope", pointing at a line
 * in a bundle rather than at this file. This module is reachable from
 * `agent-tools` → `metrics` → `search`, so any cell that imports a
 * search tool imports it. Nothing here needs to exist before the first
 * call, so it doesn't.
 */
let controller: AbortController | undefined;

function current(): AbortController {
  return (controller ??= new AbortController());
}

/** Abort the previous generation's in-flight queries and start a new one. */
export function newQueryGeneration(): void {
  current().abort();
  controller = new AbortController();
}

/** The current generation's signal — the default for reads that don't
 *  pass their own. */
export function currentQuerySignal(): AbortSignal {
  return current().signal;
}

/** Prefer an explicit per-call signal; otherwise use the current
 *  navigation generation so nav cancels the read. */
export function withGenerationSignal(signal?: AbortSignal): AbortSignal {
  return signal ?? current().signal;
}

/**
 * Snapshot the current generation and return a predicate that reports
 * whether it is still the live one. A view captures this at the top of
 * its fetch (right after `newQueryGeneration()`) and guards every async
 * `setState` with it, so a stale read that resolves late — including an
 * aborted metrics read that now resolves to `[]` — cannot clobber the
 * data of the navigation that superseded it.
 */
export function captureQueryGeneration(): () => boolean {
  const mine = current().signal;
  return () => !mine.aborted;
}
