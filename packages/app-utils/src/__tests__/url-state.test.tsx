/**
 * `useQueryParam` / `useRangeParam`: one functional write per update.
 *
 * React Router's `setSearchParams` builds every write — functional or not
 * — from the params of the render it closed over, so two writes in one
 * handler lose one. APM's System Architecture page cleared a legacy
 * `?lookback=` with one write and set `?range=` with a second; the second
 * restored `lookback`, and picking the default from an old
 * `?lookback=-15m` bookmark left the page at 15m (APM PR #185).
 *
 * The fake router below reproduces that exact semantics (each call starts
 * from the render's params, the last navigation wins). Reads go through a
 * real `MemoryRouter`; `renderToString` runs render but no effects, which
 * is all a read needs. This package carries no DOM harness, so the setter
 * is captured from a render and called directly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import * as ReactRouterDom from 'react-router-dom';
import { MemoryRouter } from 'react-router-dom';
import { nextSearchParams, useQueryParam, useRangeParam, type QueryParamOptions } from '../url-state.js';

type SetParams = (
  next: URLSearchParams | ((prev: URLSearchParams) => URLSearchParams),
  opts?: { replace?: boolean },
) => void;

let fakeRouter: { search: string; writes: number; opts: Array<{ replace?: boolean } | undefined> } | null = null;

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouterDom>();
  return {
    ...actual,
    useSearchParams: (...args: Parameters<typeof actual.useSearchParams>) => {
      if (!fakeRouter) return actual.useSearchParams(...args);
      const router = fakeRouter;
      const rendered = new URLSearchParams(router.search);
      const set: SetParams = (next, opts) => {
        // Exactly React Router's behaviour: derive from the RENDER's params.
        const value = typeof next === 'function' ? next(new URLSearchParams(rendered)) : next;
        router.search = value.toString();
        router.writes++;
        router.opts.push(opts);
      };
      return [rendered, set];
    },
  };
});

afterEach(() => { fakeRouter = null; });

/** Render once under the fake router and return [value, setter]. */
function renderFake(search: string, use: () => [string, (v: string) => void]) {
  fakeRouter = { search, writes: 0, opts: [] };
  let captured: [string, (v: string) => void] | undefined;
  function Probe() { captured = use(); return null; }
  renderToString(<Probe />);
  return { value: captured![0], set: captured![1], router: fakeRouter };
}

function readReal(url: string, use: () => [string, unknown]): string {
  let value = '';
  function Probe() { value = use()[0]; return null; }
  renderToString(<MemoryRouter initialEntries={[url]}><Probe /></MemoryRouter>);
  return value;
}

const LEGACY: QueryParamOptions = { legacy: ['lookback'] };

describe('nextSearchParams', () => {
  it('sets a non-default value and keeps unrelated params', () => {
    const next = nextSearchParams(new URLSearchParams('svc=a'), 'range', '-15m', '-1h');
    expect(next.toString()).toBe('svc=a&range=-15m');
  });

  it('omits the param when the value equals the default', () => {
    const next = nextSearchParams(new URLSearchParams('range=-15m&svc=a'), 'range', '-1h', '-1h');
    expect(next.toString()).toBe('svc=a');
  });

  it('deletes legacy keys in the same result', () => {
    const next = nextSearchParams(new URLSearchParams('lookback=-15m'), 'range', '-6h', '-1h', ['lookback']);
    expect(next.toString()).toBe('range=-6h');
  });

  it('does not mutate its input', () => {
    const prev = new URLSearchParams('range=-15m');
    nextSearchParams(prev, 'range', '-1h', '-1h');
    expect(prev.toString()).toBe('range=-15m');
  });
});

describe('reading through a real router', () => {
  it('returns the param, then legacy keys in order, then the default', () => {
    expect(readReal('/?range=-6h&lookback=-15m', () => useRangeParam('-1h', LEGACY))).toBe('-6h');
    expect(readReal('/?lookback=-15m', () => useRangeParam('-1h', LEGACY))).toBe('-15m');
    expect(readReal('/?b=2&a=1', () => useQueryParam('x', 'd', { legacy: ['a', 'b'] }))).toBe('1');
    expect(readReal('/', () => useRangeParam('-1h', LEGACY))).toBe('-1h');
  });

  it('ignores legacy keys it was not told about', () => {
    expect(readReal('/?lookback=-15m', () => useRangeParam('-1h'))).toBe('-1h');
  });
});

describe('the setter makes one write', () => {
  it('reproduces the APM bug: two writes in one handler lose the first', () => {
    // The pre-fix System Architecture handler, against the same fake.
    const { set, router } = renderFake('lookback=-15m', () => {
      const [params, setParams] = ReactRouterDom.useSearchParams();
      return [params.get('range') ?? '-1h', (r: string) => {
        setParams((p) => { p.delete('lookback'); return p; });
        setParams((p) => { if (r === '-1h') p.delete('range'); else p.set('range', r); return p; });
      }];
    });
    set('-1h');
    expect(router.search).toBe('lookback=-15m'); // stuck at 15m
  });

  it('picking the default from a legacy bookmark clears both keys', () => {
    const { value, set, router } = renderFake('lookback=-15m', () => useRangeParam('-1h', LEGACY));
    expect(value).toBe('-15m');
    set('-1h');
    expect(router.writes).toBe(1);
    expect(router.search).toBe('');
  });

  it('picking another range replaces the legacy key with range', () => {
    const { set, router } = renderFake('lookback=-15m&svc=cart', () => useRangeParam('-1h', LEGACY));
    set('-6h');
    expect(router.writes).toBe(1);
    expect(router.search).toBe('svc=cart&range=-6h');
  });

  it('replaces history by default and pushes when asked', () => {
    const replaced = renderFake('', () => useQueryParam('tab', 'overview'));
    replaced.set('logs');
    expect(replaced.router.opts).toEqual([{ replace: true }]);

    const pushed = renderFake('', () => useQueryParam('tab', 'overview', { history: 'push' }));
    pushed.set('logs');
    expect(pushed.router.opts).toEqual([{ replace: false }]);
    expect(pushed.router.search).toBe('tab=logs');
  });
});
