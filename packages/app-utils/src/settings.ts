/**
 * App settings via Cribl KV store.
 *
 * Each app gets its own KV namespace, scoped automatically by the
 * platform's fetch proxy. App code calls `${apiUrl()}/kvstore/key`
 * and the proxy rewrites to the scoped path (`/api/v1/a/{appId}/
 * kvstore/key`) under the new app-platform conventions; under the
 * older pack model it rewrote to `/api/v1/p/{packId}/kvstore/key`.
 * Either way, the manual `${appId}/` segment we used to inject
 * here was wrong — it produced double-scoped paths that failed.
 */

import { apiUrl } from './search.js';

export interface AppSettings {
  dataset: string;
  [key: string]: unknown;
}

const DEFAULT_SETTINGS: AppSettings = { dataset: 'otel' };

function kvUrl(key: string): string {
  return `${apiUrl()}/kvstore/${key}`;
}

/**
 * Load app settings, falling back to `defaults` when the KV key is missing
 * or unreadable. Saved values are merged over the defaults, so adding a new
 * setting with a default doesn't require migrating stored blobs.
 */
export async function loadSettings(defaults: AppSettings = DEFAULT_SETTINGS): Promise<AppSettings> {
  try {
    const resp = await fetch(kvUrl('settings'));
    if (!resp.ok) return { ...defaults };
    const text = await resp.text();
    return { ...defaults, ...(JSON.parse(text) as AppSettings) };
  } catch {
    return { ...defaults };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await fetch(kvUrl('settings'), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(settings),
  });
}
