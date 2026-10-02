/**
 * Module-level stores with a React hook.
 *
 * App state that non-React code must read — a feature flag consulted by a
 * query builder, a provisioning option, the active dataset — lives in a
 * module-level value with subscribers, not in React context. This is that
 * value, written once: `get` / `set` (no-op when unchanged) / `subscribe`,
 * plus `useStore()` to re-render a component when it changes.
 *
 * ```ts
 * // src/api/lowVolumeMode.ts — OFF by default: KV unreachable ⇒ feature dark.
 * export const lowVolumeMode = createStore(false);
 *
 * // in a component
 * const enabled = useStore(lowVolumeMode);
 * ```
 *
 * There is deliberately no `createFlag`: a boolean flag is
 * `createStore<boolean>(default)`, and the property that mattered in APM's
 * flag factory — the default is an explicit, required argument — is already
 * the signature of `createStore`.
 */

import { useSyncExternalStore } from 'react';
import type { Store } from './create-store.js';

export { createStore, type Store } from './create-store.js';

/**
 * React hook: the store's current value, re-rendering when it changes.
 * Built on `useSyncExternalStore`, so it is tear-free under concurrent
 * rendering and returns the same value during server rendering.
 */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
