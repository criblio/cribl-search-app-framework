/** `stackColumns` — the layout behind StackedColumnChart, and `entityColor`. */
import { describe, expect, it } from 'vitest';
import { stackColumns } from '../viz/stackColumns.js';
import { entityColor, entityHue } from '../viz/palette.js';

describe('stackColumns', () => {
  it('stacks bottom-to-top in series order and treats missing buckets as zero', () => {
    const out = stackColumns([
      { name: 'ok', color: 'green', data: [{ t: 0, v: 10 }, { t: 60_000, v: 5 }] },
      { name: 'err', color: 'red', data: [{ t: 0, v: 2 }] },
    ]);
    expect(out.buckets).toEqual([
      {
        t: 0,
        total: 12,
        segments: [
          { name: 'ok', color: 'green', value: 10, y0: 0, y1: 10 },
          { name: 'err', color: 'red', value: 2, y0: 10, y1: 12 },
        ],
      },
      { t: 60_000, total: 5, segments: [{ name: 'ok', color: 'green', value: 5, y0: 0, y1: 5 }] },
    ]);
    expect(out.totalMax).toBe(12);
    expect(out.step).toBe(60_000);
  });

  it('sizes the step from the tightest gap so missing buckets do not fatten bars', () => {
    // Buckets every minute with a 10-minute hole: width/count would give
    // each bar ~3 minutes of slot and overlap its neighbours.
    const data = [0, 1, 2, 12].map((m) => ({ t: m * 60_000, v: 1 }));
    expect(stackColumns([{ name: 'a', color: '#000', data }]).step).toBe(60_000);
  });

  it('sums duplicate points, sorts buckets, and drops non-positive or non-finite values', () => {
    const out = stackColumns([
      {
        name: 'a',
        color: '#000',
        data: [
          { t: 2, v: 1 },
          { t: 1, v: 3 },
          { t: 1, v: 4 },
          { t: 3, v: -5 },
          { t: 4, v: Number.NaN },
        ],
      },
    ]);
    expect(out.buckets.map((b) => [b.t, b.total])).toEqual([
      [1, 7],
      [2, 1],
      [3, 0],
      [4, 0],
    ]);
    expect(out.buckets[2].segments).toEqual([]);
  });

  it('is empty for no series and has no step for a single bucket', () => {
    expect(stackColumns([])).toEqual({ buckets: [], step: 0, totalMax: 0 });
    expect(stackColumns([{ name: 'a', color: '#000', data: [{ t: 5, v: 1 }] }]).step).toBe(0);
  });
});

describe('entityColor', () => {
  it('is deterministic and independent of call order', () => {
    const first = ['checkout', 'frontend', 'payment'].map((id) => entityColor(id));
    const second = ['payment', 'frontend', 'checkout'].map((id) => entityColor(id)).reverse();
    expect(first).toEqual(second);
  });

  it('keeps APM serviceColor values so existing views do not change colour on adoption', () => {
    // hash = h*31 + charCode, |0 — the APM serviceHue implementation.
    let hash = 0;
    for (const ch of 'frontend') hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    expect(entityHue('frontend')).toBe(Math.abs(hash) % 360);
    expect(entityColor('frontend')).toBe(`hsl(${Math.abs(hash) % 360}, 60%, 50%)`);
  });

  it('varies lightness only, keeping the hue', () => {
    expect(entityColor('db', 30)).toBe(`hsl(${entityHue('db')}, 60%, 30%)`);
    expect(entityHue('')).toBe(0);
  });

  it('spreads distinct ids across hues', () => {
    const hues = new Set(Array.from({ length: 50 }, (_, i) => entityHue(`service-${i}`)));
    expect(hues.size).toBeGreaterThan(40);
  });
});
