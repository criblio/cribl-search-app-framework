/**
 * The saved-dataset read behind `<DatasetProvider>`, kept out of the
 * component so it can be tested without a DOM. Internal: not in the
 * package's `exports` map.
 */
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
 */
export async function loadSavedDataset(appDefault?: string): Promise<string | undefined> {
  const fallback = appDefault?.trim();
  const settings = await loadSettings(fallback ? { dataset: fallback } : undefined);
  const ds = settings?.dataset;
  return typeof ds === 'string' && ds.trim() ? ds.trim() : undefined;
}
