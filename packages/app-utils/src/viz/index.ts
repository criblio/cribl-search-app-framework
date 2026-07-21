/**
 * Shared dashboard viz kit: d3-based charts and panel primitives styled
 * with the Cribl Design System tokens (see styles/tokens.css). Consumers
 * need react + d3-array/d3-scale/d3-shape/d3-time-format installed.
 */

export { default as LineChart, type LineSeries } from './LineChart.js';
export { default as Sparkline } from './Sparkline.js';
export { default as Panel } from './Panel.js';
export { default as StatTile } from './StatTile.js';
export { default as BarList, type BarListItem } from './BarList.js';
export { default as DataTable, type Column } from './DataTable.js';
export { SERIES_COLORS, MAX_SERIES, seriesColor, CHART_INK } from './palette.js';
export {
  formatBytes,
  formatBytesRate,
  formatBitsRate,
  formatCompact,
  formatDuration,
  formatPercent,
  formatSeconds,
  formatDb,
  formatValue,
  type ValueKind,
} from './format.js';
export { toLineSeries, toBarItems, indexByLabel } from './chartData.js';
