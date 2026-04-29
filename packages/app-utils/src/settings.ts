/**
 * App settings via Cribl KV store.
 * Each app stores its config under a pack-scoped KV key.
 */

import { apiUrl } from './search.js';

export interface AppSettings {
  dataset: string;
  [key: string]: unknown;
}

const DEFAULT_SETTINGS: AppSettings = { dataset: 'otel' };

function kvUrl(key: string): string {
  const appId = window.CRIBL_APP_ID ?? '';
  return `${apiUrl()}/kvstore/${appId}/${key}`;
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
