/**
 * Generic d3-force simulation driver for network/dependency graphs.
 * Extracted from the APM app's System Architecture views and generified:
 * node/link datum types are caller-supplied, force parameters injectable.
 *
 * Responsibilities:
 *  - Own the forceSimulation lifecycle (create on mount + topology change,
 *    stop on unmount).
 *  - Expose refs to the live node/link arrays (d3 mutates them in place
 *    each tick).
 *  - Expose a `tick` counter that bumps each tick, so rendering React
 *    components can subscribe and re-render.
 *  - Preserve node positions across topology changes (same-id nodes keep
 *    their spot; only new nodes enter from scratch).
 *  - Data-only updates (same topology, fresh metric values) mutate the
 *    live objects without restarting the simulation.
 *  - Expose pinNode / releaseNode helpers for drag behavior.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

/** Minimum node shape: stable id + a size the radius function can use. */
export interface ForceNode extends SimulationNodeDatum {
  id: string;
  size: number;
}

/** Minimum link shape: endpoints + a value (weight) for visual encoding. */
export type ForceLink<N extends ForceNode = ForceNode> = SimulationLinkDatum<N> & {
  value: number;
};

export interface ForceConfig {
  /** Target link length in px (default 200). A function receives each
   *  link so different edge kinds can sit at different distances. */
  linkDistance?: number | ((link: unknown) => number);
  /** Link spring strength 0..1 (default 0.4). */
  linkStrength?: number;
  /** Many-body charge, negative repels (default -1000). */
  charge?: number;
  /** Charge cutoff distance in px (default 600). */
  chargeDistanceMax?: number;
  /** Extra collision padding beyond nodeRadius (default 14). */
  collidePadding?: number;
  /** Pull toward the canvas center 0..1 (default 0.05). */
  centerStrength?: number;
  /**
   * Pre-settle the simulation synchronously (off-screen) until alpha
   * drops to this level, then animate the rest. The high-alpha phase is
   * where layouts visibly "shake", so lowering this trades intro
   * animation for calmness:
   *   1 (default) — no pre-settle; the full layout animates on screen
   *                 (original behavior).
   *   ~0.1        — brief graceful glide into place.
   *   0           — fully settled before first paint; no animation.
   */
  settleAlpha?: number;
}

interface Options<N extends ForceNode, L extends ForceLink<N>> {
  nodes: N[];
  links: L[];
  width: number;
  height: number;
  nodeRadius: (n: N) => number;
  forces?: ForceConfig;
}

export interface UseForceLayoutResult<N extends ForceNode, L extends ForceLink<N>> {
  simNodesRef: React.MutableRefObject<N[]>;
  simLinksRef: React.MutableRefObject<L[]>;
  /** Bumped by 1 on each simulation tick — consumers re-render via it. */
  tick: number;
  /** Pin a node at (x, y) in world coordinates. Used while dragging. */
  pinNode: (id: string, x: number, y: number) => void;
  /** Clear a node's pinned position so physics can move it again. */
  releaseNode: (id: string) => void;
  /** Give the simulation a kick so pinned updates settle visibly. */
  reheat: (alpha?: number) => void;
}

function linkEndId<N extends ForceNode>(end: SimulationLinkDatum<N>['source']): string {
  return typeof end === 'object' ? (end as N).id : String(end);
}

function topoKey<N extends ForceNode, L extends ForceLink<N>>(nodes: N[], links: L[]): string {
  const nk = nodes.map((n) => n.id).sort().join(',');
  const lk = links
    .map((l) => `${linkEndId<N>(l.source)}>${linkEndId<N>(l.target)}`)
    .sort()
    .join(',');
  return `${nk}|${lk}`;
}

/** Simulation-owned fields that data-only updates must never clobber. */
const SIM_FIELDS = new Set(['x', 'y', 'vx', 'vy', 'fx', 'fy', 'index', 'source', 'target']);

export function useForceLayout<N extends ForceNode, L extends ForceLink<N>>({
  nodes,
  links,
  width,
  height,
  nodeRadius,
  forces = {},
}: Options<N, L>): UseForceLayoutResult<N, L> {
  const {
    linkDistance = 200,
    linkStrength = 0.4,
    charge = -1000,
    chargeDistanceMax = 600,
    collidePadding = 14,
    centerStrength = 0.05,
    settleAlpha = 1,
  } = forces;

  const simNodesRef = useRef<N[]>([]);
  const simLinksRef = useRef<L[]>([]);
  const simRef = useRef<Simulation<N, L> | null>(null);
  const [tick, setTick] = useState(0);

  const topology = useMemo(() => topoKey(nodes, links), [nodes, links]);

  // Full simulation (re)creation — only when topology or dimensions change.
  useEffect(() => {
    const prevById = new Map<string, N>();
    for (const n of simNodesRef.current) prevById.set(n.id, n);

    const simNodes: N[] = nodes.map((n) => {
      const prev = prevById.get(n.id);
      if (prev) {
        return { ...n, x: prev.x, y: prev.y, vx: 0, vy: 0 };
      }
      return { ...n };
    });
    const simLinks: L[] = links.map((l) => ({ ...l }));

    simNodesRef.current = simNodes;
    simLinksRef.current = simLinks;

    if (simRef.current) simRef.current.stop();

    const sim = forceSimulation<N>(simNodes)
      .force(
        'link',
        forceLink<N, L>(simLinks)
          .id((d) => d.id)
          .distance(
            typeof linkDistance === 'function'
              ? (l) => (linkDistance as (link: unknown) => number)(l)
              : linkDistance,
          )
          .strength(linkStrength),
      )
      .force('charge', forceManyBody().strength(charge).distanceMax(chargeDistanceMax))
      .force('center', forceCenter(width / 2, height / 2).strength(centerStrength))
      .force(
        'collision',
        forceCollide<N>().radius((d) => nodeRadius(d) + collidePadding).strength(1),
      )
      .alphaDecay(0.03)
      .stop();

    // Optionally burn the violent high-alpha phase off-screen (see
    // ForceConfig.settleAlpha) so what the user watches is only the
    // graceful tail of the layout. Incremental topology changes start at
    // lower energy regardless, since existing nodes keep their spots.
    const isIncremental = prevById.size > 0;
    if (isIncremental) sim.alpha(Math.min(0.3, sim.alpha()));
    const settleTo = Math.max(settleAlpha, sim.alphaMin());
    for (let i = 0; i < 500 && sim.alpha() > settleTo; i += 1) {
      sim.tick();
    }

    sim.on('tick', () => {
      setTick((t) => t + 1);
    });
    if (sim.alpha() > sim.alphaMin()) {
      sim.restart();
    }
    // Paint the pre-settled positions immediately.
    setTick((t) => t + 1);

    simRef.current = sim as Simulation<N, L>;
    return () => {
      sim.stop();
      simRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology, width, height]);

  // Data-only update — same topology, new metric values on nodes/links.
  // Mutate the live objects in place (all caller fields except the
  // simulation-owned ones) so the simulation keeps running without
  // restart and React sees no structural change.
  useEffect(() => {
    const simNodes = simNodesRef.current;
    const simLinks = simLinksRef.current;
    if (simNodes.length === 0) return;

    const inputById = new Map<string, N>();
    for (const n of nodes) inputById.set(n.id, n);
    for (const sn of simNodes) {
      const input = inputById.get(sn.id);
      if (!input) continue;
      for (const [key, value] of Object.entries(input)) {
        if (!SIM_FIELDS.has(key)) (sn as Record<string, unknown>)[key] = value;
      }
    }

    for (let i = 0; i < simLinks.length && i < links.length; i++) {
      for (const [key, value] of Object.entries(links[i])) {
        if (!SIM_FIELDS.has(key)) (simLinks[i] as Record<string, unknown>)[key] = value;
      }
    }

    setTick((t) => t + 1);
  }, [nodes, links]);

  const pinNode = useCallback((id: string, x: number, y: number) => {
    const n = simNodesRef.current.find((node) => node.id === id);
    if (!n) return;
    n.fx = x;
    n.fy = y;
    if (simRef.current && simRef.current.alpha() < 0.2) {
      simRef.current.alpha(0.3).restart();
    }
  }, []);

  const releaseNode = useCallback((id: string) => {
    const n = simNodesRef.current.find((node) => node.id === id);
    if (!n) return;
    n.fx = null;
    n.fy = null;
  }, []);

  const reheat = useCallback((alpha: number = 0.3) => {
    simRef.current?.alpha(alpha).restart();
  }, []);

  return {
    simNodesRef,
    simLinksRef,
    tick,
    pinNode,
    releaseNode,
    reheat,
  };
}
