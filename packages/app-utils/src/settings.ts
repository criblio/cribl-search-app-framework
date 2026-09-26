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

import { KvError, kvGetJson, kvPutText } from './kv.js';

export interface AppSettings {
  dataset: string;
  [key: string]: unknown;
}

const DEFAULT_SETTINGS: AppSettings = { dataset: 'otel' };

/**
 * Load app settings, falling back to `defaults` when the key is absent.
 * Saved values merge over the defaults, so adding a new setting with a
 * default does not require migrating stored blobs.
 *
 * Absence falls back; a ROUTING failure does not. An HTML 404 means the
 * request never reached the KV store, and substituting defaults there
 * invents state the app then writes back over whatever was really stored.
 * That distinction is why this delegates to `kvGetJson` rather than
 * catching everything.
 */
export async function loadSettings(defaults: AppSettings = DEFAULT_SETTINGS): Promise<AppSettings> {
  const result = await kvGetJson<AppSettings>('settings');
  return result.found ? { ...defaults, ...result.value } : { ...defaults };
}

/**
 * Persist app settings.
 *
 * **Behavior change:** this used to ignore `response.ok`, so a rejected
 * save reported success and the user's change silently vanished on the next
 * load. It now throws `KvError` on failure. Callers that relied on the old
 * silence need a `catch` — see `saveSettingsResult` for a non-throwing
 * form.
 */
export async function saveSettings(settings: AppSettings): Promise<void> {
  await kvPutText('settings', JSON.stringify(settings));
}

/** Non-throwing {@link saveSettings}, for a settings page that would rather
 *  render the failure than unwind. */
export async function saveSettingsResult(
  settings: AppSettings,
): Promise<{ ok: true } | { ok: false; error: KvError }> {
  try {
    await saveSettings(settings);
    return { ok: true };
  } catch (error) {
    if (error instanceof KvError) return { ok: false, error };
    throw error;
  }
}
