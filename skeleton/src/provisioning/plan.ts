/**
 * Every scheduled search this app owns, as a pure function of its settings.
 *
 * The configuration page's ProvisioningPanel and any `scripts/provision.ts`
 * both call `provisionerConfig(settings)`; no other file defines a
 * scheduled search. The plan starts empty: add entries to `buildPlan` as
 * pages move their default view onto cached results.
 *
 * Browser-safe: no window reads at import time.
 */
import type { ProvisionedSearch, ProvisionerConfig } from '@criblio/app-utils/provisioner';
import { kqlDatasetId } from '@criblio/app-utils/kql';
import type { Settings } from '../settings';

/**
 * Prefix for every saved-search id this app manages. The provisioner only
 * touches ids that start with it, so it must not be a prefix of another
 * app's. Derived from the app name the scaffold substitutes for APPNAME.
 */
export const PREFIX = `${'APPNAME'.toLowerCase().replace(/[^a-z0-9]+/g, '_')}__`;

/** The app's scheduled searches for these settings. Empty, and valid. */
export function buildPlan(settings: Settings): ProvisionedSearch[] {
  // Throws on '' or an unsafe id, so a plan is never built for no dataset.
  kqlDatasetId(settings.dataset);
  // Example entry, once the app has a query worth caching:
  //   const ds = kqlDatasetId(settings.dataset);
  //   const cron = cadenceToCron(cadence(settings.searchCadence));  // /cadence, ../settings
  //   return [{ id: `${PREFIX}summary`, name: 'APPNAME summary', query: `dataset="${ds}" | ...`,
  //             earliest: '-1h', latest: 'now',
  //             schedule: { enabled: true, cronSchedule: cron, tz: 'UTC', keepLastN: 2 } }];
  return [];
}

export function provisionerConfig(settings: Settings): ProvisionerConfig {
  return {
    prefix: PREFIX,
    // Built at preview/apply time, so a bad dataset fails there, visibly.
    plan: () => buildPlan(settings),
  };
}
