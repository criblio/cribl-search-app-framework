/**
 * Relative time ranges: the picker catalog, chart bin widths, and the
 * same-length prior window a "vs previous" comparison queries.
 *
 * Cribl Search accepts relative bounds like `-1h`, `-30m`, `-7d` for both
 * `earliest` and `latest`, so a previous window is just shifted bounds:
 * `-1h → now` becomes `-2h → -1h`. Pure functions, no React, no globals —
 * safe in a browser, Node, or a workerd cell.
 *
 * Unparseable input returns `null` rather than a guess. APM's original
 * fell back to one hour, so a typo'd or snapped range (`-1d@d`) silently
 * compared against the wrong window and the delta chips lied.
 */

/** One entry in a time-range picker. */
export interface TimeRangeOption {
  /** Shown in the picker, e.g. "Last 1 hour". */
  readonly label: string;
  /** Relative `earliest`, e.g. `-1h`; `latest` is `now`. */
  readonly value: string;
  /** Chart/timechart bin width for this range, in seconds. */
  readonly binSeconds: number;
}

/**
 * The default picker catalog. Bin widths keep every range between ~30 and
 * ~100 points: enough to see shape, few enough that a timechart stays fast.
 */
export const TIME_RANGES: readonly TimeRangeOption[] = [
  { label: 'Last 15 minutes', value: '-15m', binSeconds: 30 },
  { label: 'Last 1 hour', value: '-1h', binSeconds: 60 },
  { label: 'Last 6 hours', value: '-6h', binSeconds: 300 },
  { label: 'Last 24 hours', value: '-24h', binSeconds: 900 },
];

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
type Unit = keyof typeof UNIT_MS;
/** Largest first, so a mixed-unit window is expressed in the coarsest unit that is exact. */
const UNITS_DESC: readonly Unit[] = ['w', 'd', 'h', 'm', 's'];

interface Relative { n: number; unit: Unit | null }

/** `-90m` → { n: 90, unit: 'm' }; `now` / `0` → { n: 0, unit: null }. */
function parseRelative(rel: string): Relative | null {
  const t = rel.trim();
  if (t === 'now' || t === '0') return { n: 0, unit: null };
  const m = /^-(\d+)([smhdw])$/.exec(t);
  if (!m) return null;
  return { n: Number(m[1]), unit: m[2] as Unit };
}

/**
 * Duration of a relative time in milliseconds: `-1h` → 3 600 000,
 * `now` → 0. Units s, m, h, d, w. Returns `null` for anything else
 * (absolute times, snapped `@d` forms), so callers decide the fallback.
 */
export function relativeTimeMs(rel: string): number | null {
  const r = parseRelative(rel);
  if (!r) return null;
  return r.unit ? r.n * UNIT_MS[r.unit] : 0;
}

/**
 * The window of equal length immediately before `earliest → latest`.
 * `('-1h')` → `{ earliest: '-2h', latest: '-1h' }`;
 * `('-2h', '-1h')` → `{ earliest: '-3h', latest: '-2h' }`.
 *
 * Units are preserved when both bounds share one (`-1d` doubles to `-2d`,
 * never `-48h`); mixed units use the coarsest unit that is exact. Returns
 * `null` when either bound is not a relative time or the window is empty.
 */
export function previousWindow(
  earliest: string,
  latest = 'now',
): { earliest: string; latest: string } | null {
  const e = parseRelative(earliest);
  const l = parseRelative(latest);
  if (!e || !l) return null;
  const eMs = e.unit ? e.n * UNIT_MS[e.unit] : 0;
  const lMs = l.unit ? l.n * UNIT_MS[l.unit] : 0;
  const span = eMs - lMs;
  if (span <= 0) return null;
  const preferred = e.unit && (l.unit === null || l.unit === e.unit) ? e.unit : null;
  const unit = preferred ?? UNITS_DESC.find((u) => eMs % UNIT_MS[u] === 0 && lMs % UNIT_MS[u] === 0)!;
  const size = UNIT_MS[unit];
  return { earliest: `-${(eMs + span) / size}${unit}`, latest: `-${eMs / size}${unit}` };
}

/** Bin widths a computed fallback rounds up to, in seconds. */
const NICE_BINS = [10, 30, 60, 300, 900, 1_800, 3_600, 10_800, 21_600, 43_200, 86_400] as const;
const TARGET_BINS = 100;

/**
 * Bin width in seconds for a relative range. A range in `ranges` (default
 * `TIME_RANGES`) uses its declared width; any other relative range rounds
 * `duration / 100` up to a nice width, so `-7d` gets 3h bins (56 points) instead of
 * the 1m default that made a week-long timechart 10 080 points. Anything
 * unparseable gets 60.
 */
export function binSecondsFor(
  range: string,
  ranges: readonly TimeRangeOption[] = TIME_RANGES,
): number {
  const known = ranges.find((r) => r.value === range);
  if (known) return known.binSeconds;
  const ms = relativeTimeMs(range);
  if (!ms) return 60;
  const ideal = ms / 1_000 / TARGET_BINS;
  return NICE_BINS.find((b) => b >= ideal) ?? NICE_BINS[NICE_BINS.length - 1]!;
}
