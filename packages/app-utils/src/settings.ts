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

export async function loadSettings(): Promise<AppSettings> {
  try {
    const resp = await fetch(kvUrl('settings'));
    if (!resp.ok) return { ...DEFAULT_SETTINGS };
    const text = await resp.text();
    return JSON.parse(text) as AppSettings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await fetch(kvUrl('settings'), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(settings),
  });
}
