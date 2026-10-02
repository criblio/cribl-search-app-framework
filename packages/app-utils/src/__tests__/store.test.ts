/**
 * `createStore` / `useStore`.
 *
 * APM hand-copied this store five times (streamFilter, lowVolumeMode,
 * metricsRead, metricsEmit, serverInvestigations) and the copies drifted to
 * different defaults; one copy is the fix. The behaviours pinned here are the
 * ones every copy shared and every caller relies on: an unchanged set fires
 * nothing, and one throwing listener does not starve the rest.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createStore, useStore } from '../store.js';
import { getCurrentDataset, setCurrentDataset, subscribeDataset } from '../dataset.js';
import { getSearchCadence, setSearchCadence, subscribeSearchCadence } from '../cadence.js';

describe('createStore', () => {
  it('returns the initial value and the latest set value', () => {
    const s = createStore(false);
    expect(s.get()).toBe(false);
    s.set(true);
    expect(s.get()).toBe(true);
  });

  it('notifies subscribers with the new value', () => {
    const s = createStore('a');
    const fn = vi.fn();
    s.subscribe(fn);
    s.set('b');
    expect(fn).toHaveBeenCalledExactlyOnceWith('b');
  });

  it('an unchanged set fires no listener (Object.is)', () => {
    const obj = { n: 1 };
    const s = createStore(obj);
    const nan = createStore(Number.NaN);
    const fn = vi.fn();
    s.subscribe(fn);
    nan.subscribe(fn);
    s.set(obj);
    nan.set(Number.NaN);
    expect(fn).not.toHaveBeenCalled();
    s.set({ n: 1 }); // a new reference is a change
    expect(fn).toHaveBeenCalledOnce();
  });

  it('a throwing listener does not stop the others from seeing the change', () => {
    const s = createStore(0);
    const before = vi.fn();
    const after = vi.fn();
    s.subscribe(before);
    s.subscribe(() => {
      throw new Error('broken subscriber');
    });
    s.subscribe(after);
    expect(() => s.set(1)).not.toThrow();
    expect(before).toHaveBeenCalledWith(1);
    expect(after).toHaveBeenCalledWith(1);
    expect(s.get()).toBe(1);
  });

  it('unsubscribe stops notifications', () => {
    const s = createStore(0);
    const fn = vi.fn();
    const off = s.subscribe(fn);
    off();
    s.set(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('separate stores do not share state or listeners', () => {
    const a = createStore(false);
    const b = createStore(true);
    const fn = vi.fn();
    a.subscribe(fn);
    b.set(false);
    expect(a.get()).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('get/set/subscribe work detached from the store object', () => {
    // APM re-exports them as `export const getX = store.get`.
    const { get, set, subscribe } = createStore(1);
    const fn = vi.fn();
    subscribe(fn);
    set(2);
    expect(get()).toBe(2);
    expect(fn).toHaveBeenCalledWith(2);
  });
});

describe('useStore', () => {
  it('renders the current value', () => {
    const s = createStore('first');
    const View = () => createElement('span', null, useStore(s));
    expect(renderToString(createElement(View))).toBe('<span>first</span>');
    s.set('second');
    expect(renderToString(createElement(View))).toBe('<span>second</span>');
  });
});

describe('dataset and cadence keep their API on top of createStore', () => {
  it('dataset trims, no-ops when unchanged, and notifies', () => {
    setCurrentDataset('');
    const fn = vi.fn();
    const off = subscribeDataset(fn);
    try {
      setCurrentDataset('  otel  ');
      expect(getCurrentDataset()).toBe('otel');
      setCurrentDataset('otel');
      expect(fn).toHaveBeenCalledOnce();
    } finally {
      off();
      setCurrentDataset('');
    }
  });

  it('cadence falls back to the default on an unknown value and no-ops when unchanged', () => {
    setSearchCadence('5m');
    const fn = vi.fn();
    const off = subscribeSearchCadence(fn);
    try {
      setSearchCadence('nonsense'); // → default '5m', unchanged
      expect(fn).not.toHaveBeenCalled();
      setSearchCadence('1m');
      expect(getSearchCadence()).toBe('1m');
      expect(fn).toHaveBeenCalledOnce();
    } finally {
      off();
      setSearchCadence('5m');
    }
  });
});
