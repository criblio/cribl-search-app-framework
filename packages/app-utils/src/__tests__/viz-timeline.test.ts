/**
 * `buildTimeline` — the generic waterfall layout lifted from APM's trace view.
 *
 * The regression it exists for: a PHP service stamped one child span ~0.5s
 * before its parent. Scaling the axis to min/max over every span pulled the
 * window's left edge back to that child, and the real 40 ms of work was
 * drawn in the right 8% of the chart. The window must anchor to the root.
 */
import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../viz/timeline.js';

interface Step {
  id: string;
  parent?: string | null;
  start: number;
  end: number;
}

const accessors = {
  id: (s: Step) => s.id,
  parentId: (s: Step) => s.parent,
  start: (s: Step) => s.start,
  end: (s: Step) => s.end,
};

describe('buildTimeline', () => {
  it('orders depth-first with children by start time', () => {
    const t = buildTimeline(
      [
        { id: 'c2', parent: 'root', start: 50, end: 80 },
        { id: 'root', start: 0, end: 100 },
        { id: 'g1', parent: 'c1', start: 15, end: 20 },
        { id: 'c1', parent: 'root', start: 10, end: 40 },
      ],
      accessors,
    );
    expect(t.rows.map((r) => [r.id, r.depth])).toEqual([
      ['root', 0],
      ['c1', 1],
      ['g1', 2],
      ['c2', 1],
    ]);
    expect(t.rootId).toBe('root');
    expect(t.rows[0].childIds).toEqual(['c1', 'c2']);
    expect(t.rows[0].hasChildren).toBe(true);
    expect(t.rows[2].parentId).toBe('c1');
    expect(t.rows[1]).toMatchObject({ offset: 0.1, width: 0.3, clippedStart: false, clippedEnd: false });
  });

  it('scales to the root, not to a clock-skewed child that starts before it', () => {
    // Root is 40 units of work; one child claims to start 460 units earlier.
    const t = buildTimeline(
      [
        { id: 'root', start: 1000, end: 1040 },
        { id: 'skewed', parent: 'root', start: 540, end: 560 },
        { id: 'overlap', parent: 'root', start: 990, end: 1010 },
        { id: 'real', parent: 'root', start: 1000, end: 1030 },
      ],
      accessors,
    );
    expect(t.windowStart).toBe(1000);
    expect(t.windowEnd).toBe(1040);
    const real = t.rows.find((r) => r.id === 'real')!;
    // Min/max scaling would have put this at offset ≈ 0.92, width ≈ 0.06.
    expect(real.offset).toBe(0);
    expect(real.width).toBe(0.75);
    const skewed = t.rows.find((r) => r.id === 'skewed')!;
    expect(skewed).toMatchObject({ inWindow: false, width: 0, clippedStart: true });
    const overlap = t.rows.find((r) => r.id === 'overlap')!;
    expect(overlap).toMatchObject({ inWindow: true, offset: 0, width: 0.25, clippedStart: true });
  });

  it('extends the window for work that starts inside it and outlives the root', () => {
    const t = buildTimeline(
      [
        { id: 'root', start: 0, end: 100 },
        { id: 'async', parent: 'root', start: 80, end: 200 },
      ],
      accessors,
    );
    expect(t.windowEnd).toBe(200);
    expect(t.rows[1]).toMatchObject({ offset: 0.4, width: 0.6, clippedEnd: false });
  });

  it('honours an explicit window and flags both clipped edges', () => {
    const t = buildTimeline([{ id: 'a', start: 0, end: 100 }], {
      ...accessors,
      windowStart: 25,
      windowEnd: 75,
    });
    expect(t.duration).toBe(50);
    expect(t.rows[0]).toMatchObject({ offset: 0, width: 1, clippedStart: true, clippedEnd: true });
  });

  it('treats orphans as roots and anchors to the earliest root', () => {
    const t = buildTimeline(
      [
        { id: 'late', start: 50, end: 60 },
        { id: 'orphan', parent: 'missing', start: 10, end: 20 },
      ],
      accessors,
    );
    expect(t.rootId).toBe('orphan');
    expect(t.rows.map((r) => [r.id, r.depth, r.parentId])).toEqual([
      ['orphan', 0, null],
      ['late', 0, null],
    ]);
    expect(t.windowStart).toBe(10);
    expect(t.windowEnd).toBe(60);
  });

  it('keeps parent cycles and self-parents instead of dropping them', () => {
    const t = buildTimeline(
      [
        { id: 'a', parent: 'b', start: 5, end: 10 },
        { id: 'b', parent: 'a', start: 0, end: 20 },
        { id: 'self', parent: 'self', start: 2, end: 3 },
      ],
      accessors,
    );
    expect(t.rows).toHaveLength(3);
    expect(new Set(t.rows.map((r) => r.id))).toEqual(new Set(['a', 'b', 'self']));
    const self = t.rows.find((r) => r.id === 'self')!;
    expect(self.parentId).toBeNull();
    // No row lists, as a child, a node that was laid out as a root.
    for (const row of t.rows) {
      for (const child of row.childIds) {
        expect(t.rows.find((r) => r.id === child)!.parentId).toBe(row.id);
      }
    }
  });

  it('clamps an end before its start to zero length and keeps fractions finite', () => {
    const t = buildTimeline([{ id: 'x', start: 10, end: 5 }], accessors);
    expect(t.duration).toBe(1);
    expect(t.rows[0]).toMatchObject({ start: 10, end: 10, inWindow: true, offset: 0, width: 0 });
  });

  it('handles an empty input and a deep chain without recursion', () => {
    expect(buildTimeline([], accessors)).toMatchObject({ rows: [], rootId: null, duration: 1 });
    const chain: Step[] = Array.from({ length: 20_000 }, (_, i) => ({
      id: `n${i}`,
      parent: i === 0 ? null : `n${i - 1}`,
      start: i,
      end: i + 1,
    }));
    const t = buildTimeline(chain, accessors);
    expect(t.rows).toHaveLength(20_000);
    expect(t.rows[19_999].depth).toBe(19_999);
  });
});
