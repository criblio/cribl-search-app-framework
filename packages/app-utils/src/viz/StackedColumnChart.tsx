/**
 * Stacked column chart over time buckets — status mixes, per-class counts,
 * anything where both the total and its composition matter. Ported from the
 * APM app's Status mix card and aligned with LineChart: same props for the
 * shared concerns (title, yFormat, height, error, refreshing, emptyMessage),
 * the same legend isolate/toggle, and LineChart's stylesheet, so the two
 * sit side by side in a grid as one system.
 *
 * Series order is stack order, bottom to top. Each column is centred on its
 * bucket timestamp; the x domain is padded by half a bucket so the first and
 * last columns are not cut in half at the plot edges.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { scaleLinear, scaleTime } from 'd3-scale';
import { timeFormat } from 'd3-time-format';
import s from './LineChart.module.css';
import { stackColumns, type StackedSeries } from './stackColumns.js';

export type { StackedSeries } from './stackColumns.js';

interface Props {
  title: string;
  subtitle?: string;
  /** Stack order, bottom to top. */
  series: StackedSeries[];
  yFormat?: (v: number) => string;
  height?: number;
  emptyMessage?: string;
  error?: string | null;
  /** Dim the previous render while fresh data loads (non-destructive refresh). */
  refreshing?: boolean;
}

const M = { top: 8, right: 12, bottom: 22, left: 56 };
const MAX_BAR_PX = 64;

function defaultFormat(v: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v === 0) return '0';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export default function StackedColumnChart({
  title,
  subtitle,
  series,
  yFormat,
  height = 190,
  emptyMessage = 'No data in this time range',
  error,
  refreshing = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);
  const [isolated, setIsolated] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 0)
        setWidth(
          Math.floor(r.width - 2 * parseInt(getComputedStyle(el).paddingLeft || '0', 10)) || 600,
        );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const yFmt = yFormat ?? defaultFormat;

  const isolationActive = isolated != null && series.some((sr) => sr.name === isolated);
  const visibleSeries = useMemo(() => {
    if (isolationActive) return series.filter((sr) => sr.name === isolated);
    return series.filter((sr) => !hidden.has(sr.name));
  }, [series, isolated, isolationActive, hidden]);

  const stacked = useMemo(() => stackColumns(visibleSeries), [visibleSeries]);
  // Sized against ALL series so toggling the legend doesn't shift the plot.
  const fullMax = useMemo(() => stackColumns(series).totalMax, [series]);

  const mLeft = useMemo(() => {
    const ticks = scaleLinear()
      .domain([0, Math.max(fullMax * 1.1, 1)])
      .ticks(4);
    const maxChars = ticks.reduce((m, t) => Math.max(m, yFmt(t).length), 1);
    return Math.max(M.left, Math.ceil(maxChars * 6.2) + 14);
  }, [fullMax, yFmt]);

  const chartWidth = Math.max(200, width);
  const innerW = chartWidth - mLeft - M.right;
  const innerH = height - M.top - M.bottom;

  const layout = useMemo(() => {
    const { buckets, step, totalMax } = stacked;
    if (buckets.length === 0) return null;
    const first = buckets[0].t;
    const last = buckets[buckets.length - 1].t;
    // One bucket has no spacing to measure; give it a nominal minute. (Not
    // 1 ms: Date truncates fractional ms, so a ±0.5 ms pad collapses.)
    const slot = step > 0 ? step : 60_000;
    const x = scaleTime()
      .domain([first - slot / 2, last + slot / 2])
      .range([0, innerW]);
    const y = scaleLinear()
      .domain([0, Math.max(totalMax * 1.1, 1)])
      .range([innerH, 0]);
    const slotPx = x(first + slot) - x(first);
    const barWidth = Math.min(MAX_BAR_PX, Math.max(1, slotPx * (buckets.length > 30 ? 0.92 : 0.8)));
    const tickCount = Math.max(3, Math.min(6, Math.floor(innerW / 80)));
    return {
      buckets,
      x,
      y,
      barWidth,
      tickX: x.ticks(tickCount),
      tickY: y.ticks(4),
      spanMs: last - first,
    };
  }, [stacked, innerW, innerH]);

  const fmtTick =
    (layout?.spanMs ?? 0) > 26 * 3600 * 1000 ? timeFormat('%b %d %H:%M') : timeFormat('%H:%M');
  const hoverRow = layout && hoverT != null ? (layout.buckets.find((b) => b.t === hoverT) ?? null) : null;

  const toggleLegend = (name: string, shift: boolean) => {
    if (shift) {
      setIsolated(null);
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      return;
    }
    setHidden(new Set());
    setIsolated((prev) => (prev === name ? null : name));
  };

  const formatFor = (name: string) => series.find((sr) => sr.name === name)?.format ?? yFmt;

  return (
    <div className={s.wrap} ref={wrapRef}>
      <div className={s.header}>
        <div>
          <div className={s.title}>{title}</div>
          {subtitle && <div className={s.subtitle}>{subtitle}</div>}
        </div>
        {series.length > 1 && (
          <div className={s.legend}>
            {series.map((sr) => {
              const dimmed = isolationActive ? sr.name !== isolated : hidden.has(sr.name);
              return (
                <button
                  key={sr.name}
                  type="button"
                  className={`${s.legendItem} ${dimmed ? s.legendItemDim : ''}`}
                  title="Click to isolate; shift-click to toggle"
                  onClick={(e) => toggleLegend(sr.name, e.shiftKey)}
                >
                  <span className={s.legendSwatch} style={{ background: sr.color }} />
                  {sr.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className={refreshing ? s.refreshing : undefined}>
        <svg
          className={s.svg}
          width={chartWidth}
          height={height}
          onMouseMove={(e) => {
            if (!layout) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const px = e.clientX - rect.left - mLeft;
            if (px < 0 || px > innerW) {
              setHoverT(null);
              return;
            }
            const tHover = layout.x.invert(px).getTime();
            let best = layout.buckets[0];
            for (const b of layout.buckets) if (Math.abs(b.t - tHover) < Math.abs(best.t - tHover)) best = b;
            setHoverT(best.t);
            setHoverX(px);
          }}
          onMouseLeave={() => setHoverT(null)}
        >
          <g transform={`translate(${mLeft},${M.top})`}>
            {layout &&
              layout.tickY.map((t, i) => (
                <g key={`gy-${i}`}>
                  <line
                    x1={0}
                    x2={innerW}
                    y1={layout.y(t)}
                    y2={layout.y(t)}
                    stroke="var(--cds-color-border-subtle)"
                    strokeWidth={1}
                  />
                  {(i === 0 || yFmt(t) !== yFmt(layout.tickY[i - 1])) && (
                    <text
                      x={-8}
                      y={layout.y(t)}
                      textAnchor="end"
                      dominantBaseline="middle"
                      fill="var(--cds-color-fg-muted)"
                      fontSize={11}
                    >
                      {yFmt(t)}
                    </text>
                  )}
                </g>
              ))}
            {layout &&
              layout.tickX.map((t, i) => (
                <text
                  key={`xt-${i}`}
                  x={layout.x(t)}
                  y={innerH + 14}
                  textAnchor="middle"
                  fill="var(--cds-color-fg-muted)"
                  fontSize={11}
                >
                  {fmtTick(t)}
                </text>
              ))}
            {layout &&
              layout.buckets.map((b) => {
                const left = layout.x(b.t) - layout.barWidth / 2;
                const dim = hoverRow != null && hoverRow.t !== b.t;
                return (
                  <g key={b.t} opacity={dim ? 0.55 : 1}>
                    {b.segments.map((seg) => (
                      <rect
                        key={seg.name}
                        x={left}
                        y={layout.y(seg.y1)}
                        width={layout.barWidth}
                        height={Math.max(0, layout.y(seg.y0) - layout.y(seg.y1))}
                        fill={seg.color}
                      />
                    ))}
                  </g>
                );
              })}
            <line
              x1={0}
              x2={innerW}
              y1={innerH}
              y2={innerH}
              stroke="var(--cds-color-border)"
              strokeWidth={1}
            />
          </g>
        </svg>
      </div>

      {!layout && !error && <div className={s.empty}>{emptyMessage}</div>}
      {error && <div className={s.error}>{error}</div>}

      {layout && hoverRow && hoverRow.segments.length > 0 && (
        <div
          className={s.tooltip}
          style={{ left: Math.min(Math.max(mLeft + hoverX, 10), chartWidth - 180), top: 8 }}
        >
          <div className={s.tooltipTime}>{timeFormat('%H:%M:%S')(new Date(hoverRow.t))}</div>
          {/* Top of the column first — the order the eye reads the stack. */}
          {[...hoverRow.segments].reverse().map((seg) => (
            <div key={seg.name} className={s.tooltipRow}>
              <span className={s.tooltipKey} style={{ background: seg.color }} />
              <span className={s.tooltipValue}>{formatFor(seg.name)(seg.value)}</span>
              <span className={s.tooltipSeries}>{seg.name}</span>
            </div>
          ))}
          {hoverRow.segments.length > 1 && (
            <div className={s.tooltipHint}>Total {yFmt(hoverRow.total)}</div>
          )}
        </div>
      )}
    </div>
  );
}
