/**
 * Current-dataset store + React hook.
 *
 * Cribl Search Apps that target a configurable dataset (e.g. APM's
 * "otel", Customer Analytics' web-events dataset) need a shared
 * source of truth for "which dataset are we querying right now."
 *
 * Why module-level state instead of React context:
 *   - The dataset name is read by query builders that run inside
 *     non-React code (verbs invoked from useEffect callbacks).
 *     A module-level variable is reachable everywhere.
 *   - It changes rarely (via the Settings page) and triggers a
 *     coordinated re-fetch across many open components.
 *
 * Components that should re-fetch when the dataset changes can
 * subscribe via `useDataset()` which plugs this into React's
 * useSyncExternalStore.
 *
 * The mechanics are `createStore` (./create-store.ts); this module keeps
 * its own named API and trims the name before storing it.
 *
 * The companion <DatasetProvider> (./DatasetProvider.tsx) loads the
 * saved value from the KV store on mount and pushes it here.
 */

import { useSyncExternalStore } from 'react';
import { createStore } from './create-store.js';

const store = createStore('');

/** Current active dataset name. Empty string until set. */
export function getCurrentDataset(): string {
  return store.get();
}

/**
 * Set the current dataset and notify all subscribers. No-op if the
 * value is unchanged. Typically called from DatasetProvider after it
 * loads the saved value from the KV store, or after the user picks
 * a new value on the Settings page.
 */
export function setCurrentDataset(name: string): void {
  store.set((name || '').trim());
}

/** Subscribe to dataset changes. Returns an unsubscribe function. */
export function subscribeDataset(fn: () => void): () => void {
  return store.subscribe(fn);
}

/**
 * React hook. Returns the current dataset name and re-renders when
 * it changes. Built on useSyncExternalStore so components
 * participate in React's concurrent rendering correctly.
 */
export function useDataset(): string {
  return useSyncExternalStore(subscribeDataset, getCurrentDataset, getCurrentDataset);
}

/**
 * Why the saved dataset could not be loaded, or null. `<DatasetProvider>`
 * keeps its fallback (the app default stays in the store) when the KV read
 * fails, which used to be silent: a broken settings store looked exactly
 * like "nothing saved". It records the failure here — and clears it on the
 * next successful load — so a Settings page or banner can say so.
 */
const loadErrorStore = createStore<Error | null>(null);

/** The last saved-dataset load failure, or null once a load succeeds. */
export function getDatasetLoadError(): Error | null {
  return loadErrorStore.get();
}

/** Record (or clear, with null) a saved-dataset load failure. Called by
 * `<DatasetProvider>`; an app that loads the dataset itself may call it too. */
export function setDatasetLoadError(err: Error | null): void {
  loadErrorStore.set(err);
}

/** Subscribe to load-error changes. Returns an unsubscribe function. */
export function subscribeDatasetLoadError(fn: () => void): () => void {
  return loadErrorStore.subscribe(fn);
}

/**
 * React hook: the saved-dataset load failure, or null. The dataset itself
 * still falls back to the app default; this is how a page tells the user
 * their saved choice is not the one in use.
 *
 * ```tsx
 * const loadError = useDatasetLoadError();
 * if (loadError) return <Banner kind="warning">Saved dataset unavailable: {loadError.message}</Banner>;
 * ```
 */
export function useDatasetLoadError(): Error | null {
  return useSyncExternalStore(subscribeDatasetLoadError, getDatasetLoadError, getDatasetLoadError);
}
