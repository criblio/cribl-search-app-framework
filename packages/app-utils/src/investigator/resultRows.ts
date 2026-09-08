/**
 * Row-shaping helpers shared by every tool-result table.
 *
 * Deliberately free of any CSS import. `MetricsToolCard` and the
 * transcript are separate package entry points, and a module reachable
 * from two entry points is code-split into a shared chunk by esm.sh
 * rather than inlined into each bundle. That is harmless for JavaScript
 * — `agent-loop` and `agent` are already hoisted that way and load fine
 * — but fatal for a stylesheet, which comes back as a `.css.mjs` an
 * esbuild consumer parses as JavaScript and dies on the first rule.
 *
 * So the logic is shared here and the markup is not: each entry point
 * renders its own table against its own stylesheet. See
 * `scripts/check-css-build.mjs`, which fails the build if a stylesheet
 * ever becomes reachable from two entry points again.
 */

/** Rows past this are summarized rather than rendered. The agent still
 *  receives all of them; the cap is about the human. */
export const DEFAULT_MAX_ROWS = 20;
/** Columns past this are dropped. A card is a preview, not a grid. */
export const DEFAULT_MAX_COLS = 8;

/**
 * Pick columns most-populated first.
 *
 * Tool results are sparse and inconsistent — a discovery row may carry
 * `samplesPerMinute` while the next one doesn't — so the keys the most
 * rows share are the ones worth the limited width. Ties break
 * alphabetically to keep the header stable across renders.
 */
export function inferColumns(
  rows: Record<string, unknown>[],
  maxCols = DEFAULT_MAX_COLS,
): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const key of Object.keys(row)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key)
    .slice(0, maxCols);
}

/** Render one cell. Objects are stringified rather than dropped: a label
 *  set nested under a key is still information the reader can use. */
export function formatCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
