/** Adapters from metrics API results to chart component inputs. */

import type { MetricSample, MetricSeries } from '../metrics.js';
import type { LineSeries } from './LineChart.js';
import type { BarListItem } from './BarList.js';
import { seriesColor, MAX_SERIES } from './palette.js';
import { formatValue, type ValueKind } from './format.js';

interface ToLineSeriesOptions {
  /** Derive the display name from a series' labels. Default: first label value. */
  name?: (labels: Record<string, string>) => string;
  kind?: ValueKind;
  /** Sort series by their latest value before assigning colors (default true). */
  sortByValue?: boolean;
  maxSeries?: number;
}

/**
 * Convert grouped range-query results to LineChart series.
 * Times are converted from epoch seconds to milliseconds. Hues are assigned
 * in fixed slot order after a stable sort, and series beyond the palette cap
 * are dropped (cap the query with topk() when the group is unbounded).
 */
export function toLineSeries(data: MetricSeries[] | null, opts: ToLineSeriesOptions = {}): LineSeries[] {
  if (!data) return [];
  const { name, kind = 'count', sortByValue = true, maxSeries = MAX_SERIES } = opts;
  const named = data.map((series) => ({
    name: name ? name(series.labels) : (Object.values(series.labels)[0] ?? 'value'),
    labels: series.labels,
    points: series.points.map((p) => ({ t: p.t * 1000, v: p.v })),
    last: series.points.length > 0 ? series.points[series.points.length - 1].v : 0,
  }));
  if (sortByValue) named.sort((a, b) => b.last - a.last);
  return named.slice(0, maxSeries).map((series, i) => ({
    name: series.name,
    color: seriesColor(i),
    data: series.points,
    format: (v: number) => formatValue(v, kind),
    // Source labels ride along so onSeriesClick handlers can route on them.
    meta: series.labels,
  }));
}

/** Convert instant-query samples to bar list items keyed by one label. */
export function toBarItems(
  data: MetricSample[] | null,
  label: string,
  fallback = '(none)',
): BarListItem[] {
  if (!data) return [];
  return data.map((sample) => ({
    label: sample.labels[label] || fallback,
    value: sample._value,
  }));
}

/** Index instant-query samples by a label for client-side joins. */
export function indexByLabel(
  data: MetricSample[] | null,
  label: string,
): Map<string, MetricSample> {
  const map = new Map<string, MetricSample>();
  for (const sample of data ?? []) {
    const key = sample.labels[label];
    if (key !== undefined) map.set(key, sample);
  }
  return map;
}
