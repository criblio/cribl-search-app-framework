/**
 * Tabular rendering for a tool result's rows.
 *
 * Lifted out of InvestigatorTranscript so the metrics card can reuse it.
 * A metrics *discovery* command (`.catalog`, `.metadata`, `.labels`, …)
 * answers with a table of metric names and cardinalities rather than a
 * time series, and it should look identical to the table a `run_search`
 * result gets — two renderers drifting apart is how one of them ends up
 * being the ugly one.
 *
 * Only React and the shared stylesheet are imported here. MetricsToolCard
 * is a separate entry point precisely to keep d3 out of the chat shell,
 * and the reverse has to hold too: pulling the table in must not drag the
 * transcript's agent-loop types and design-system Button along with it.
 */
import { useMemo } from 'react';
import s from './InvestigatorChat.module.css';

/** Rows past this are summarized in the footer rather than rendered. The
 *  agent still receives all of them; this cap is about the human. */
export const DEFAULT_MAX_ROWS = 20;
/** Columns past this are dropped. The card is a preview, not a grid. */
export const DEFAULT_MAX_COLS = 8;

export interface ResultTableProps {
  /** Rows to render. Sparse and heterogeneous is expected. */
  rows: Record<string, unknown>[];
  /** Total rows the tool produced, when that exceeds what was handed in.
   *  Defaults to `rows.length`. */
  rowCount?: number;
  maxRows?: number;
  maxCols?: number;
}

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

export function ResultTable({
  rows,
  rowCount,
  maxRows = DEFAULT_MAX_ROWS,
  maxCols = DEFAULT_MAX_COLS,
}: ResultTableProps) {
  const { cols, shown } = useMemo(() => {
    const shown = rows.slice(0, maxRows);
    return { cols: inferColumns(shown, maxCols), shown };
  }, [rows, maxRows, maxCols]);

  const hidden = Math.max(rowCount ?? rows.length, rows.length) - shown.length;

  return (
    <div className={s.toolResult}>
      <table className={s.toolResultTable}>
        <thead>
          <tr>
            {cols.map((col) => (
              <th key={col}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i}>
              {cols.map((col) => (
                <td key={col}>{formatCell(row[col])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 && (
        <div className={s.toolResultMeta}>
          … {hidden} more row{hidden === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}
