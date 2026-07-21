/**
 * Generic force-directed network graph: SVG scene with pan/zoom, node
 * dragging (click-vs-drag threshold), value-weighted edges, and default
 * circle+label node rendering that callers can override per node.
 *
 * The physics (useForceLayout) and viewport (usePanZoom) hooks are also
 * exported standalone for apps with bespoke renderers (e.g. APM's
 * DependencyGraph/IsometricGraph).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useForceLayout, type ForceConfig, type ForceLink, type ForceNode } from './useForceLayout.js';
import { usePanZoom } from './usePanZoom.js';
import ZoomControls from './ZoomControls.js';
import s from './NetworkGraph.module.css';

export interface NetworkGraphProps<N extends ForceNode, L extends ForceLink<N>> {
  nodes: N[];
  links: L[];
  width: number;
  height: number;
  nodeRadius: (n: N) => number;
  /** Edge stroke width in px (default: 1.5). */
  edgeWidth?: (l: L) => number;
  edgeColor?: (l: L) => string;
  /** Dash pattern (e.g. "4 3" for wireless links); undefined = solid. */
  edgeDash?: (l: L) => string | undefined;
  /** Short label drawn at the edge midpoint (e.g. a traffic rate). */
  edgeLabel?: (l: L) => string | null;
  nodeFill?: (n: N) => string;
  nodeStroke?: (n: N) => string;
  nodeLabel?: (n: N) => string;
  /** Extra content per node (badges, icons) rendered over the circle. */
  renderNodeContent?: (n: N, r: number) => ReactNode;
  /** Fired on click (not drag). */
  onNodeClick?: (n: N) => void;
  onNodeHover?: (n: N | null) => void;
  /** Node id to anchor a floating annotation (tooltip/card) to. The
   *  annotation tracks the node through simulation movement and
   *  pan/zoom. */
  annotationNodeId?: string | null;
  /** Content of the floating annotation for the anchored node. */
  renderAnnotation?: (n: N) => ReactNode;
  forces?: ForceConfig;
}

const DRAG_THRESHOLD = 4;

export default function NetworkGraph<N extends ForceNode, L extends ForceLink<N>>({
  nodes,
  links,
  width,
  height,
  nodeRadius,
  edgeWidth = () => 1.5,
  edgeColor = () => 'var(--cds-color-border)',
  edgeDash = () => undefined,
  edgeLabel = () => null,
  nodeFill = () => 'var(--cds-color-bg-subtle)',
  nodeStroke = () => 'var(--cds-color-border)',
  nodeLabel = (n) => n.id,
  renderNodeContent,
  onNodeClick,
  onNodeHover,
  annotationNodeId,
  renderAnnotation,
  forces,
}: NetworkGraphProps<N, L>) {
  const { simNodesRef, simLinksRef, tick, pinNode, releaseNode } = useForceLayout<N, L>({
    nodes,
    links,
    width,
    height,
    nodeRadius,
    forces,
  });
  const panZoom = usePanZoom(width, height);
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null);
  const autoFitRef = useRef(true);
  const fitTransformRef = useRef<string | null>(null);

  // Keep the graph centered while the simulation settles: fit immediately
  // on the first paint (layouts arrive pre-settled, so the first tick is
  // already representative), then refit every few ticks during any gentle
  // follow-up animation — until the user takes over the viewport (wheel
  // zoom, pan, or a node drag), detected by the live transform no longer
  // matching the one the last auto-fit installed.
  useEffect(() => {
    if (!autoFitRef.current || (tick > 8 && tick % 4 !== 0)) return;
    if (
      fitTransformRef.current != null &&
      fitTransformRef.current !== JSON.stringify(panZoom.transform)
    ) {
      autoFitRef.current = false;
      return;
    }
    const simNodes = simNodesRef.current;
    if (simNodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of simNodes) {
      if (n.x == null || n.y == null) continue;
      const r = nodeRadius(n);
      minX = Math.min(minX, n.x - r);
      minY = Math.min(minY, n.y - r);
      maxX = Math.max(maxX, n.x + r);
      maxY = Math.max(maxY, n.y + r);
    }
    if (Number.isFinite(minX)) {
      // Mirror fitToBounds' math (padding 60, scale cap 0.85) so the
      // next pass can tell "still where auto-fit left it" from "user
      // moved the viewport".
      const bw = maxX - minX + 120;
      const bh = maxY - minY + 120;
      const scale = Math.min(width / bw, height / bh, 0.85);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      panZoom.fitToBounds({ minX, minY, maxX, maxY });
      fitTransformRef.current = JSON.stringify({
        tx: width / 2 - cx * scale,
        ty: height / 2 - cy * scale,
        scale,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const onNodePointerDown = (e: React.PointerEvent<SVGGElement>, n: N) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const svg = panZoom.svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    dragRef.current = {
      id: n.id,
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      moved: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
  };

  const onNodePointerMove = (e: React.PointerEvent<SVGGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const svg = panZoom.svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (!drag.moved && Math.hypot(sx - drag.startX, sy - drag.startY) > DRAG_THRESHOLD) {
      drag.moved = true;
      // A node drag means the user has taken over the scene — stop
      // auto-fitting so the viewport doesn't shift under their cursor.
      autoFitRef.current = false;
    }
    if (drag.moved) {
      const world = panZoom.screenToWorld(sx, sy);
      pinNode(drag.id, world.x, world.y);
    }
  };

  const onNodePointerUp = (e: React.PointerEvent<SVGGElement>, n: N) => {
    const drag = dragRef.current;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    if (!drag) return;
    if (drag.moved) {
      releaseNode(drag.id);
    } else if (onNodeClick) {
      onNodeClick(n);
    }
  };

  void tick; // subscribe to simulation ticks

  const simLinks = simLinksRef.current;
  const simNodes = simNodesRef.current;

  // Floating annotation anchored to a node, tracking sim + viewport.
  let annotation: ReactNode = null;
  if (annotationNodeId && renderAnnotation) {
    const anchor = simNodes.find((n) => n.id === annotationNodeId);
    if (anchor && anchor.x != null && anchor.y != null) {
      const pos = panZoom.worldToScreen(anchor.x, anchor.y);
      const r = nodeRadius(anchor) * panZoom.transform.scale;
      const left = Math.min(Math.max(pos.x + r + 10, 8), width - 240);
      const top = Math.min(Math.max(pos.y - 20, 8), height - 140);
      annotation = (
        <div className={s.annotation} style={{ left, top }}>
          {renderAnnotation(anchor)}
        </div>
      );
    }
  }

  return (
    <div className={s.wrap} style={{ width, height }}>
      <svg
        ref={panZoom.svgRef}
        width={width}
        height={height}
        className={s.svg}
        onPointerDown={panZoom.onBackgroundPointerDown}
        onPointerMove={panZoom.onBackgroundPointerMove}
        onPointerUp={panZoom.onBackgroundPointerUp}
      >
        <g
          transform={`translate(${panZoom.transform.tx},${panZoom.transform.ty}) scale(${panZoom.transform.scale})`}
        >
          {simLinks.map((l) => {
            const source = l.source as N;
            const target = l.target as N;
            if (source.x == null || target.x == null) return null;
            const label = edgeLabel(l);
            const mx = ((source.x ?? 0) + (target.x ?? 0)) / 2;
            const my = ((source.y ?? 0) + (target.y ?? 0)) / 2;
            const key = `${source.id}>${target.id}`;
            return (
              <g key={key}>
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={edgeColor(l)}
                  strokeWidth={edgeWidth(l)}
                  strokeDasharray={edgeDash(l)}
                  strokeLinecap="round"
                />
                {label && (
                  <text x={mx} y={my - 4} textAnchor="middle" className={s.edgeLabel}>
                    {label}
                  </text>
                )}
              </g>
            );
          })}
          {simNodes.map((n) => {
            if (n.x == null || n.y == null) return null;
            const r = nodeRadius(n);
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                className={onNodeClick ? s.nodeClickable : s.node}
                onPointerDown={(e) => onNodePointerDown(e, n)}
                onPointerMove={onNodePointerMove}
                onPointerUp={(e) => onNodePointerUp(e, n)}
                onPointerEnter={onNodeHover ? () => onNodeHover(n) : undefined}
                onPointerLeave={onNodeHover ? () => onNodeHover(null) : undefined}
              >
                <circle r={r} fill={nodeFill(n)} stroke={nodeStroke(n)} strokeWidth={1.5} />
                {renderNodeContent?.(n, r)}
                <text y={r + 14} textAnchor="middle" className={s.nodeLabel}>
                  {nodeLabel(n)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      {annotation}
      <ZoomControls
        scale={panZoom.transform.scale}
        onZoomIn={() => panZoom.zoomBy(1.3)}
        onZoomOut={() => panZoom.zoomBy(1 / 1.3)}
        onReset={panZoom.reset}
      />
    </div>
  );
}
