/**
 * Normalization for `kind: 'report'` tool results.
 *
 * GoatTown's generic report tool answers with a headline and one markdown
 * document. The framework had no card for that kind, so it fell through to
 * whatever the app did with unknown payloads — in practice `JSON.stringify`,
 * which put an entire investigation on screen as escaped JSON.
 *
 * The shape this maps onto is the one the transcript already renders:
 * a summary's findings are exactly "a heading plus the prose under it",
 * which is what a report's markdown already is. So the report is split at
 * its headings and handed to the existing summary card rather than getting
 * a fourth card that would drift from it. This mirrors what APM has shipped
 * against its own transport; lifting it here lets every app — and APM —
 * stop carrying a copy.
 *
 * CSS-free on purpose, so it stays safe to share across entry points (see
 * `scripts/check-css-build.mjs`).
 */
import type { SummaryUi } from '../agent-tools.js';

/** UI payload for a report tool execution: a headline plus a markdown body. */
export type ReportResultUi = {
  kind: 'report';
  /** One-line conclusion. Rendered as the card's conclusion. */
  headline?: string;
  /** The report itself, as markdown. */
  report?: string;
} & Record<string, unknown>;

/** Fallback section label for a report whose body opens without a heading. */
const DEFAULT_SECTION = 'Investigation findings';

/**
 * Split a markdown body into summary findings at its headings.
 *
 * Only `#` through `###` split. Deeper headings stay inside the section
 * body, because a report that uses `####` for sub-points would otherwise
 * shatter into one section per sub-point and lose the nesting entirely.
 */
export function reportSections(markdown: string): SummaryUi['findings'] {
  const findings: SummaryUi['findings'] = [];
  let category = DEFAULT_SECTION;
  let lines: string[] = [];
  const flush = () => {
    const details = lines.join('\n').trim();
    if (details) findings.push({ category, details });
    lines = [];
  };
  for (const line of markdown.split('\n')) {
    const heading = /^#{1,3}\s+(.+)$/.exec(line.trim());
    if (heading) {
      flush();
      category = heading[1].trim();
    } else {
      lines.push(line);
    }
  }
  flush();
  // A body with no headings at all is still worth showing whole rather
  // than dropping it for failing to match the expected shape.
  return findings.length > 0
    ? findings
    : markdown.trim()
      ? [{ category, details: markdown.trim() }]
      : [];
}

/** Convert a report payload into the summary shape the transcript renders. */
export function reportToSummary(ui: ReportResultUi): SummaryUi {
  return {
    kind: 'summary',
    findings: reportSections(typeof ui.report === 'string' ? ui.report : ''),
    conclusion: typeof ui.headline === 'string' ? ui.headline : '',
  };
}
