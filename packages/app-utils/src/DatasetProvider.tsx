/**
 * Loads the saved `dataset` value from the app's settings on mount
 * and pushes it into the dataset store, so any descendants using
 * `useDataset()` see the user's last choice on first paint.
 *
 * Children render immediately, with no loading gate. When the store is
 * still empty, `defaultDataset` is written to it SYNCHRONOUSLY during this
 * provider's render — before any child renders or runs an effect. It used
 * to be applied in this provider's own `useEffect`, and React runs child
 * effects before a parent's, so every child's first query (and a
 * provisioning banner's `planOnly` check) saw `dataset=""`: zero rows, or
 * every saved search reported as needing an update. A value already in
 * the store (an earlier mount, or a module-scope default the app set) is
 * never overwritten by the default.
 *
 * When the KV read resolves, the saved value wins; with nothing saved the
 * app's `defaultDataset` stands. It used to call `loadSettings()` with no
 * defaults, so the framework's own `{ dataset: 'otel' }` came back for a
 * workspace with nothing saved and replaced a non-otel app default. With
 * no `defaultDataset` prop the framework default still applies, as before.
 * The subscribe-notify pattern then triggers re-fetches in mounted pages.
 *
 * A failed KV read keeps that fallback but is no longer silent: it is
 * recorded for `useDatasetLoadError()` (from `/dataset`), passed to the
 * optional `onError` prop, and logged with `console.warn` when there is no
 * `onError`. The next successful load clears it.
 *
 * The saved value is the `dataset` field at KV key `settings`; an app
 * whose settings live elsewhere passes `settingsKey`, or `loadDataset` for
 * a read of its own.
 *
 * Most apps will pair this with `<Outlet key={dataset} />` in their
 * shell so route subtrees fully remount when the dataset changes —
 * see ../README.md for the pattern.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { DATASET_LOAD_WARNING, syncSavedDataset } from './dataset-settings.js';
import { getCurrentDataset, setCurrentDataset } from './dataset.js';

export interface DatasetProviderProps {
  /** Fallback dataset name to apply if no settings are saved. */
  defaultDataset?: string;
  /** Called when the saved dataset cannot be loaded (KV unreachable or
   * malformed). The app default stays in use either way. Not a dependency
   * of the load: an inline arrow does not re-trigger it. */
  onError?: (err: Error) => void;
  /** KV key of the app's settings object, for an app whose settings do
   * not live at `settings`. Default `'settings'`. */
  settingsKey?: string;
  /** Custom saved-dataset read; wins over `settingsKey`. Resolve
   * `undefined` for nothing saved, reject when the read failed. Like
   * `onError`, not a dependency of the load: an inline arrow does not
   * re-trigger it. */
  loadDataset?: () => Promise<string | undefined | null>;
  children: ReactNode;
}

export function DatasetProvider({ defaultDataset, onError, settingsKey, loadDataset, children }: DatasetProviderProps) {
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  const loadDatasetRef = useRef(loadDataset);
  useEffect(() => {
    loadDatasetRef.current = loadDataset;
  }, [loadDataset]);
  const hasLoader = loadDataset !== undefined;

  // Render-time on purpose (see above): an effect is too late. Guarded on
  // an empty store, so it is idempotent across re-renders and StrictMode's
  // double render, and never clobbers a value someone already chose.
  if (defaultDataset?.trim() && !getCurrentDataset()) {
    setCurrentDataset(defaultDataset);
  }

  useEffect(() => {
    let cancelled = false;
    void syncSavedDataset(defaultDataset, {
      isCancelled: () => cancelled,
      settingsKey,
      loadDataset: hasLoader ? () => (loadDatasetRef.current ?? (async () => undefined))() : undefined,
      // Read through the ref at failure time, so the latest prop is used.
      onError: (err) => {
        const report = onErrorRef.current;
        if (report) report(err);
        else console.warn(DATASET_LOAD_WARNING, err);
      },
    });
    return () => {
      cancelled = true;
    };
  }, [defaultDataset, settingsKey, hasLoader]);

  return <>{children}</>;
}
