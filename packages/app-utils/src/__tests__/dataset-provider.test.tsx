/**
 * `<DatasetProvider>` defaults.
 *
 * Two defects, both of which made a non-otel app query the wrong dataset:
 *
 * - The `defaultDataset` prop was applied inside the provider's own
 *   `useEffect`. React runs child effects before a parent's, so every
 *   child rendered — and fired its first query, including a provisioning
 *   banner's `planOnly` — with `dataset=""`. APM worked around it by
 *   setting the store at module scope.
 * - `loadSettings()` was called with no defaults, so for a workspace with
 *   nothing saved it returned the framework's `{ dataset: 'otel' }` and
 *   overwrote the app's own default.
 *
 * `renderToString` runs render but never effects, which is exactly the
 * window the first defect lived in: whatever a child sees here is what it
 * saw on its first client render too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { DatasetProvider } from '../DatasetProvider.js';
import { loadSavedDataset, syncSavedDataset, type DatasetLoadContext } from '../dataset-settings.js';
import {
  getCurrentDataset,
  getDatasetLoadError,
  setCurrentDataset,
  setDatasetLoadError,
  useDatasetLoadError,
} from '../dataset.js';

const API = 'https://api.example/api/v1';
const originalFetch = globalThis.fetch;

beforeEach(() => {
  setCurrentDataset('');
  setDatasetLoadError(null);
  (globalThis as { window?: unknown }).window = { CRIBL_API_URL: API };
});
afterEach(() => {
  setCurrentDataset('');
  setDatasetLoadError(null);
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  delete (globalThis as { window?: unknown }).window;
});

/** Serve one KV response for the `settings` key. */
function serveSettings(body: string, status = 200) {
  globalThis.fetch = (async () => new Response(body, {
    status, headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
}
const nothingSaved = () => serveSettings(JSON.stringify({ message: 'Key not found' }), 404);

describe('DatasetProvider applies defaultDataset before children render', () => {
  it('a child sees the default on its first render, not ""', () => {
    const seen: string[] = [];
    function Probe() {
      seen.push(getCurrentDataset());
      return null;
    }
    renderToString(
      <DatasetProvider defaultDataset="web_events">
        <Probe />
      </DatasetProvider>,
    );
    expect(seen).toEqual(['web_events']);
  });

  it('does not overwrite a dataset already in the store', () => {
    // A remount after the user picked a dataset, or an app that set a
    // module-scope default (APM's workaround) — neither is clobbered.
    setCurrentDataset('chosen');
    renderToString(
      <DatasetProvider defaultDataset="web_events">
        <span />
      </DatasetProvider>,
    );
    expect(getCurrentDataset()).toBe('chosen');
  });

  it('leaves the store empty when there is no default to apply', () => {
    renderToString(
      <DatasetProvider>
        <span />
      </DatasetProvider>,
    );
    expect(getCurrentDataset()).toBe('');
  });
});

describe('loadSavedDataset (the provider\'s KV read)', () => {
  it('nothing saved resolves to the app default, not the framework\'s otel', async () => {
    nothingSaved();
    await expect(loadSavedDataset('web_events')).resolves.toBe('web_events');
  });

  it('saved settings without a dataset key still resolve to the app default', async () => {
    serveSettings(JSON.stringify({ searchCadence: '1m' }));
    await expect(loadSavedDataset('web_events')).resolves.toBe('web_events');
  });

  it('a saved dataset wins over the app default', async () => {
    serveSettings(JSON.stringify({ dataset: ' my_otel ' }));
    await expect(loadSavedDataset('web_events')).resolves.toBe('my_otel');
  });

  it('the old call shape is what returned otel over an app default', async () => {
    // What the provider used to do: `loadSettings()` with no defaults.
    nothingSaved();
    const { loadSettings } = await import('../settings.js');
    await expect(loadSettings()).resolves.toEqual({ dataset: 'otel' });
  });

  it('with no app default, the framework default is unchanged', async () => {
    nothingSaved();
    await expect(loadSavedDataset()).resolves.toBe('otel');
  });

  it('a KV failure rejects rather than inventing a value', async () => {
    serveSettings('<html>not found</html>', 404);
    await expect(loadSavedDataset('web_events')).rejects.toThrow(/returned HTML/);
  });
});

describe('a KV failure is surfaced, and the fallback kept (syncSavedDataset, the provider effect)', () => {
  const brokenKv = () => serveSettings('<html>not found</html>', 404);

  it('keeps the app default, records the error, and calls onError', async () => {
    setCurrentDataset('web_events');
    brokenKv();
    const onError = vi.fn();
    await syncSavedDataset('web_events', { onError });
    expect(getCurrentDataset()).toBe('web_events');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(getDatasetLoadError()?.message).toMatch(/returned HTML/);
  });

  it('warns instead of staying silent when no onError is given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    brokenKv();
    await syncSavedDataset('web_events');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(getDatasetLoadError()).toBeInstanceOf(Error);
  });

  it('a throwing onError does not reject', async () => {
    brokenKv();
    await expect(syncSavedDataset('web_events', { onError: () => { throw new Error('reporter'); } })).resolves.toBeUndefined();
  });

  it('a later successful load applies the saved value and clears the error', async () => {
    setDatasetLoadError(new Error('earlier'));
    serveSettings(JSON.stringify({ dataset: 'my_otel' }));
    const onError = vi.fn();
    await syncSavedDataset('web_events', { onError });
    expect(getCurrentDataset()).toBe('my_otel');
    expect(getDatasetLoadError()).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('a cancelled (unmounted) load changes nothing', async () => {
    brokenKv();
    const onError = vi.fn();
    await syncSavedDataset('web_events', { onError, isCancelled: () => true });
    expect(getDatasetLoadError()).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('useDatasetLoadError reads the recorded error', () => {
    function Probe() {
      const err = useDatasetLoadError();
      return <span>{err ? `error:${err.message}` : 'ok'}</span>;
    }
    expect(renderToString(<Probe />)).toContain('ok');
    setDatasetLoadError(new Error('kv down'));
    expect(renderToString(<Probe />)).toContain('error:kv down');
  });

  it('DatasetProvider accepts onError without changing first render', () => {
    const html = renderToString(
      <DatasetProvider defaultDataset="web_events" onError={() => undefined}>
        <span>child</span>
      </DatasetProvider>,
    );
    expect(html).toContain('child');
    expect(getCurrentDataset()).toBe('web_events');
  });
});

describe('loadDataset receives cancellation (syncSavedDataset, the provider effect)', () => {
  /** A loader whose read the test settles by hand, recording its context. */
  function deferredLoader() {
    let settle!: { resolve: (v: string | undefined) => void; reject: (e: unknown) => void };
    const contexts: DatasetLoadContext[] = [];
    const loader = (context: DatasetLoadContext) => {
      contexts.push(context);
      return new Promise<string | undefined>((resolve, reject) => {
        settle = { resolve, reject };
      });
    };
    return { loader, contexts, settle: () => settle };
  }

  it('the loader gets a live signal and isCancelled() while the load is current', async () => {
    const { loader, contexts, settle } = deferredLoader();
    const controller = new AbortController();
    const done = syncSavedDataset('web_events', { loadDataset: loader, signal: controller.signal });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].signal).toBe(controller.signal);
    expect(contexts[0].signal.aborted).toBe(false);
    expect(contexts[0].isCancelled()).toBe(false);
    settle().resolve('saved_ds');
    await done;
    expect(getCurrentDataset()).toBe('saved_ds');
  });

  it('abort during the read: the loader sees it, and its result is not applied', async () => {
    setCurrentDataset('web_events');
    const { loader, contexts, settle } = deferredLoader();
    const controller = new AbortController();
    const done = syncSavedDataset('web_events', { loadDataset: loader, signal: controller.signal });
    controller.abort();
    // What a loader with side effects checks before applying them.
    expect(contexts[0].isCancelled()).toBe(true);
    expect(contexts[0].signal.aborted).toBe(true);
    settle().resolve('stale_ds');
    await done;
    expect(getCurrentDataset()).toBe('web_events');
  });

  it('a cancelled load\'s rejection (AbortError) is not reported as a load failure', async () => {
    const { loader, settle } = deferredLoader();
    const controller = new AbortController();
    const onError = vi.fn();
    const done = syncSavedDataset('web_events', { loadDataset: loader, signal: controller.signal, onError });
    controller.abort();
    settle().reject(new DOMException('aborted', 'AbortError'));
    await done;
    expect(onError).not.toHaveBeenCalled();
    expect(getDatasetLoadError()).toBeNull();
  });

  it('a cancelled load does not clear an earlier recorded error either', async () => {
    const earlier = new Error('earlier');
    setDatasetLoadError(earlier);
    const { loader, settle } = deferredLoader();
    const controller = new AbortController();
    const done = syncSavedDataset('web_events', { loadDataset: loader, signal: controller.signal });
    controller.abort();
    settle().resolve('stale_ds');
    await done;
    expect(getDatasetLoadError()).toBe(earlier);
  });

  it('isCancelled option still cancels, and the loader sees it through its context', async () => {
    let cancelled = false;
    const { loader, contexts, settle } = deferredLoader();
    const done = syncSavedDataset('web_events', { loadDataset: loader, isCancelled: () => cancelled });
    cancelled = true;
    expect(contexts[0].isCancelled()).toBe(true);
    settle().resolve('stale_ds');
    await done;
    expect(getCurrentDataset()).toBe('');
  });

  it('with no signal, the loader still gets a context that is never cancelled', async () => {
    const { loader, contexts, settle } = deferredLoader();
    const done = syncSavedDataset(undefined, { loadDataset: loader });
    expect(contexts[0].signal).toBeInstanceOf(AbortSignal);
    expect(contexts[0].isCancelled()).toBe(false);
    settle().resolve(' mine ');
    await done;
    expect(getCurrentDataset()).toBe('mine');
  });

  it('a zero-argument loader (the 0.12.4 shape) still works', async () => {
    const legacy: () => Promise<string | undefined> = async () => 'legacy_ds';
    await syncSavedDataset('web_events', { loadDataset: legacy });
    expect(getCurrentDataset()).toBe('legacy_ds');
    await expect(loadSavedDataset('web_events', { loadDataset: legacy })).resolves.toBe('legacy_ds');
  });

  it('loadSavedDataset hands its context to the loader', async () => {
    const controller = new AbortController();
    const context: DatasetLoadContext = { signal: controller.signal, isCancelled: () => controller.signal.aborted };
    const loader = vi.fn(async (_ctx: DatasetLoadContext) => 'x');
    await loadSavedDataset(undefined, { loadDataset: loader }, context);
    expect(loader).toHaveBeenCalledWith(context);
  });
});
