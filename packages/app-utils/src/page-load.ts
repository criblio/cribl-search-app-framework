/**
 * Page-level load lifecycle: `usePageLoad`.
 *
 * Distilled from APM's Overview page. Three behaviours, each a fix:
 *
 * - **Full loading state only on the first load.** Later loads keep the
 *   last data on screen (`phase: 'refreshing'`); clearing to skeletons on
 *   every range change or poll made the layout jump and a 60 s poll flash
 *   the whole page every minute.
 * - **Generation-guarded.** Each load calls `newQueryGeneration()` (which
 *   aborts the previous load's in-flight reads) and every state update is
 *   dropped once a newer load, a deps change or an unmount supersedes it —
 *   a 1h result settling after the user picked 15m used to overwrite it.
 * - **Aborted reads are never failures.** A superseded read rejects with
 *   an abort ("Search was canceled"); reporting it painted an error banner
 *   over the view that replaced it.
 *
 * Failures are keyed by panel. The previous load's failures stay visible
 * while a new load runs (resetting them at the start made the banner
 * flicker off and on with every poll); when a load settles, the keys the
 * LOAD owns become exactly what that load reported. Render them with
 * `<PartialFailureBanner>` from `@criblio/app-utils/partial-failure-banner`.
 *
 * Two escape hatches, both from APM adopting this hook:
 *
 * - **`silentFailures: 'keep'`.** A silent poll (`refresh({ silent: true })`)
 *   neither shows nor clears load failures: its `fail`/`ok` are no-ops and
 *   its settle leaves them as they were. APM's Alerts page polls every 30 s
 *   and a transient poll error must not flash a banner, nor a lucky poll
 *   hide a real one. The default, `'replace'`, treats a silent run like any
 *   other. `ctx.silent` tells the loader which kind of run it is.
 * - **`report(key, err | null, token?)`.** Failures from sibling effects
 *   outside the loader (APM ServiceDetail's deferred panels, alert history,
 *   metric cards). They are owned separately: a settling load replaces only
 *   its own keys, so it no longer wipes theirs, and only `report(key, null)`
 *   clears them. Pass `token()` captured when the effect started to drop a
 *   report from before a deps change or an unmount.
 *
 * Its own subpath, not part of `/query-generation`: that module is
 * React-free and reachable from workerd cells (`agent-tools` → `metrics`
 * → `search`), and must stay importable without React.
 *
 * Use ONE `usePageLoad` per page. The query generation is module-global,
 * so a second loader (or a shell component) starting loads would abort
 * this one's reads; persistent shell components pass their own signal.
 */
import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import {
  captureQueryGeneration,
  currentQuerySignal,
  newQueryGeneration,
} from './query-generation.js';

export type PageLoadPhase = 'initial' | 'refreshing' | 'idle';

export interface PageLoadContext {
  /** True for a `refresh({ silent: true })` run (polling). With
   *  `silentFailures: 'keep'`, `fail` and `ok` are no-ops in such a run. */
  silent: boolean;
  /** This load's generation signal; aborted when a newer load starts.
   *  `runQuery` already defaults to it — pass it to other reads. */
  signal: AbortSignal;
  /** False once a newer load, a deps change or an unmount superseded this
   *  one. Guard every `setState` of your own with it. */
  isCurrent: () => boolean;
  /** Record `key`'s failure. Ignored when superseded or when `error` is an
   *  abort. */
  fail: (key: string, error: unknown) => void;
  /** Clear `key`'s failure now rather than when the load settles. */
  ok: (key: string) => void;
}

export type PageLoadFn = (ctx: PageLoadContext) => Promise<void>;

export interface PageLoadState {
  /** `initial` until the first load settles; `refreshing` during a later
   *  non-silent load; `idle` otherwise. */
  phase: PageLoadPhase;
  /** Panel key → error message. */
  failures: Readonly<Record<string, string>>;
  /** `Date.now()` when the last load settled, for an "Updated 12s ago"
   *  stamp; `null` before the first. */
  updatedAt: number | null;
}

export interface PageLoad extends PageLoadState {
  /** Re-run the load, showing `refreshing`. Stable identity. */
  retry: () => void;
  /** Re-run the load; `{ silent: true }` (for polling) leaves `phase`
   *  alone. Stable identity. */
  refresh: (options?: { silent?: boolean }) => void;
  /** Record (`error`) or clear (`null`) a failure from OUTSIDE the loader.
   *  Externally reported keys survive a settling load. Ignored when `error`
   *  is an abort, or when `token` is given and stale. Stable identity. */
  report: (key: string, error: unknown, token?: number) => void;
  /** The current deps generation, for `report`: it changes when the page's
   *  deps change or it unmounts, NOT on retry/refresh. Stable identity. */
  token: () => number;
}

/** How a silent run (`refresh({ silent: true })`) treats load failures. */
export type SilentFailurePolicy = 'replace' | 'keep';

export interface PageLoadOptions {
  /** Failure key used when `load` itself rejects. Default `'Page data'`. */
  errorKey?: string;
  /** `'replace'` (default): a silent run reports and settles failures like
   *  any other. `'keep'`: a silent run can neither show nor clear a load
   *  failure; only a non-silent run (mount, deps change, `retry`) changes
   *  them. Externally `report`ed failures are unaffected either way. */
  silentFailures?: SilentFailurePolicy;
}

export interface PageLoadController {
  run: (silent?: boolean) => Promise<void>;
  /** Supersede any in-flight load without starting another, and advance
   *  the deps generation `token()` reports (deps change, unmount). */
  invalidate: () => void;
  getState: () => PageLoadState;
  /** See `PageLoad.report`. */
  report: (key: string, error: unknown, token?: number) => void;
  /** See `PageLoad.token`. */
  token: () => number;
}

export const INITIAL_PAGE_LOAD_STATE: PageLoadState = Object.freeze({
  phase: 'initial',
  failures: Object.freeze({}),
  updatedAt: null,
});

/** An abort is a cancellation, not a failure: the generation signal fired,
 *  a DOM `AbortError`, or a `SearchJobError` of kind `aborted`. */
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { name?: unknown; kind?: unknown };
  return e.name === 'AbortError' || e.kind === 'aborted';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The framework-free state machine behind `usePageLoad`, exported for
 * tests and for non-React hosts. `onChange` receives every new state.
 */
export function createPageLoadController(
  load: PageLoadFn,
  onChange: (state: PageLoadState) => void,
  options?: PageLoadOptions,
): PageLoadController {
  const errorKey = options?.errorKey ?? 'Page data';
  const keepOnSilent = options?.silentFailures === 'keep';
  let state = INITIAL_PAGE_LOAD_STATE;
  let runId = 0;
  let epoch = 0;
  let hasData = false;
  // Two owners, published merged. The load's keys are replaced when a load
  // settles; external keys change only through `report`.
  let owned: Record<string, string> = {};
  let external: Record<string, string> = {};

  const set = (next: Partial<PageLoadState>): void => {
    state = { ...state, ...next };
    onChange(state);
  };
  const merged = (): Record<string, string> => ({ ...owned, ...external });
  const publish = (next: Partial<PageLoadState> = {}): void =>
    set({ ...next, failures: merged() });

  const run = async (silent = false): Promise<void> => {
    newQueryGeneration();
    const generationLive = captureQueryGeneration();
    const signal = currentQuerySignal();
    const id = ++runId;
    const isCurrent = (): boolean => id === runId && generationLive();
    // A silent run under 'keep' never touches the load's failures.
    const frozen = silent && keepOnSilent;
    const reported: Record<string, string> = {};

    const ctx: PageLoadContext = {
      silent,
      signal,
      isCurrent,
      fail: (key, error) => {
        if (frozen || !isCurrent() || isAbort(error, signal)) return;
        reported[key] = message(error);
        owned = { ...owned, [key]: reported[key]! };
        publish();
      },
      ok: (key) => {
        if (frozen || !isCurrent()) return;
        delete reported[key];
        if (!(key in owned)) return;
        owned = { ...owned };
        delete owned[key];
        publish();
      },
    };

    if (!silent && hasData && state.phase !== 'refreshing') set({ phase: 'refreshing' });
    try {
      await load(ctx);
    } catch (error) {
      ctx.fail(errorKey, error);
    }
    if (!isCurrent()) return;
    hasData = true;
    if (!frozen) owned = { ...reported };
    publish({ phase: 'idle', updatedAt: Date.now() });
  };

  const report = (key: string, error: unknown, token?: number): void => {
    if (token !== undefined && token !== epoch) return;
    // Only `null` clears: a rejection with an `undefined` reason is still a failure.
    if (error === null) {
      if (!(key in external)) return;
      external = { ...external };
      delete external[key];
    } else {
      if (isAbort(error)) return;
      external = { ...external, [key]: message(error) };
    }
    publish();
  };

  return {
    run,
    invalidate: () => { runId++; epoch++; },
    getState: () => state,
    report,
    token: () => epoch,
  };
}

/**
 * Run `load` on mount and whenever `deps` change; return the lifecycle.
 *
 * `load` receives `{ silent, signal, isCurrent, fail, ok }`. Start every panel's
 * read inside it, guard your `setState`s with `isCurrent()`, report each
 * panel's error with `fail(key, err)`, and return a promise that settles
 * when every panel has (await them, or `Promise.allSettled`) — `phase`
 * goes `idle` and `failures` is replaced when it does. The latest `load`
 * is always used, so it may close over fresh props without being a dep;
 * `deps` lists what should trigger a reload (range, filters, dataset).
 *
 * ```tsx
 * const [range] = useRangeParam('-1h');
 * const { phase, failures, retry } = usePageLoad(async ({ isCurrent, fail }) => {
 *   await Promise.allSettled([
 *     runQuery(RATE_KQL, range, 'now', 100)
 *       .then((rows) => { if (isCurrent()) setRate(rows); })
 *       .catch((e) => fail('Request rate', e)),
 *     runQuery(ERRORS_KQL, range, 'now', 50)
 *       .then((rows) => { if (isCurrent()) setErrors(rows); })
 *       .catch((e) => fail('Recent errors', e)),
 *   ]);
 * }, [range]);
 * // phase === 'initial' → skeletons; 'refreshing' → keep data, dim it.
 * // <PartialFailureBanner failures={failures} onRetry={retry} />
 * ```
 *
 * A sibling effect outside the loader reports into the same map:
 *
 * ```tsx
 * const { report, token } = pageLoad;
 * useEffect(() => {
 *   const t = token(); // after this commit's deps-change invalidation
 *   loadAlertHistory(service, range)
 *     .then(() => report('Alert history', null, t))
 *     .catch((e) => report('Alert history', e, t));
 * }, [service, range, report, token]);
 * ```
 *
 * Pass the token only when the effect re-runs whenever the page's deps
 * change (its deps include them): a token from an effect that does NOT
 * re-run goes stale on the next deps change and its report is dropped for
 * good. Otherwise omit it and guard with the effect's own cleanup flag.
 */
export function usePageLoad(
  load: PageLoadFn,
  deps: DependencyList,
  options?: PageLoadOptions,
): PageLoad {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [state, setState] = useState<PageLoadState>(INITIAL_PAGE_LOAD_STATE);
  const controllerRef = useRef<PageLoadController | null>(null);
  controllerRef.current ??= createPageLoadController(
    (ctx) => loadRef.current(ctx),
    setState,
    options,
  );
  const controller = controllerRef.current;

  useEffect(() => {
    void controller.run(false);
    return controller.invalidate;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the caller's
  }, deps);

  const retry = useCallback(() => { void controller.run(false); }, [controller]);
  const refresh = useCallback(
    (opts?: { silent?: boolean }) => { void controller.run(opts?.silent ?? false); },
    [controller],
  );
  return { ...state, retry, refresh, report: controller.report, token: controller.token };
}
