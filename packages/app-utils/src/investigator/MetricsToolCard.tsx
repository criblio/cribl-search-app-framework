/**
 * Chart card for run_metrics_query results inside the Investigator
 * transcript: range queries render as a line chart, instant queries as a
 * bar list — so the human sees the shape of what the agent just measured
 * instead of a silent tool call.
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

  const bars = (ui.rows ?? [])
    .filter((row) => typeof row._value === 'number' && Number.isFinite(row._value))
    .map((row) => ({ label: barLabel(row), value: row._value as number }));

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
      ) : (
        <div className={s.empty}>No data returned</div>
      )}
    </div>
  );
}
