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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { DatasetProvider } from '../DatasetProvider.js';
import { loadSavedDataset } from '../dataset-settings.js';
import { getCurrentDataset, setCurrentDataset } from '../dataset.js';

const API = 'https://api.example/api/v1';
const originalFetch = globalThis.fetch;

beforeEach(() => {
  setCurrentDataset('');
  (globalThis as { window?: unknown }).window = { CRIBL_API_URL: API };
});
afterEach(() => {
  setCurrentDataset('');
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
