/**
 * `offsetCron` — staggering a dependent search after its source.
 *
 * The bug it exists to prevent: APM rewrote the minute field with
 * `.replace(/^\* /, '1 ')`, so at the 1m cadence `* * * * *` became
 * `1 * * * *` and every dependent search silently ran once an HOUR.
 */
import { describe, expect, it } from 'vitest';
import { CADENCE_OPTIONS, cadenceToCron, getSearchCadenceCron, offsetCron, setSearchCadence } from '../cadence.js';

describe('offsetCron on every cadence the framework emits', () => {
  // Derived from the catalog, so a new cadence is covered or fails here.
  const expected: Record<string, [number, string][]> = {
    '* * * * *': [[1, '* * * * *'], [2, '* * * * *'], [4, '* * * * *']],
    '*/2 * * * *': [[1, '1-59/2 * * * *'], [2, '*/2 * * * *'], [3, '1-59/2 * * * *']],
    '*/5 * * * *': [[1, '1-59/5 * * * *'], [2, '2-59/5 * * * *'], [4, '4-59/5 * * * *'], [5, '*/5 * * * *']],
    '*/10 * * * *': [[1, '1-59/10 * * * *'], [3, '3-59/10 * * * *'], [12, '2-59/10 * * * *']],
  };

  it('has an expectation for every cadence option', () => {
    expect(Object.keys(expected).sort()).toEqual(CADENCE_OPTIONS.map((o) => cadenceToCron(o.value)).sort());
  });

  for (const [cron, cases] of Object.entries(expected)) {
    for (const [by, out] of cases) {
      it(`${cron} + ${by} → ${out}`, () => {
        expect(offsetCron(cron, by)).toBe(out);
      });
    }
  }

  it('the 1m cadence is never rewritten to an hourly schedule', () => {
    setSearchCadence('1m');
    try {
      const cron = getSearchCadenceCron();
      for (let by = 0; by < 60; by++) {
        expect(offsetCron(cron, by)).toBe('* * * * *');
      }
      // The rewrite APM shipped, for contrast.
      expect(cron.replace(/^\* /, '1 ')).toBe('1 * * * *');
    } finally {
      setSearchCadence('5m');
    }
  });

  it('keeps the cadence: an offset step fires as often as the original', () => {
    const fires = (cron: string) => {
      const [field] = cron.split(' ');
      const m = /^(?:\*|(\d+)-59)\/(\d+)$/.exec(field!)!;
      const start = Number(m[1] ?? 0);
      const n = Number(m[2]);
      return Array.from({ length: 60 }, (_, i) => i).filter((i) => i >= start && (i - start) % n === 0);
    };
    expect(fires(offsetCron('*/5 * * * *', 1))).toEqual([1, 6, 11, 16, 21, 26, 31, 36, 41, 46, 51, 56]);
    expect(fires(offsetCron('*/10 * * * *', 3))).toEqual([3, 13, 23, 33, 43, 53]);
  });
});

describe('offsetCron on fixed minutes', () => {
  it('adds to a single minute', () => {
    expect(offsetCron('7 * * * *', 2)).toBe('9 * * * *');
    expect(offsetCron('0 * * * *', 1)).toBe('1 * * * *');
  });

  it('wraps past :59 when the hour field is *', () => {
    expect(offsetCron('58 * * * *', 3)).toBe('1 * * * *');
  });

  it('does not wrap under a restricted hour field (would run before its source)', () => {
    expect(offsetCron('58 */6 * * *', 3)).toBe('58 */6 * * *');
    expect(offsetCron('23 */6 * * *', 5)).toBe('28 */6 * * *');
  });

  it('shifts minutes on a daily schedule without touching the other fields', () => {
    expect(offsetCron('30 0 * * 1-5', 5)).toBe('35 0 * * 1-5');
  });
});

describe('offsetCron composes and leaves what it cannot shift alone', () => {
  it('re-offsets an already offset step', () => {
    expect(offsetCron(offsetCron('*/5 * * * *', 1), 1)).toBe('2-59/5 * * * *');
    expect(offsetCron('4-59/5 * * * *', 1)).toBe('*/5 * * * *');
  });

  it('every minute spelled */1 is unchanged', () => {
    expect(offsetCron('*/1 * * * *', 1)).toBe('*/1 * * * *');
  });

  it('a negative offset moves earlier', () => {
    expect(offsetCron('2-59/5 * * * *', -1)).toBe('1-59/5 * * * *');
    expect(offsetCron('0 * * * *', -1)).toBe('59 * * * *');
  });

  it.each([
    ['1,31 * * * *'],
    ['10-20 * * * *'],
    ['5/10 * * * *'],
    ['10-50/5 * * * *'],
    ['7-59/5 * * * *'],
    ['*/0 * * * *'],
    ['*/60 * * * *'],
    ['61 * * * *'],
    ['* * * *'],
    ['0 0 * * * *'],
    ['@hourly'],
    [''],
  ])('%j is returned unchanged', (cron) => {
    expect(offsetCron(cron, 1)).toBe(cron);
  });

  it('a non-integer offset changes nothing', () => {
    expect(offsetCron('*/5 * * * *', 1.5)).toBe('*/5 * * * *');
    expect(offsetCron('*/5 * * * *', Number.NaN)).toBe('*/5 * * * *');
  });
});
