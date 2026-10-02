/**
 * Page state in the URL: `useQueryParam` and `useRangeParam`.
 *
 * State a user would want to keep across a drill-down, a reload, the back
 * button or a shared link (time range, filters, selected tab) belongs in
 * the query string, not in `useState`. APM's pages each owned their own
 * range state, so clicking from Home (15m) into a detail page reset the
 * picker to 1h and users re-picked 15m on every drill-down.
 *
 * Every setter here makes exactly ONE functional `setSearchParams` write.
 * React Router's setter does not queue the way React's `setState` does:
 * each call navigates from the params of the render it closed over, so two
 * writes in one handler lose one. APM's System Architecture page cleared a
 * legacy `?lookback=` with one write and set `?range=` with another; the
 * second write restored `lookback`, and picking the default 1h from an old
 * `?lookback=-15m` bookmark left the page at 15m (APM PR #185). The legacy
 * keys are therefore dropped inside the same write that sets the value.
 * The corollary for callers: two different `useQueryParam` setters called
 * in one handler still race — keep values a handler changes together in
 * one param, or write them with one `setSearchParams` of your own.
 *
 * This is the ONLY module in `@criblio/app-utils` that imports a router.
 * `react-router-dom` is an optional peer dependency used by this subpath
 * alone — the same specifier the skeleton imports, so a bundler (or esm.sh)
 * resolves one router instance and one context. Never re-export this from
 * the package root.
 */
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface QueryParamOptions {
  /**
   * Older names for the same value, read in order as fallbacks when the
   * canonical param is absent, and always removed by the setter in the
   * same write that sets or omits the canonical param.
   */
  legacy?: readonly string[];
  /**
   * `replace` (default) rewrites the current history entry so a picker
   * does not fill the back stack; `push` adds an entry, for state the back
   * button should step through (a selected tab, a drill-down target).
   */
  history?: 'replace' | 'push';
}

const NO_LEGACY: readonly string[] = [];

/**
 * The next query string for one param update: set `name` to `value`, or
 * omit it when `value` equals `defaultValue` (clean URLs for untouched
 * pages), and delete every legacy key. Pure; exported for tests and for
 * callers composing their own single write.
 */
export function nextSearchParams(
  prev: URLSearchParams,
  name: string,
  value: string,
  defaultValue: string,
  legacy: readonly string[] = NO_LEGACY,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const key of legacy) next.delete(key);
  if (value === defaultValue) next.delete(name);
  else next.set(name, value);
  return next;
}

/**
 * A string query param with a default. Returns `[value, setValue]`, where
 * `value` is `?name=`, else the first present legacy key, else
 * `defaultValue`. `setValue` makes one functional write (see module doc).
 *
 * Pass `legacy` as a module-level constant or a memoized array: a fresh
 * array literal each render gives `setValue` a new identity every render.
 */
export function useQueryParam(
  name: string,
  defaultValue: string,
  options?: QueryParamOptions,
): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams();
  const legacy = options?.legacy ?? NO_LEGACY;
  const replace = (options?.history ?? 'replace') === 'replace';

  let value = params.get(name);
  for (const key of legacy) value ??= params.get(key);

  const setValue = useCallback(
    (next: string) => {
      setParams((prev) => nextSearchParams(prev, name, next, defaultValue, legacy), { replace });
    },
    [setParams, name, defaultValue, legacy, replace],
  );

  return [value ?? defaultValue, setValue];
}

/**
 * The page's lookback range as `?range=` (e.g. `-15m`), defaulting to
 * `defaultRange`. Pair the value with `TIME_RANGES` / `binSecondsFor` from
 * `@criblio/app-utils/time`.
 */
export function useRangeParam(
  defaultRange: string,
  options?: QueryParamOptions,
): [string, (range: string) => void] {
  return useQueryParam('range', defaultRange, options);
}
