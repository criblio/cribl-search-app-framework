/**
 * Chart palette — validated categorical slots for the app's light surface
 * (validate_palette.js: CVD ΔE 9.1, normal-vision ΔE 19.6, all-pass on #fff).
 * Slots 3/4/5 sit below 3:1 contrast on white; the mitigation is that every
 * multi-series chart ships a legend and a hover tooltip, and tables back the
 * dashboards. Assign hues in fixed order, never cycled; past 8 series fold
 * into "Other".
 */

export const SERIES_COLORS = [
  '#2a78d6', // blue
  '#008300', // green
  '#e87ba4', // magenta
  '#eda100', // yellow
  '#1baf7a', // aqua
  '#eb6834', // orange
  '#4a3aa7', // violet
  '#e34948', // red
] as const;

export const MAX_SERIES = SERIES_COLORS.length;

export const CHART_INK = {
  primary: 'var(--cds-color-fg)',
  secondary: 'var(--cds-color-fg-muted)',
  muted: 'var(--cds-color-fg-subtle)',
  grid: 'var(--cds-color-border-subtle)',
  axis: 'var(--cds-color-border)',
  surface: 'var(--cds-color-bg)',
} as const;

export function seriesColor(index: number): string {
  return SERIES_COLORS[Math.min(index, SERIES_COLORS.length - 1)];
}
