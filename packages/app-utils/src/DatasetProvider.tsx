/**
 * Loads the saved `dataset` value from the app's settings on mount
 * and pushes it into the dataset store, so any descendants using
 * `useDataset()` see the user's last choice on first paint.
 *
 * Children render immediately with whatever the dataset store
 * currently holds (the `defaultDataset` prop, or "" if neither is
 * set) so there's no loading gate. When the KV read succeeds the
 * subscribe-notify pattern triggers re-fetches in mounted pages.
 *
 * Most apps will pair this with `<Outlet key={dataset} />` in their
 * shell so route subtrees fully remount when the dataset changes —
 * see ../README.md for the pattern.
 */

import { useEffect, type ReactNode } from 'react';
import { loadSettings } from './settings.js';
import { setCurrentDataset } from './dataset.js';

interface Props {
  /** Fallback dataset name to apply if no settings are saved. */
  defaultDataset?: string;
  children: ReactNode;
}

export function DatasetProvider({ defaultDataset, children }: Props) {
  useEffect(() => {
    let cancelled = false;
    if (defaultDataset) setCurrentDataset(defaultDataset);
    loadSettings()
      .then((settings) => {
        if (cancelled) return;
        const ds = settings?.dataset;
        if (typeof ds === 'string' && ds.trim()) {
          setCurrentDataset(ds.trim());
        }
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
