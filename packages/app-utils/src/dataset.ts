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
 * The companion <DatasetProvider> (./DatasetProvider.tsx) loads the
 * saved value from the KV store on mount and pushes it here.
 */

import { useSyncExternalStore } from 'react';

let currentDataset = '';
const listeners = new Set<() => void>();

/** Current active dataset name. Empty string until set. */
export function getCurrentDataset(): string {
  return currentDataset;
}

/**
 * Set the current dataset and notify all subscribers. No-op if the
 * value is unchanged. Typically called from DatasetProvider after it
 * loads the saved value from the KV store, or after the user picks
 * a new value on the Settings page.
 */
export function setCurrentDataset(name: string): void {
  const next = (name || '').trim();
  if (next === currentDataset) return;
  currentDataset = next;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* listener errors shouldn't block others */
    }
  }
}

/** Subscribe to dataset changes. Returns an unsubscribe function. */
export function subscribeDataset(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * React hook. Returns the current dataset name and re-renders when
 * it changes. Built on useSyncExternalStore so components
 * participate in React's concurrent rendering correctly.
 */
export function useDataset(): string {
  return useSyncExternalStore(subscribeDataset, getCurrentDataset, getCurrentDataset);
}
