/**
 * The saved-dataset read behind `<DatasetProvider>`, kept out of the
 * component so it can be tested without a DOM. Internal: not in the
 * package's `exports` map.
 */
import { setCurrentDataset, setDatasetLoadError } from './dataset.js';
import { loadSettings } from './settings.js';

/**
 * Resolve the dataset an app should use from its saved settings.
 *
 * `appDefault` is what an app gets when nothing is saved. Passing it to
 * `loadSettings` is the point: called with no defaults, `loadSettings`
 * merges over the framework's own `{ dataset: 'otel' }`, so a workspace
 * with nothing saved replaced a non-otel app default with `otel`. With no
 * `appDefault` the framework default still applies, as it always has.
 *
 * Returns the trimmed name, or `undefined` when there is nothing usable.
 * Rejects when the KV read fails; the caller decides what that means.
 *
 * `settingsKey` reads the app's own KV key instead of `settings`;
 * `loadDataset` replaces the read entirely (a dataset stored under another
 * field, or outside the settings object) — its result is trimmed the same
 * way, and `appDefault` is then only the provider's render-time default.
 */
export async function loadSavedDataset(
  appDefault?: string,
  source: SavedDatasetSource = {},
): Promise<string | undefined> {
  if (source.loadDataset) {
    const ds = await source.loadDataset();
    return typeof ds === 'string' && ds.trim() ? ds.trim() : undefined;
  }
  const fallback = appDefault?.trim();
  const settings = await loadSettings(
    fallback ? { dataset: fallback } : undefined,
    source.settingsKey ? { key: source.settingsKey } : undefined,
  );
  const ds = settings?.dataset;
  return typeof ds === 'string' && ds.trim() ? ds.trim() : undefined;
}

/** Where the saved dataset is read from. Default: the `dataset` field of
 * the object at KV key `settings`. */
export interface SavedDatasetSource {
  /** KV key of the app's settings object. Default `'settings'`. */
  settingsKey?: string;
  /** Custom read; wins over `settingsKey`. Resolve `undefined` for "nothing
   * saved"; reject (ideally with `KvError`) when the read failed. */
  loadDataset?: () => Promise<string | undefined | null>;
}

/** The `console.warn` text for a load failure nobody else reports. */
export const DATASET_LOAD_WARNING = 'DatasetProvider: could not load the saved dataset; using the app default.';

export interface SyncSavedDatasetOptions extends SavedDatasetSource {
  /** Checked after the read settles; true drops the result (unmounted). */
  isCancelled?: () => boolean;
  /** Called with the KV failure. Without it the failure is logged with
   * `console.warn`, so it is never silent. */
  onError?: (err: Error) => void;
}

/**
 * `<DatasetProvider>`'s mount effect: load the saved dataset and push it
 * into the store. A KV failure leaves the store alone (the app default
 * stands, as before) but is recorded in the load-error store
 * (`useDatasetLoadError`) and reported through `onError`; a later success
 * clears it. Never rejects.
 */
export async function syncSavedDataset(appDefault?: string, opts: SyncSavedDatasetOptions = {}): Promise<void> {
  let ds: string | undefined;
  try {
    ds = await loadSavedDataset(appDefault, { settingsKey: opts.settingsKey, loadDataset: opts.loadDataset });
  } catch (raw) {
    if (opts.isCancelled?.()) return;
    const err = raw instanceof Error ? raw : new Error(String(raw));
    setDatasetLoadError(err);
    if (opts.onError) {
      try {
        opts.onError(err);
      } catch {
        /* a throwing reporter must not become an unhandled rejection */
      }
    } else {
      console.warn(DATASET_LOAD_WARNING, err);
    }
    return;
  }
  if (opts.isCancelled?.()) return;
  setDatasetLoadError(null);
  if (ds) setCurrentDataset(ds);
}
