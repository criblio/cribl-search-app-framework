/**
 * `<StackedColumnChart>` first paint (renderToString: render, no effects,
 * so the default 600px width).
 *
 * APM's version centred columns on a [first, last] domain and sized them
 * as width / bucket-count, so the first and last columns hung half outside
 * the plot and a gap in the data fattened every bar. Its single-bucket case
 * also rendered at the plot's right edge once the pad collapsed below 1 ms.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import StackedColumnChart from '../viz/StackedColumnChart.js';
import type { StackedSeries } from '../viz/stackColumns.js';

const T0 = 1_700_000_000_000;
const PLOT_LEFT = 56;
const PLOT_RIGHT = 600 - 12;

function render(series: StackedSeries[], extra: Record<string, unknown> = {}) {
  return renderToString(createElement(StackedColumnChart, { title: 'Status mix', series, ...extra }));
}

function bars(html: string) {
  return [...html.matchAll(/<rect x="([\d.-]+)" y="[\d.-]+" width="([\d.]+)" height="([\d.]+)" fill="([^"]+)"/g)].map(
    (m) => ({ x: Number(m[1]) + PLOT_LEFT, w: Number(m[2]), h: Number(m[3]), fill: m[4] }),
  );
}

describe('StackedColumnChart', () => {
  it('draws one rect per positive segment, all inside the plot', () => {
    const data = [0, 1, 2, 12].map((m) => ({ t: T0 + m * 60_000, v: 3 }));
    const html = render([
      { name: 'ok', color: 'green', data },
      { name: 'err', color: 'red', data: data.slice(0, 2) },
    ]);
    const rects = bars(html);
    expect(rects).toHaveLength(6);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(PLOT_LEFT);
      expect(r.x + r.w).toBeLessThanOrEqual(PLOT_RIGHT);
    }
    // Width comes from the 1-minute step, not 532px / 4 buckets.
    expect(rects[0].w).toBeLessThan(532 / 13);
    expect(html).toContain('Status mix');
    expect(html).toContain('>ok</button>');
  });

  it('centres a single bucket instead of pinning it to an edge', () => {
    const [r] = bars(render([{ name: 'a', color: 'blue', data: [{ t: T0, v: 1 }] }]));
    const centre = r.x + r.w / 2;
    expect(Math.abs(centre - (PLOT_LEFT + PLOT_RIGHT) / 2)).toBeLessThan(1);
  });

  it('shows the error instead of the empty message, and dims while refreshing', () => {
    const html = render([], { error: 'Search failed', refreshing: true });
    expect(html).toContain('Search failed');
    expect(html).not.toContain('No data in this time range');
    expect(render([], { emptyMessage: 'Nothing yet' })).toContain('Nothing yet');
    expect(html).toMatch(/class="[^"]*refreshing/);
  });
});
