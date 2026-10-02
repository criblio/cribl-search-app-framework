/**
 * `runWithLimit` / `runWithLimitSettled` — bounded search fan-out.
 *
 * The regression: APM's Spotlight fired 22 attribute queries at once on a
 * page already running ~15, past the cluster's 20-job ceiling, and the tail
 * returned 429s. These tests pin the cap, input-order results, and that one
 * failed item does not stop the rest.
 */
import { describe, expect, it } from 'vitest';
import { runWithLimit, runWithLimitSettled } from '../search.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A worker that records peak concurrency and resolves after `delay(i)` ticks. */
function tracked<R>(fn: (i: number) => R, delay: (i: number) => number = () => 1) {
  const state = { inFlight: 0, peak: 0, started: [] as number[] };
  const worker = async (_item: unknown, i: number) => {
    state.started.push(i);
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      for (let t = 0; t < delay(i); t++) await tick();
      return fn(i);
    } finally {
      state.inFlight--;
    }
  };
  return { state, worker };
}

describe('runWithLimit', () => {
  it('never exceeds the limit: 22 Spotlight attributes at 4', async () => {
    const attrs = Array.from({ length: 22 }, (_, i) => `attr${i}`);
    const { state, worker } = tracked((i) => i);
    await runWithLimit(attrs, 4, worker);
    expect(state.peak).toBe(4);
    expect(state.started).toHaveLength(22);
  });

  it('returns results in input order, not completion order', async () => {
    const { worker } = tracked((i) => `r${i}`, (i) => 5 - i);
    expect(await runWithLimit([0, 1, 2, 3, 4], 5, worker)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  it('a failure does not stop the other items, and rejects with the lowest-index error after all settle', async () => {
    const { state, worker } = tracked((i) => {
      if (i === 1 || i === 3) throw new Error(`boom ${i}`);
      return i;
    }, (i) => (i === 3 ? 1 : 3));
    await expect(runWithLimit([0, 1, 2, 3, 4, 5], 2, worker)).rejects.toThrow('boom 1');
    expect(state.started.sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(state.inFlight).toBe(0); // nothing left running when it rejects
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await runWithLimit([], 4, async () => 1)).toEqual([]);
    const { state, worker } = tracked((i) => i);
    expect(await runWithLimit([0, 1], 10, worker)).toEqual([0, 1]);
    expect(state.peak).toBe(2);
  });

  it('accepts Infinity as "no cap"', async () => {
    const { state, worker } = tracked((i) => i);
    await runWithLimit([0, 1, 2], Number.POSITIVE_INFINITY, worker);
    expect(state.peak).toBe(3);
  });

  it('rejects a limit below 1 instead of silently doing nothing', async () => {
    await expect(runWithLimit([1], 0, async () => 1)).rejects.toThrow(RangeError);
    await expect(runWithLimit([1], Number.NaN, async () => 1)).rejects.toThrow(RangeError);
  });

  it('a worker that throws synchronously is a per-item failure', async () => {
    const out = await runWithLimitSettled([0, 1], 1, ((_: number, i: number) => {
      if (i === 0) throw new Error('sync');
      return Promise.resolve(i);
    }) as (item: number, i: number) => Promise<number>);
    expect(out[0]).toMatchObject({ status: 'rejected' });
    expect(out[1]).toEqual({ status: 'fulfilled', value: 1 });
  });
});

describe('runWithLimitSettled', () => {
  it('reports every item in input order', async () => {
    const out = await runWithLimitSettled(['a', 'b', 'c'], 2, async (item) => {
      if (item === 'b') throw new Error('no answer');
      return item.toUpperCase();
    });
    expect(out.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(out[0]).toEqual({ status: 'fulfilled', value: 'A' });
    expect((out[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
  });

  it('abort stops new items from starting; unstarted items reject with the reason', async () => {
    const ac = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const started: number[] = [];
    const out = await runWithLimitSettled([0, 1, 2, 3, 4], 2, async (_item, i, signal) => {
      started.push(i);
      seen.push(signal);
      if (i === 1) ac.abort(new Error('navigated away'));
      await tick();
      return i;
    }, { signal: ac.signal });
    expect(started).toEqual([0, 1]);
    expect(seen.every((s) => s === ac.signal)).toBe(true);
    expect(out.slice(0, 2)).toEqual([
      { status: 'fulfilled', value: 0 },
      { status: 'fulfilled', value: 1 },
    ]);
    for (const r of out.slice(2)) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toEqual(new Error('navigated away'));
    }
  });

  it('an already-aborted signal starts nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const out = await runWithLimitSettled([1, 2], 2, async () => ++calls, { signal: ac.signal });
    expect(calls).toBe(0);
    expect(out.every((r) => r.status === 'rejected')).toBe(true);
  });
});
