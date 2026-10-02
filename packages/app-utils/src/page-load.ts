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
 * flicker off and on with every poll); when a load settles, `failures`
 * becomes exactly what that load reported. Render them with
 * `<PartialFailureBanner>` from `@criblio/app-utils/partial-failure-banner`.
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
}

export interface PageLoadOptions {
  /** Failure key used when `load` itself rejects. Default `'Page data'`. */
  errorKey?: string;
}

export interface PageLoadController {
  run: (silent?: boolean) => Promise<void>;
  /** Supersede any in-flight load without starting another. */
  invalidate: () => void;
  getState: () => PageLoadState;
}

export const INITIAL_PAGE_LOAD_STATE: PageLoadState = Object.freeze({
  phase: 'initial',
  failures: Object.freeze({}),
  updatedAt: null,
});

/** An abort is a cancellation, not a failure: the generation signal fired,
 *  a DOM `AbortError`, or a `SearchJobError` of kind `aborted`. */
function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
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
  let state = INITIAL_PAGE_LOAD_STATE;
  let runId = 0;
  let hasData = false;

  const set = (next: Partial<PageLoadState>): void => {
    state = { ...state, ...next };
    onChange(state);
  };

  const run = async (silent = false): Promise<void> => {
    newQueryGeneration();
    const generationLive = captureQueryGeneration();
    const signal = currentQuerySignal();
    const id = ++runId;
    const isCurrent = (): boolean => id === runId && generationLive();
    const reported: Record<string, string> = {};

    const ctx: PageLoadContext = {
      signal,
      isCurrent,
      fail: (key, error) => {
        if (!isCurrent() || isAbort(error, signal)) return;
        reported[key] = message(error);
        set({ failures: { ...state.failures, [key]: reported[key]! } });
      },
      ok: (key) => {
        if (!isCurrent()) return;
        delete reported[key];
        if (!(key in state.failures)) return;
        const failures = { ...state.failures };
        delete failures[key];
        set({ failures });
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
    set({ phase: 'idle', failures: { ...reported }, updatedAt: Date.now() });
  };

  return {
    run,
    invalidate: () => { runId++; },
    getState: () => state,
  };
}

/**
 * Run `load` on mount and whenever `deps` change; return the lifecycle.
 *
 * `load` receives `{ signal, isCurrent, fail, ok }`. Start every panel's
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
  return { ...state, retry, refresh };
}
