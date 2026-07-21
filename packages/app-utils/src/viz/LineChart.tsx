/**
 * Multi-series line chart with crosshair hover tooltip, axes, and gridlines.
 * Ported from the APM app's LineChart and adjusted to the dataviz specs:
 * solid hairline gridlines, value-first tooltip rows with line keys, and an
 * optional ~10%-opacity area wash for single-series traffic charts.
 *
 * Interactions (all optional):
 * - Legend click isolates a series (click again to restore); shift-click
 *   toggles individual series visibility.
 * - `onSeriesClick`: clicking on/near a line drills into the entity behind
 *   it (the tooltip highlights the target and hints at the click).
 * - `onBrush`: dragging horizontally selects a time window (a drag past a
 *   small threshold is a brush; anything shorter is treated as a click, so
 *   both interactions coexist).
 *
 * Resizes to its container width via ResizeObserver so it composes into
 * flexible grids without per-parent width plumbing.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { scaleLinear, scaleTime } from 'd3-scale';
import { line as d3Line, area as d3Area, curveMonotoneX } from 'd3-shape';
import { max as d3Max, min as d3Min, bisector } from 'd3-array';
import { timeFormat } from 'd3-time-format';
import s from './LineChart.module.css';

export interface LineSeries {
  name: string;
  color: string;
  /** Points with t in epoch milliseconds. */
  data: Array<{ t: number; v: number }>;
  format?: (v: number) => string;
  /** Opaque payload for click handlers (e.g. source labels for routing). */
  meta?: Record<string, string>;
}

interface Props {
  title: string;
  subtitle?: string;
  series: LineSeries[];
  yFormat?: (v: number) => string;
  yMax?: number;
  height?: number;
  /** Fill under each line at 10% opacity (traffic-style charts). */
  area?: boolean;
  emptyMessage?: string;
  error?: string | null;
  /** Dim the previous render while fresh data loads (non-destructive refresh). */
  refreshing?: boolean;
  /** Called when the user clicks on/near a line — drill into that entity. */
  onSeriesClick?: (series: LineSeries) => void;
  /** Called when the user drags out a time window (epoch ms bounds). */
  onBrush?: (startMs: number, endMs: number) => void;
  /** Vertical marker lines (epoch ms) — e.g. a pinned timestamp. */
  markers?: number[];
  /** Called when the user clicks the plot away from any line. */
  onTimeClick?: (tMs: number) => void;
}

const M = { top: 8, right: 12, bottom: 22, left: 56 };
const BRUSH_THRESHOLD_PX = 6;
const SERIES_HIT_PX = 24;

function defaultFormat(v: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v === 0) return '0';
  return v.toFixed(Math.abs(v) < 10 ? 2 : 0);
}

export default function LineChart({
  title,
  subtitle,
  series,
  yFormat,
  yMax,
  height = 190,
  area = false,
  emptyMessage = 'No data in this time range',
  error,
  refreshing = false,
  onSeriesClick,
  onBrush,
  markers,
  onTimeClick,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
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

  const chartWidth = Math.max(200, width);
  const innerW = chartWidth - M.left - M.right;
  const innerH = height - M.top - M.bottom;

  // A stale isolation (series renamed / dropped out of topk) is ignored
  // rather than blanking the chart.
  const isolationActive = isolated != null && series.some((sr) => sr.name === isolated);
  const visibleSeries = useMemo(() => {
    if (isolationActive) return series.filter((sr) => sr.name === isolated);
    return series.filter((sr) => !hidden.has(sr.name));
  }, [series, isolated, isolationActive, hidden]);

  const { xScale, yScale, paths, tickX, tickY, hasData, spanMs } = useMemo(() => {
    const allPts: Array<{ t: number; v: number }> = [];
    for (const sr of visibleSeries) allPts.push(...sr.data);
    if (allPts.length === 0) {
      return { xScale: null, yScale: null, paths: [], tickX: [], tickY: [], hasData: false, spanMs: 0 };
    }
    const xMin = d3Min(allPts, (d) => d.t) ?? 0;
    const xMax = d3Max(allPts, (d) => d.t) ?? 1;
    const dataMax = d3Max(allPts, (d) => d.v) ?? 1;
    // All-zero data still needs a real domain (else ticks collapse to 0.00s).
    const yResolved = yMax ?? (dataMax > 0 ? dataMax : 1);
    const x = scaleTime().domain([xMin, xMax]).range([0, innerW]);
    const y = scaleLinear()
      .domain([0, yResolved * 1.1])
      .range([innerH, 0]);
    const lineGen = d3Line<{ t: number; v: number }>()
      .x((d) => x(d.t))
      .y((d) => y(d.v))
      .curve(curveMonotoneX)
      .defined((d) => Number.isFinite(d.v));
    const areaGen = d3Area<{ t: number; v: number }>()
      .x((d) => x(d.t))
      .y0(innerH)
      .y1((d) => y(d.v))
      .curve(curveMonotoneX)
      .defined((d) => Number.isFinite(d.v));
    const tickCount = Math.max(3, Math.min(6, Math.floor(innerW / 80)));
    return {
      xScale: x,
      yScale: y,
      paths: visibleSeries.map((sr) => ({
        ...sr,
        d: lineGen(sr.data) ?? '',
        a: area ? (areaGen(sr.data) ?? '') : '',
      })),
      tickX: x.ticks(tickCount),
      tickY: y.ticks(4),
      hasData: true,
      spanMs: xMax - xMin,
    };
  }, [visibleSeries, innerW, innerH, yMax, area]);

  const fmtTick = spanMs > 26 * 3600 * 1000 ? timeFormat('%b %d %H:%M') : timeFormat('%H:%M');
  const yFmt = yFormat ?? series[0]?.format ?? defaultFormat;

  const hoverSamples = useMemo(() => {
    if (hover == null || !xScale || !yScale) return null;
    const tHover = xScale.invert(hover.x).getTime();
    const bisect = bisector<{ t: number; v: number }, number>((d) => d.t).left;
    const samples: Array<{ name: string; color: string; t: number; v: number; formatted: string }> = [];
    let nearestT = tHover;
    let nearestSeries: string | null = null;
    let nearestDy = Infinity;
    for (const sr of visibleSeries) {
      if (sr.data.length === 0) continue;
      const i = bisect(sr.data, tHover);
      const a = sr.data[Math.max(0, i - 1)];
      const b = sr.data[Math.min(sr.data.length - 1, i)];
      const nearest = !a ? b : !b ? a : Math.abs(a.t - tHover) < Math.abs(b.t - tHover) ? a : b;
      if (nearest) {
        nearestT = nearest.t;
        const dy = Math.abs(yScale(nearest.v) - hover.y);
        if (dy < nearestDy) {
          nearestDy = dy;
          nearestSeries = sr.name;
        }
        samples.push({
          name: sr.name,
          color: sr.color,
          t: nearest.t,
          v: nearest.v,
          formatted: (sr.format ?? yFmt)(nearest.v),
        });
      }
    }
    samples.sort((a, b) => b.v - a.v);
    return {
      t: nearestT,
      samples,
      target: nearestDy <= SERIES_HIT_PX ? nearestSeries : null,
    };
  }, [hover, visibleSeries, xScale, yScale, yFmt]);

  const brushing = drag != null && Math.abs(drag.x1 - drag.x0) > BRUSH_THRESHOLD_PX;
  const drillTarget = onSeriesClick && !brushing ? (hoverSamples?.target ?? null) : null;

  const toLocal = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left - M.left, y: e.clientY - rect.top - M.top };
  };

  const finishDrag = () => {
    if (!drag) return;
    setDrag(null);
    if (!xScale) return;
    const lo = Math.max(0, Math.min(drag.x0, drag.x1));
    const hi = Math.min(innerW, Math.max(drag.x0, drag.x1));
    if (brushing && onBrush) {
      const t0 = xScale.invert(lo).getTime();
      const t1 = xScale.invert(hi).getTime();
      if (t1 - t0 >= 1000) onBrush(t0, t1);
      return;
    }
    // Short drag = click.
    if (drillTarget && onSeriesClick) {
      const sr = series.find((candidate) => candidate.name === drillTarget);
      if (sr) onSeriesClick(sr);
      return;
    }
    if (onTimeClick && hoverSamples) onTimeClick(hoverSamples.t);
  };

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
          style={{ cursor: brushing ? 'col-resize' : drillTarget ? 'pointer' : undefined }}
          onMouseDown={(e) => {
            const p = toLocal(e);
            if (p.x >= 0 && p.x <= innerW) setDrag({ x0: p.x, x1: p.x });
          }}
          onMouseMove={(e) => {
            const p = toLocal(e);
            setHover(p.x >= 0 && p.x <= innerW ? p : null);
            if (drag) setDrag({ ...drag, x1: Math.max(0, Math.min(innerW, p.x)) });
          }}
          onMouseUp={finishDrag}
          onMouseLeave={() => {
            setHover(null);
            setDrag(null);
          }}
        >
          <g transform={`translate(${M.left},${M.top})`}>
            {hasData &&
              tickY.map((t, i) => (
                <g key={`gy-${i}`}>
                  <line
                    x1={0}
                    x2={innerW}
                    y1={yScale!(t)}
                    y2={yScale!(t)}
                    stroke="var(--cds-color-border-subtle)"
                    strokeWidth={1}
                  />
                  {/* Skip a label identical to its neighbor's (coarse formatter
                      on a fine tick step, e.g. 0.01/0.01/0.01). */}
                  {(i === 0 || yFmt(t) !== yFmt(tickY[i - 1])) && (
                    <text
                      x={-8}
                      y={yScale!(t)}
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
            {hasData &&
              tickX.map((t, i) => (
                <text
                  key={`xt-${i}`}
                  x={xScale!(t)}
                  y={innerH + 14}
                  textAnchor="middle"
                  fill="var(--cds-color-fg-muted)"
                  fontSize={11}
                >
                  {fmtTick(t)}
                </text>
              ))}
            <line
              x1={0}
              x2={innerW}
              y1={innerH}
              y2={innerH}
              stroke="var(--cds-color-border)"
              strokeWidth={1}
            />
            {paths.map((p) =>
              p.a ? <path key={`a-${p.name}`} d={p.a} fill={p.color} opacity={0.1} /> : null,
            )}
            {paths.map((p) => (
              <path
                key={p.name}
                d={p.d}
                fill="none"
                stroke={p.color}
                strokeWidth={drillTarget === p.name ? 3 : 2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {hasData &&
              xScale &&
              (markers ?? []).map((t, i) => {
                const mx = xScale(new Date(t));
                if (mx < 0 || mx > innerW) return null;
                return (
                  <line
                    key={`mk-${i}`}
                    x1={mx}
                    x2={mx}
                    y1={0}
                    y2={innerH}
                    stroke="var(--cds-color-fg-warning, #b3670f)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                  />
                );
              })}
            {hasData && brushing && drag && (
              <rect
                x={Math.min(drag.x0, drag.x1)}
                y={0}
                width={Math.abs(drag.x1 - drag.x0)}
                height={innerH}
                fill="var(--cds-color-fg-link, #2a78d6)"
                opacity={0.12}
                pointerEvents="none"
              />
            )}
            {hasData && hover != null && hoverSamples && !brushing && (
              <g pointerEvents="none">
                <line
                  x1={xScale!(new Date(hoverSamples.t))}
                  x2={xScale!(new Date(hoverSamples.t))}
                  y1={0}
                  y2={innerH}
                  stroke="var(--cds-color-fg-subtle)"
                  strokeWidth={1}
                />
                {hoverSamples.samples.map((smp, i) => (
                  <circle
                    key={i}
                    cx={xScale!(new Date(smp.t))}
                    cy={yScale!(smp.v)}
                    r={smp.name === drillTarget ? 5 : 4}
                    fill={smp.color}
                    stroke="var(--cds-color-bg)"
                    strokeWidth={2}
                  />
                ))}
              </g>
            )}
          </g>
        </svg>
      </div>

      {!hasData && !error && <div className={s.empty}>{emptyMessage}</div>}
      {error && <div className={s.error}>{error}</div>}

      {hasData && hover != null && hoverSamples && hoverSamples.samples.length > 0 && !brushing && (
        <div
          className={s.tooltip}
          style={{ left: Math.min(Math.max(M.left + hover.x, 10), chartWidth - 180), top: 8 }}
        >
          <div className={s.tooltipTime}>{timeFormat('%H:%M:%S')(new Date(hoverSamples.t))}</div>
          {hoverSamples.samples.slice(0, 10).map((smp, i) => (
            <div
              key={i}
              className={`${s.tooltipRow} ${smp.name === drillTarget ? s.tooltipRowTarget : ''}`}
            >
              <span className={s.tooltipKey} style={{ background: smp.color }} />
              <span className={s.tooltipValue}>{smp.formatted}</span>
              <span className={s.tooltipSeries}>{smp.name}</span>
            </div>
          ))}
          {hoverSamples.samples.length > 10 && (
            <div className={s.tooltipMore}>+{hoverSamples.samples.length - 10} more</div>
          )}
          {drillTarget && <div className={s.tooltipHint}>Click line for details · drag to zoom</div>}
          {!drillTarget && onBrush && <div className={s.tooltipHint}>Drag to zoom</div>}
        </div>
      )}
    </div>
  );
}
