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
 * `context` is what that loader receives; default: never cancelled.
 */
export async function loadSavedDataset(
  appDefault?: string,
  source: SavedDatasetSource = {},
  context: DatasetLoadContext = NEVER_CANCELLED,
): Promise<string | undefined> {
  if (source.loadDataset) {
    const ds = await source.loadDataset(context);
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

/**
 * Passed to a custom `loadDataset`. The load is cancelled when the
 * provider unmounts, when its `defaultDataset`/`settingsKey` changes and
 * the load restarts, and in StrictMode's discarded first effect. A loader
 * with side effects of its own (APM applies feature flags from the same
 * settings read) checks `isCancelled()` before applying them, and can hand
 * `signal` to `fetch`/`kvGetJson` to stop the read itself. Whatever a
 * cancelled load resolves or rejects with is dropped by the provider.
 */
export interface DatasetLoadContext {
  /** Aborted when the load is cancelled. */
  signal: AbortSignal;
  /** True once the load is cancelled; check it before any side effect. */
  isCancelled(): boolean;
}

const NEVER_CANCELLED: DatasetLoadContext = {
  signal: new AbortController().signal,
  isCancelled: () => false,
};

/** A custom saved-dataset read. Resolve `undefined` for "nothing saved";
 * reject (ideally with `KvError`) when the read failed. Using the context
 * is optional, so a zero-argument `async () => …` loader still fits. */
export type DatasetLoader = (context: DatasetLoadContext) => Promise<string | undefined | null>;

/** Where the saved dataset is read from. Default: the `dataset` field of
 * the object at KV key `settings`. */
export interface SavedDatasetSource {
  /** KV key of the app's settings object. Default `'settings'`. */
  settingsKey?: string;
  /** Custom read; wins over `settingsKey`. See `DatasetLoader`. */
  loadDataset?: DatasetLoader;
}

/** The `console.warn` text for a load failure nobody else reports. */
export const DATASET_LOAD_WARNING = 'DatasetProvider: could not load the saved dataset; using the app default.';

export interface SyncSavedDatasetOptions extends SavedDatasetSource {
  /** Cancels the load: passed to `loadDataset`, and an aborted signal
   * drops the result, so a cancelled load changes nothing. */
  signal?: AbortSignal;
  /** Checked after the read settles; true drops the result (unmounted).
   * Either this or an aborted `signal` cancels. */
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
  const signal = opts.signal ?? new AbortController().signal;
  const context: DatasetLoadContext = {
    signal,
    isCancelled: () => signal.aborted || (opts.isCancelled?.() ?? false),
  };
  let ds: string | undefined;
  try {
    ds = await loadSavedDataset(appDefault, { settingsKey: opts.settingsKey, loadDataset: opts.loadDataset }, context);
  } catch (raw) {
    // A cancelled load's rejection (an AbortError, typically) is not a
    // load failure: nothing is recorded or reported.
    if (context.isCancelled()) return;
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
  if (context.isCancelled()) return;
  setDatasetLoadError(null);
  if (ds) setCurrentDataset(ds);
}
