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

/**
 * Deterministic identity hue (0..359) for an entity id: a 31-multiplier
 * string hash, so the same id gets the same hue in every view and every
 * session with no lookup table to persist.
 */
export function entityHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/**
 * Identity colour for an entity (a service, host, pipeline…) —
 * `hsl(<entityHue(id)>, 60%, <lightness>%)`. Pass a lower `lightness` for
 * shaded sides or shadows of the same entity.
 *
 * Identity is not health. A waterfall needs a call chain to stay followable
 * across hops (frontend → checkout → payment); colouring by health collapses
 * every bar to green/red and loses that. Scanning views add health as a
 * second channel (a row tint, a node fill with an identity ring) rather than
 * replacing identity. And unlike SERIES_COLORS this is unbounded and
 * order-independent: the slot palette is for ≤8 series in one chart, this
 * is for "the same entity looks the same everywhere".
 */
export function entityColor(id: string, lightness = 50): string {
  return `hsl(${entityHue(id)}, 60%, ${lightness}%)`;
}
