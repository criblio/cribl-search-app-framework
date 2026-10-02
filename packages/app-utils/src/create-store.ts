/**
 * The React-free half of `@criblio/app-utils/store`.
 *
 * Kept separate so modules that also run in the Node provisioning script
 * (`cadence.ts`) can build on the store without importing `react`. Apps
 * import `createStore` from `@criblio/app-utils/store`; this file is not a
 * public subpath.
 */

/** A module-level value with change notification. */
export interface Store<T> {
  /** Current value. */
  get(): T;
  /** Replace the value and notify subscribers. No-op if `Object.is` equal. */
  set(value: T): void;
  /** Subscribe to changes. Returns the unsubscribe function. */
  subscribe(fn: (value: T) => void): () => void;
}

/**
 * Create a store holding `initial`.
 *
 * `initial` is required on purpose: APM hand-copied this store per flag and
 * the copies drifted to different defaults (metrics flags default-true, the
 * rest default-false); "KV unreachable ⇒ feature dark" only holds when every
 * store states its own default.
 *
 * A listener that throws is swallowed so the remaining listeners still see
 * the change — one broken subscriber must not freeze every other view.
 */
export function createStore<T>(initial: T): Store<T> {
  let current = initial;
  const listeners = new Set<(value: T) => void>();

  return {
    get: () => current,

    set(value: T): void {
      if (Object.is(value, current)) return;
      current = value;
      for (const l of listeners) {
        try {
          l(value);
        } catch {
          /* listener errors shouldn't block others */
        }
      }
    },

    subscribe(fn: (value: T) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
