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
 * Most apps will pair this with `<Outlet key={dataset} />` in their
 * shell so route subtrees fully remount when the dataset changes —
 * see ../README.md for the pattern.
 */

import { useEffect, type ReactNode } from 'react';
import { loadSavedDataset } from './dataset-settings.js';
import { getCurrentDataset, setCurrentDataset } from './dataset.js';

interface Props {
  /** Fallback dataset name to apply if no settings are saved. */
  defaultDataset?: string;
  children: ReactNode;
}

export function DatasetProvider({ defaultDataset, children }: Props) {
  // Render-time on purpose (see above): an effect is too late. Guarded on
  // an empty store, so it is idempotent across re-renders and StrictMode's
  // double render, and never clobbers a value someone already chose.
  if (defaultDataset?.trim() && !getCurrentDataset()) {
    setCurrentDataset(defaultDataset);
  }

  useEffect(() => {
    let cancelled = false;
    loadSavedDataset(defaultDataset)
      .then((ds) => {
        if (!cancelled && ds) setCurrentDataset(ds);
      })
      .catch(() => {
        /* KV unreachable — leave the default (or whatever's set) in place. */
      });
    return () => {
      cancelled = true;
    };
  }, [defaultDataset]);

  return <>{children}</>;
}
