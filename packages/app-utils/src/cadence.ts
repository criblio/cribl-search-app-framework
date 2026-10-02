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

/**
 * Shift the minute field of a 5-field cron so a DEPENDENT search runs
 * `minutes` after the search it reads, at the same cadence.
 *
 *   offsetCron('*\/5 * * * *', 1)  → '1-59/5 * * * *'   (1, 6, 11, …)
 *   offsetCron('7 * * * *', 2)     → '9 * * * *'
 *   offsetCron('* * * * *', 1)     → '* * * * *'        (unchanged)
 *
 * Every-minute stays every-minute. There is no later slot within a
 * one-minute period, and the naive rewrite — `* ` → `1 ` — turns "every
 * minute" into "minute 1 of every hour": APM did exactly that, so at the
 * 1m cadence its dependent searches ran hourly. A dependent at the 1m
 * cadence reads the previous minute's output instead.
 *
 * Rules, applied to the minute field only:
 *   - `*` or `*\/1`             → unchanged
 *   - `*\/N` or `a-59/N` (a < N) → `k-59/N`, k = (a + minutes) mod N;
 *     a k of 0 is written back as `*\/N`
 *   - a single minute `m`      → (m + minutes) mod 60, when the hour field
 *     is `*`. Under a restricted hour field a wrap past :59 would move the
 *     run BEFORE its source rather than after, so that case is unchanged.
 *   - anything else (lists, ranges, other steps, not 5 fields, a
 *     non-integer offset) → unchanged. Returning the input is always safe:
 *     the dependent may read one period late, but it never changes cadence.
 */
export function offsetCron(cron: string, minutes: number): string {
  if (!Number.isInteger(minutes)) return cron;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, ...rest] = fields as [string, string, string, string, string];

  const shifted = shiftMinuteField(minute, hour, minutes);
  if (shifted === null || shifted === minute) return cron;
  return [shifted, hour, ...rest].join(' ');
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

function shiftMinuteField(minute: string, hour: string, by: number): string | null {
  if (minute === '*') return null;

  const step = /^(?:\*|(\d{1,2})-59)\/(\d{1,2})$/.exec(minute);
  if (step) {
    const start = step[1] === undefined ? 0 : Number(step[1]);
    const n = Number(step[2]);
    if (n < 1 || n > 59 || start >= n) return null;
    if (n === 1) return null; // every minute, spelled `*/1`
    const k = mod(start + by, n);
    return k === 0 ? `*/${n}` : `${k}-59/${n}`;
  }

  if (/^\d{1,2}$/.test(minute)) {
    const m = Number(minute);
    if (m > 59) return null;
    const next = m + by;
    if (hour !== '*' && (next < 0 || next > 59)) return null;
    return String(mod(next, 60));
  }

  return null;
}
