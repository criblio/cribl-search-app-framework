/**
 * The app's settings: one KV key (`settings`), read and written through the
 * framework helpers, with every default set here in code.
 *
 * The configuration page, `DatasetProvider` and the provisioning plan all
 * read DEFAULT_SETTINGS from this module, and a `scripts/provision.ts` (if
 * you add one) should too, so the UI and the deploy script always agree.
 * A new setting gets a default here, never a migration: saved values merge
 * over these defaults on load.
 *
 * Browser-safe and free of window reads at import time, so Node scripts and
 * tests can import it.
 */
import { loadSettings, saveSettingsResult, type AppSettings } from '@criblio/app-utils/settings';
import { CADENCE_OPTIONS, DEFAULT_CADENCE, type CadenceOption } from '@criblio/app-utils/cadence';

export interface Settings extends AppSettings {
  /** Cribl Search dataset every query and scheduled search reads. */
  dataset: string;
  /** Scheduled-search cadence, a `CadenceOption` ('1m' | '2m' | '5m' | '10m'). */
  searchCadence: CadenceOption;
  // Feature switches go here, each with a default below.
}

export const DEFAULT_SETTINGS: Settings = {
  // The one dataset literal in the app: a default the user can change on
  // /configuration. Queries read the current dataset, never this constant.
  dataset: 'otel',
  searchCadence: DEFAULT_CADENCE,
};

/** Clamp a stored cadence to a known option; anything else is the default. */
export function cadence(value: unknown): CadenceOption {
  return CADENCE_OPTIONS.some((o) => o.value === value) ? (value as CadenceOption) : DEFAULT_CADENCE;
}

/**
 * Load saved settings over the defaults. Throws `KvError` when the store
 * was not reached: callers must show that, never substitute defaults, or
 * the next save overwrites what is really stored.
 */
export async function loadAppSettings(): Promise<Settings> {
  const loaded = (await loadSettings(DEFAULT_SETTINGS)) as Settings;
  return { ...loaded, searchCadence: cadence(loaded.searchCadence) };
}

/** Save settings; the result says whether the write landed. */
export function saveAppSettings(settings: Settings) {
  return saveSettingsResult(settings);
}
