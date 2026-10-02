/** Stable per-link identity for rendering and data-only updates. */

type LinkEnd = string | number | { id: string } | undefined;

interface KeyedLink {
  id?: string;
  source: LinkEnd;
  target: LinkEnd;
}

function endId(end: LinkEnd): string {
  return end != null && typeof end === 'object' ? end.id : String(end);
}

/**
 * One unique key per link, in input order: the link's own `id` when it has
 * one, else `source>target`, with `#1`, `#2`… appended to repeats. Parallel
 * edges (two links between the same pair) used to share `source>target`,
 * which collided as React keys and dropped one edge from the DOM.
 */
export function linkKeys(links: readonly KeyedLink[]): string[] {
  const seen = new Map<string, number>();
  return links.map((l) => {
    const base = typeof l.id === 'string' && l.id !== '' ? l.id : `${endId(l.source)}>${endId(l.target)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}
