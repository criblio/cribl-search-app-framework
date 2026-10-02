/**
 * Waterfall / Gantt layout for any parent-linked items with a start and an
 * end: trace spans, pipeline stages, job steps. Pure data — no DOM, no d3 —
 * so a renderer only maps `offset`/`width` fractions to pixels or percents.
 */

export interface TimelineAccessors<T> {
  id: (item: T) => string;
  /** Parent id; null/undefined/unknown id makes the item a root. */
  parentId: (item: T) => string | null | undefined;
  /** Start time in any consistent unit (ms, µs…). */
  start: (item: T) => number;
  /** End time in the same unit. An end before the start is treated as zero-length. */
  end: (item: T) => number;
  /** Force the window's left edge instead of anchoring it to the root. */
  windowStart?: number;
  /** Force the window's right edge. */
  windowEnd?: number;
}

export interface TimelineRow<T> {
  item: T;
  id: string;
  /** Resolved parent id, or null for a root (including orphans and cycle breaks). */
  parentId: string | null;
  depth: number;
  childIds: string[];
  hasChildren: boolean;
  start: number;
  end: number;
  /** Left edge of the visible bar as a fraction (0..1) of the window. */
  offset: number;
  /** Visible bar width as a fraction (0..1) of the window; 0 when outside it. */
  width: number;
  /** The item starts before the window (bar is cut at the left edge). */
  clippedStart: boolean;
  /** The item ends after the window (bar is cut at the right edge). */
  clippedEnd: boolean;
  /** False when no part of the item falls inside the window — render a label, not a bar. */
  inWindow: boolean;
}

export interface Timeline<T> {
  windowStart: number;
  windowEnd: number;
  /** windowEnd - windowStart, never below 1 so fractions stay finite. */
  duration: number;
  /** The root the window is anchored to, or null when there are no items. */
  rootId: string | null;
  /** Depth-first, children in start order: the order a waterfall reads top-down. */
  rows: TimelineRow<T>[];
}

/**
 * Build a depth-first, start-ordered timeline scaled to the root item.
 *
 * The window runs from the earliest root's start to the latest end among
 * items that start inside it. It is NOT min/max over every item: one
 * clock-skewed child stamped before its parent squashed the real work into
 * the right 8% of the axis. Such items stay in `rows` and are clipped
 * (`clippedStart`, or `inWindow: false`) instead of rescaling the chart.
 * Items that start inside the window and outlive it (async work) extend it.
 *
 * Renderers usually floor `width` at a small minimum (~0.2%) so a
 * sub-pixel item is still clickable.
 */
export function buildTimeline<T>(items: readonly T[], accessors: TimelineAccessors<T>): Timeline<T> {
  const n = items.length;
  if (n === 0) {
    const ws = accessors.windowStart ?? 0;
    const we = accessors.windowEnd ?? ws;
    return { windowStart: ws, windowEnd: we, duration: Math.max(1, we - ws), rootId: null, rows: [] };
  }

  const ids: string[] = new Array(n);
  const starts: number[] = new Array(n);
  const ends: number[] = new Array(n);
  const indexOf = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const item = items[i];
    ids[i] = accessors.id(item);
    const s = accessors.start(item);
    starts[i] = s;
    ends[i] = Math.max(s, accessors.end(item));
    // A duplicated id keeps the first occurrence as the parent target.
    if (!indexOf.has(ids[i])) indexOf.set(ids[i], i);
  }

  const children: number[][] = Array.from({ length: n }, () => []);
  const roots: number[] = [];
  for (let i = 0; i < n; i++) {
    const pid = accessors.parentId(items[i]);
    const p = pid == null ? undefined : indexOf.get(pid);
    if (p === undefined || p === i) {
      roots.push(i);
    } else {
      children[p].push(i);
    }
  }
  const byStart = (a: number, b: number) => starts[a] - starts[b] || a - b;
  for (const list of children) list.sort(byStart);
  roots.sort(byStart);

  const order: Array<{ index: number; depth: number; parent: number }> = [];
  const visited = new Uint8Array(n);
  const visit = (root: number, rootParent: number) => {
    // Iterative DFS: a deep chain must not blow the call stack.
    const stack: Array<{ index: number; depth: number; parent: number }> = [
      { index: root, depth: 0, parent: rootParent },
    ];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (visited[frame.index]) continue;
      visited[frame.index] = 1;
      order.push(frame);
      const kids = children[frame.index];
      for (let k = kids.length - 1; k >= 0; k--) {
        if (!visited[kids[k]]) stack.push({ index: kids[k], depth: frame.depth + 1, parent: frame.index });
      }
    }
  };
  for (const r of roots) visit(r, -1);
  // Parent cycles (a→b→a) have no root; surface them as roots rather than drop them.
  if (order.length < n) {
    const rest = [...Array(n).keys()].filter((i) => !visited[i]).sort(byStart);
    for (const i of rest) visit(i, -1);
  }

  // Children as laid out, so a broken cycle never lists its new root as a child.
  const laidOutChildren: number[][] = Array.from({ length: n }, () => []);
  for (const { index, parent } of order) if (parent >= 0) laidOutChildren[parent].push(index);

  const anchor = roots.length > 0 ? roots[0] : order[0].index;
  let windowStart = starts[anchor];
  let windowEnd = ends[anchor];
  if (roots.length > 0) {
    for (let i = 0; i < n; i++) {
      if (starts[i] < windowStart) continue; // skewed before the root: clip, don't rescale
      if (ends[i] > windowEnd) windowEnd = ends[i];
    }
  } else {
    // Only cycles: nothing to anchor to, so fall back to the full extent.
    for (let i = 0; i < n; i++) {
      if (starts[i] < windowStart) windowStart = starts[i];
      if (ends[i] > windowEnd) windowEnd = ends[i];
    }
  }
  if (accessors.windowStart !== undefined) windowStart = accessors.windowStart;
  if (accessors.windowEnd !== undefined) windowEnd = accessors.windowEnd;
  const duration = Math.max(1, windowEnd - windowStart);

  const rows: TimelineRow<T>[] = order.map(({ index, depth, parent }) => {
    const start = starts[index];
    const end = ends[index];
    const visStart = Math.max(start, windowStart);
    const visEnd = Math.min(end, windowEnd);
    // A zero-length item exactly inside the window still counts as visible.
    const inWindow = visEnd > visStart || (start === end && start >= windowStart && start <= windowEnd);
    const childIds = laidOutChildren[index].map((c) => ids[c]);
    return {
      item: items[index],
      id: ids[index],
      parentId: parent >= 0 ? ids[parent] : null,
      depth,
      childIds,
      hasChildren: childIds.length > 0,
      start,
      end,
      offset: inWindow ? (visStart - windowStart) / duration : 0,
      width: inWindow ? (visEnd - visStart) / duration : 0,
      clippedStart: start < windowStart,
      clippedEnd: end > windowEnd,
      inWindow,
    };
  });

  return { windowStart, windowEnd, duration, rootId: ids[anchor], rows };
}
