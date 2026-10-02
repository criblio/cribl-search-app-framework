/**
 * `usePageLoad` / `createPageLoadController`: non-destructive refresh.
 *
 * Three failures from APM's Overview page are pinned here:
 * - every refresh cleared the page to skeletons (layout jump, a poll that
 *   flashed the page every minute) — only the FIRST load is `initial`;
 * - a superseded read settling late overwrote the newer view — results and
 *   failures from a superseded load are dropped;
 * - an aborted read ("Search was canceled") painted an error banner over
 *   the view that replaced it — aborts are never failures.
 *
 * The state machine is framework-free and driven directly; the hook is a
 * thin wrapper whose first render is checked with `renderToString` (this
 * package carries no DOM harness, and render without effects is exactly
 * what a first paint sees).
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  createPageLoadController,
  usePageLoad,
  type PageLoadContext,
  type PageLoadState,
} from '../page-load.js';
import { captureQueryGeneration, newQueryGeneration } from '../query-generation.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A controller whose every load waits on a gate the test opens. */
function harness() {
  const states: PageLoadState[] = [];
  const loads: Array<{ ctx: PageLoadContext; gate: ReturnType<typeof deferred<void>> }> = [];
  const controller = createPageLoadController(
    (ctx) => {
      const gate = deferred<void>();
      loads.push({ ctx, gate });
      return gate.promise;
    },
    (s) => states.push(s),
  );
  const last = () => controller.getState();
  return { controller, states, loads, last };
}

describe('phase', () => {
  it('is initial until the first load settles, then idle', async () => {
    const h = harness();
    expect(h.last().phase).toBe('initial');
    const run = h.controller.run();
    expect(h.last().phase).toBe('initial');
    h.loads[0]!.gate.resolve();
    await run;
    expect(h.last().phase).toBe('idle');
    expect(h.last().updatedAt).toEqual(expect.any(Number));
  });

  it('a later load is refreshing, never initial again', async () => {
    const h = harness();
    const first = h.controller.run();
    h.loads[0]!.gate.resolve();
    await first;
    const second = h.controller.run();
    expect(h.last().phase).toBe('refreshing');
    expect(h.states.some((s, i) => i > 0 && s.phase === 'initial')).toBe(false);
    h.loads[1]!.gate.resolve();
    await second;
    expect(h.last().phase).toBe('idle');
  });

  it('a silent load (polling) leaves phase alone', async () => {
    const h = harness();
    const first = h.controller.run();
    h.loads[0]!.gate.resolve();
    await first;
    const poll = h.controller.run(true);
    expect(h.last().phase).toBe('idle');
    h.loads[1]!.gate.resolve();
    await poll;
    expect(h.states.map((s) => s.phase)).not.toContain('refreshing');
  });

  it('stays initial when the first load is superseded before it settles', async () => {
    const h = harness();
    const a = h.controller.run();
    const b = h.controller.run();
    expect(h.last().phase).toBe('initial');
    h.loads[0]!.gate.resolve();
    await a;
    expect(h.last().phase).toBe('initial');
    h.loads[1]!.gate.resolve();
    await b;
    expect(h.last().phase).toBe('idle');
  });
});

describe('generation guard', () => {
  it('starts a new query generation and aborts the previous load', () => {
    const h = harness();
    const outside = (newQueryGeneration(), captureQueryGeneration());
    void h.controller.run();
    expect(outside()).toBe(false);
    void h.controller.run();
    expect(h.loads[0]!.ctx.signal.aborted).toBe(true);
    expect(h.loads[0]!.ctx.isCurrent()).toBe(false);
    expect(h.loads[1]!.ctx.isCurrent()).toBe(true);
  });

  it('drops failures from a superseded load', async () => {
    const h = harness();
    const a = h.controller.run();
    const b = h.controller.run();
    h.loads[0]!.ctx.fail('Request rate', new Error('late and stale'));
    h.loads[0]!.gate.resolve();
    h.loads[1]!.gate.resolve();
    await Promise.all([a, b]);
    expect(h.last().failures).toEqual({});
  });

  it('invalidate (unmount, deps change) supersedes without starting a load', async () => {
    const h = harness();
    const a = h.controller.run();
    h.controller.invalidate();
    expect(h.loads[0]!.ctx.isCurrent()).toBe(false);
    h.loads[0]!.ctx.fail('Logs', new Error('x'));
    h.loads[0]!.gate.resolve();
    await a;
    expect(h.last()).toMatchObject({ phase: 'initial', failures: {} });
    expect(h.loads).toHaveLength(1);
  });
});

describe('failures', () => {
  it('an abort is never a failure, even while current', async () => {
    const h = harness();
    const run = h.controller.run();
    const { ctx } = h.loads[0]!;
    ctx.fail('A', new DOMException('The operation was aborted.', 'AbortError'));
    ctx.fail('B', Object.assign(new Error('Search was canceled'), { kind: 'aborted' }));
    expect(h.last().failures).toEqual({});
    h.loads[0]!.gate.resolve();
    await run;
    expect(h.last().failures).toEqual({});
  });

  it('a server-side cancel while current is a real failure', async () => {
    const h = harness();
    const run = h.controller.run();
    h.loads[0]!.ctx.fail('Rate', Object.assign(new Error('cancelled'), { kind: 'cancelled' }));
    h.loads[0]!.gate.resolve();
    await run;
    expect(h.last().failures).toEqual({ Rate: 'cancelled' });
  });

  it('keeps the previous failures visible during a refresh, then replaces them', async () => {
    const h = harness();
    const first = h.controller.run();
    h.loads[0]!.ctx.fail('Rate', new Error('403'));
    h.loads[0]!.ctx.fail('Logs', 'boom');
    h.loads[0]!.gate.resolve();
    await first;
    expect(h.last().failures).toEqual({ Rate: '403', Logs: 'boom' });

    const second = h.controller.run(true);
    // No flicker: still showing the last load's failures mid-refresh.
    expect(h.states.every((s) => s.phase === 'initial' || Object.keys(s.failures).length > 0)).toBe(true);
    h.loads[1]!.ctx.fail('Logs', new Error('still down'));
    expect(h.last().failures).toEqual({ Rate: '403', Logs: 'still down' });
    h.loads[1]!.gate.resolve();
    await second;
    // Rate was not reported this time: it recovered.
    expect(h.last().failures).toEqual({ Logs: 'still down' });
  });

  it('ok clears a failure before the load settles', async () => {
    const h = harness();
    const first = h.controller.run();
    h.loads[0]!.ctx.fail('Rate', new Error('403'));
    h.loads[0]!.gate.resolve();
    await first;
    void h.controller.run();
    h.loads[1]!.ctx.ok('Rate');
    expect(h.last().failures).toEqual({});
  });

  it('a failure reported after settling is still recorded while current', async () => {
    const h = harness();
    const run = h.controller.run();
    const { ctx } = h.loads[0]!;
    h.loads[0]!.gate.resolve();
    await run;
    ctx.fail('Latency', new Error('late but live'));
    expect(h.last().failures).toEqual({ Latency: 'late but live' });
  });

  it('a load that rejects is recorded under errorKey', async () => {
    const states: PageLoadState[] = [];
    const c = createPageLoadController(async () => { throw new Error('bad query'); }, (s) => states.push(s));
    await c.run();
    expect(c.getState()).toMatchObject({ phase: 'idle', failures: { 'Page data': 'bad query' } });
    const named = createPageLoadController(() => { throw 'sync'; }, () => {}, { errorKey: 'Overview' });
    await named.run();
    expect(named.getState().failures).toEqual({ Overview: 'sync' });
  });
});

describe('usePageLoad first render', () => {
  it('renders the initial phase and does not start a load during render', () => {
    let calls = 0;
    let seen: ReturnType<typeof usePageLoad> | undefined;
    function Page() {
      seen = usePageLoad(async () => { calls++; }, []);
      return <span>{seen.phase}</span>;
    }
    expect(renderToString(<Page />)).toBe('<span>initial</span>');
    expect(calls).toBe(0);
    expect(seen).toMatchObject({ phase: 'initial', failures: {}, updatedAt: null });
    expect(typeof seen!.retry).toBe('function');
    expect(typeof seen!.refresh).toBe('function');
  });
});
