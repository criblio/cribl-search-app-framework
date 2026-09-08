/**
 * Tabular rendering for a tool result's rows.
 *
 * Renders a `run_search` result, and is exported so an app writing its own
 * card against the transcript gets the same table rather than reinventing
 * one.
 *
 * This component belongs to the `./investigator` entry point ONLY, because
 * it imports that entry's stylesheet. MetricsToolCard is a separate entry
 * point and renders its own table against its own stylesheet instead of
 * importing this one — a stylesheet reachable from two entry points gets
 * code-split by esm.sh into a `.css.mjs` that esbuild consumers cannot
 * load. The row-shaping logic both tables share lives in `resultRows.ts`,
 * which imports no CSS and is safe to share.
 */
import { useMemo } from 'react';
import {
  DEFAULT_MAX_COLS,
  DEFAULT_MAX_ROWS,
  formatCell,
  inferColumns,
} from './resultRows.js';
import s from './InvestigatorChat.module.css';

export interface ResultTableProps {
  /** Rows to render. Sparse and heterogeneous is expected. */
  rows: Record<string, unknown>[];
  /** Total rows the tool produced, when that exceeds what was handed in.
   *  Defaults to `rows.length`. */
  rowCount?: number;
  maxRows?: number;
  maxCols?: number;
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
