/**
 * Relative-time helpers behind range pickers, chart bins and "vs previous
 * window" comparisons.
 *
 * The regression worth locking down: APM's versions answered unparseable
 * input with a one-hour guess, so a range they did not understand compared
 * against the wrong window and nothing said so. These return `null`.
 */
import { describe, expect, it } from 'vitest';
import { TIME_RANGES, binSecondsFor, previousWindow, relativeTimeMs } from '../time.js';

describe('relativeTimeMs', () => {
  it('parses every unit and now', () => {
    expect(relativeTimeMs('-30s')).toBe(30_000);
    expect(relativeTimeMs('-15m')).toBe(900_000);
    expect(relativeTimeMs('-1h')).toBe(3_600_000);
    expect(relativeTimeMs('-7d')).toBe(604_800_000);
    expect(relativeTimeMs('-2w')).toBe(1_209_600_000);
    expect(relativeTimeMs('now')).toBe(0);
  });

  it('returns null for what it cannot parse instead of guessing an hour', () => {
    for (const bad of ['', '1h', '-1y', '-1d@d', '2026-10-02T00:00:00Z', '-h']) {
      expect(relativeTimeMs(bad)).toBeNull();
    }
  });
});

describe('previousWindow', () => {
  it('shifts a window ending now back by its own length', () => {
    expect(previousWindow('-1h')).toEqual({ earliest: '-2h', latest: '-1h' });
    expect(previousWindow('-15m', 'now')).toEqual({ earliest: '-30m', latest: '-15m' });
  });

  it('keeps the unit rather than normalising -1d to hours', () => {
    expect(previousWindow('-1d')).toEqual({ earliest: '-2d', latest: '-1d' });
  });

  it('handles a window that does not end now', () => {
    expect(previousWindow('-2h', '-1h')).toEqual({ earliest: '-3h', latest: '-2h' });
  });

  it('expresses mixed units in the coarsest exact unit', () => {
    expect(previousWindow('-2h', '-30m')).toEqual({ earliest: '-210m', latest: '-120m' });
    expect(previousWindow('-1d', '-12h')).toEqual({ earliest: '-36h', latest: '-24h' });
  });

  it('returns null for unparseable or empty windows', () => {
    expect(previousWindow('-1d@d')).toBeNull();
    expect(previousWindow('-1h', '1700000000')).toBeNull();
    expect(previousWindow('now')).toBeNull();
    expect(previousWindow('-1h', '-2h')).toBeNull();
  });
});

describe('binSecondsFor', () => {
  it('uses the catalog width for a catalog range', () => {
    for (const r of TIME_RANGES) expect(binSecondsFor(r.value)).toBe(r.binSeconds);
  });

  it('computes a nice width for a range outside the catalog', () => {
    // -7d at the old 1m default was a 10 080-point timechart.
    expect(binSecondsFor('-7d')).toBe(10_800);
    expect(binSecondsFor('-30m')).toBe(30);
    expect(binSecondsFor('-3h')).toBe(300);
  });

  it('honours a caller catalog and falls back to 60 for unparseable input', () => {
    expect(binSecondsFor('-1h', [{ label: 'x', value: '-1h', binSeconds: 10 }])).toBe(10);
    expect(binSecondsFor('garbage')).toBe(60);
    expect(binSecondsFor('now')).toBe(60);
  });

  it('keeps every catalog entry between ~30 and ~100 bins', () => {
    for (const r of TIME_RANGES) {
      const bins = relativeTimeMs(r.value)! / 1_000 / r.binSeconds;
      expect(bins).toBeGreaterThanOrEqual(30);
      expect(bins).toBeLessThanOrEqual(100);
    }
  });
});
