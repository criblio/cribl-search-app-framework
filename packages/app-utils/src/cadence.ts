/**
 * Generic scheduled-search cadence module for Cribl Search Apps.
 *
 * Stores a user-friendly cadence value in module-level state and
 * maps it to the cron expression the provisioner stamps onto each
 * scheduled search. The Settings UI updates the value via
 * `setSearchCadence`; consumers (the provisioner plan, refreshing
 * UI panels) subscribe via `subscribeSearchCadence` so they pick
 * up changes without a reload.
 *
 * Persistence (loading from KV on app boot, writing to KV on user
 * change) is the consumer's responsibility — same cadence module
 * runs in both the browser and the Node provisioning script, and
 * those two paths read/write KV differently.
 */

export type CadenceOption = '1m' | '2m' | '5m' | '10m';

export interface CadenceChoice {
  value: CadenceOption;
  label: string;
  /** Approx. data lag the user should expect, for UI hint copy. */
  lagLabel: string;
}

export const CADENCE_OPTIONS: CadenceChoice[] = [
  { value: '1m', label: 'Every 1 minute', lagLabel: '~1 minute' },
  { value: '2m', label: 'Every 2 minutes', lagLabel: '~2 minutes' },
  { value: '5m', label: 'Every 5 minutes', lagLabel: '~5 minutes' },
  { value: '10m', label: 'Every 10 minutes', lagLabel: '~10 minutes' },
];

export const DEFAULT_CADENCE: CadenceOption = '5m';

const CADENCE_TO_CRON: Record<CadenceOption, string> = {
  '1m': '* * * * *',
  '2m': '*/2 * * * *',
  '5m': '*/5 * * * *',
  '10m': '*/10 * * * *',
};

let current: CadenceOption = DEFAULT_CADENCE;
const listeners = new Set<() => void>();

export function getSearchCadence(): CadenceOption {
  return current;
}

export function getSearchCadenceCron(): string {
  return CADENCE_TO_CRON[current];
}

export function cadenceToCron(c: CadenceOption): string {
  return CADENCE_TO_CRON[c];
}

/** Idempotent: setting the same value twice fires no listeners. Falls
 * back to the default if the value isn't a known option (defensive
 * against stale KV values from a prior schema). */
export function setSearchCadence(value: string): void {
  const next = (CADENCE_TO_CRON as Record<string, string | undefined>)[value]
    ? (value as CadenceOption)
    : DEFAULT_CADENCE;
  if (next === current) return;
  current = next;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* listener errors shouldn't block others */
    }
  }
}

export function subscribeSearchCadence(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
