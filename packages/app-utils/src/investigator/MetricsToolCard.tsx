/**
 * Card for run_metrics_query results inside the Investigator transcript:
 * range queries render as a line chart, instant queries as a bar list —
 * so the human sees the shape of what the agent just measured instead of
 * a silent tool call. Discovery commands (`.catalog`, `.metadata`,
 * `.labels`, `.series`, `.values`) have no `_value` to plot and render as
 * a table instead.
 *
 * This is a viz-coupled opt-in: it pulls the d3-based `viz` kit, so it is
 * NOT wired into InvestigatorChat itself (which stays viz/d3-free). Apps
 * that ship the run_metrics_query tool render it via the shell's
 * `renderToolCard` hook:
 *
 *   import MetricsToolCard from '@cribl/app-utils/investigator/metrics-tool-card';
 *   renderToolCard={(ui) => ui.kind === 'metrics'
 *     ? <MetricsToolCard ui={ui as MetricsQueryUi} /> : null}
 */
import { LineChart, BarList, seriesColor, formatCompact, type LineSeries } from '../viz/index.js';
import type { MetricsQueryUi } from '../agent-tools.js';
import { formatCell, inferColumns } from './resultRows.js';
import s from './MetricsToolCard.module.css';

const MAX_CHART_SERIES = 8;
const MAX_BARS = 10;

function barLabel(row: Record<string, unknown>): string {
  const values = Object.entries(row)
    .filter(([key, value]) => key !== '_time' && key !== '_value' && typeof value === 'string' && value)
    .map(([, value]) => value as string);
  return values.length > 0 ? values.join(' · ') : 'value';
}

export default function MetricsToolCard({ ui }: { ui: MetricsQueryUi }) {
  const chartSeries: LineSeries[] = (ui.series ?? [])
    .slice(0, MAX_CHART_SERIES)
    .map((sr, i) => ({
      name: sr.name,
      color: seriesColor(i),
      data: sr.points,
      format: formatCompact,
    }));

  const rows = ui.rows ?? [];
  const bars = rows
    .filter((row) => typeof row._value === 'number' && Number.isFinite(row._value))
    .map((row) => ({ label: barLabel(row), value: row._value as number }));

  // A discovery command (`.catalog`, `.metadata`, `.labels`, `.series`,
  // `.values`) answers with a table of names and cardinalities — no
  // `_value`, so nothing to plot. Rendering those rows as "No data
  // returned" was reporting a successful answer as an empty one.
  //
  // `mode` is authoritative when the tool sets it; the row shape is the
  // fallback, because a transcript replayed from a session recorded
  // against an older framework has rows and no mode.
  const discovery = ui.mode === 'discovery' || (rows.length > 0 && bars.length === 0);

  return (
    <div className={s.card}>
      <div className={s.header}>
        <span className={s.badge}>metrics</span>
        <span className={s.description}>{ui.description || 'Metrics query'}</span>
      </div>
      <code className={s.query}>{ui.query}</code>
      {ui.error ? (
        <div className={s.error}>{ui.error}</div>
      ) : ui.series ? (
        chartSeries.length > 0 ? (
          <LineChart
            title={ui.description || 'Result'}
            subtitle={`${ui.earliest} → ${ui.latest}, step ${ui.step}s${
              (ui.series?.length ?? 0) > MAX_CHART_SERIES
                ? ` — showing top ${MAX_CHART_SERIES} of ${ui.series?.length} series`
                : ''
            }`}
            series={chartSeries}
            height={200}
          />
        ) : (
          <div className={s.empty}>No series returned</div>
        )
      ) : bars.length > 0 ? (
        <div className={s.bars}>
          <BarList items={bars} maxItems={MAX_BARS} format={formatCompact} />
          {bars.length > MAX_BARS && (
            <div className={s.more}>+{bars.length - MAX_BARS} more series (all fed to the agent)</div>
          )}
        </div>
      ) : discovery ? (
        <>
          {ui.note && <div className={s.note}>{ui.note}</div>}
          <DiscoveryTable rows={rows} />
        </>
      ) : (
        <div className={s.empty}>
          {ui.note ?? 'No data returned'}
        </div>
      )}
    </div>
  );
}

/** Rows shown before the rest are summarized. */
const MAX_DISCOVERY_ROWS = 20;

/**
 * The discovery table.
 *
 * Deliberately a local copy of the transcript's `ResultTable` rather than
 * an import of it. This module is its own package entry point, and a
 * stylesheet reachable from two entry points is code-split by esm.sh into
 * a `.css.mjs` — raw CSS in a `.mjs` file, which an esbuild consumer
 * parses as JavaScript and dies on. Importing the transcript's table
 * would pull the transcript's stylesheet in here and do exactly that. The
 * column and cell logic is shared through `resultRows.ts`, which has no
 * CSS to split.
 */
function DiscoveryTable({ rows }: { rows: Record<string, unknown>[] }) {
  const shown = rows.slice(0, MAX_DISCOVERY_ROWS);
  const cols = inferColumns(shown);
  const hidden = rows.length - shown.length;
  return (
    <div className={s.table}>
      <table className={s.tableGrid}>
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
        <div className={s.more}>
          … {hidden} more row{hidden === 1 ? '' : 's'} (all fed to the agent)
        </div>
      )}
    </div>
  );
}
