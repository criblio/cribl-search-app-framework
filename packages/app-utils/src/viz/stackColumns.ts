/** Pure stacking for StackedColumnChart — separated so it is testable without a DOM. */

export interface StackedSeries {
  name: string;
  color: string;
  /** Per-bucket values keyed by epoch ms. A missing bucket counts as zero. */
  data: Array<{ t: number; v: number }>;
  format?: (v: number) => string;
}

export interface StackedSegment {
  name: string;
  color: string;
  value: number;
  /** Bottom and top of the segment in value units. */
  y0: number;
  y1: number;
}

export interface StackedBucket {
  t: number;
  /** Bottom-to-top, in series order. Non-positive and non-finite values are omitted. */
  segments: StackedSegment[];
  total: number;
}

export interface StackedColumns {
  buckets: StackedBucket[];
  /** Smallest gap between adjacent buckets (ms); 0 with fewer than two buckets. */
  step: number;
  totalMax: number;
}

/**
 * Pivot per-series points into time buckets stacked in series order
 * (series[0] at the bottom). Duplicate points for one series in one bucket
 * are summed.
 */
export function stackColumns(series: readonly StackedSeries[]): StackedColumns {
  const byBucket = new Map<number, Map<number, number>>();
  series.forEach((sr, si) => {
    for (const pt of sr.data) {
      if (!Number.isFinite(pt.t)) continue;
      let row = byBucket.get(pt.t);
      if (!row) {
        row = new Map();
        byBucket.set(pt.t, row);
      }
      row.set(si, (row.get(si) ?? 0) + (Number.isFinite(pt.v) ? pt.v : 0));
    }
  });
  const ts = [...byBucket.keys()].sort((a, b) => a - b);
  let totalMax = 0;
  const buckets = ts.map((t) => {
    const row = byBucket.get(t)!;
    let running = 0;
    const segments: StackedSegment[] = [];
    series.forEach((sr, si) => {
      const value = row.get(si) ?? 0;
      if (value > 0) {
        segments.push({ name: sr.name, color: sr.color, value, y0: running, y1: running + value });
        running += value;
      }
    });
    if (running > totalMax) totalMax = running;
    return { t, segments, total: running };
  });
  // Bar width comes from the tightest spacing, not width / count: a gap in
  // the data (missing buckets) must not fatten every bar into its neighbour.
  let step = 0;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (gap > 0 && (step === 0 || gap < step)) step = gap;
  }
  return { buckets, step, totalMax };
}
