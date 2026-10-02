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

/** The KV key settings live at unless an app says otherwise. */
export const DEFAULT_SETTINGS_KEY = 'settings';

export interface SettingsKeyOptions {
  /** KV key holding the settings object. Default `'settings'`. An app
   * whose settings predate the framework (APM's live at its own key) passes
   * that key here instead of keeping a private loader. */
  key?: string;
}

export interface SaveSettingsOptions extends SettingsKeyOptions {
  /**
   * Read the stored object first and shallow-merge `settings` over it, so
   * fields this caller does not know about survive the write — two pages
   * that each own part of one settings object no longer erase each other.
   * The read must succeed: a misroute, a rejected credential or a stored
   * value that is not an object aborts with `KvError` and writes NOTHING,
   * because merging over a read that never reached the store would write a
   * partial object over the real one. A genuinely absent key merges over
   * `{}`. Not atomic: a write landing between the read and this write is
   * lost. Default `false` (replace the stored value).
   */
  merge?: boolean;
}

function settingsKey(options?: SettingsKeyOptions): string {
  const key = options?.key ?? DEFAULT_SETTINGS_KEY;
  if (!key) throw new Error('settings key must be a non-empty string');
  return key;
}

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
export async function loadSettings(
  defaults: AppSettings = DEFAULT_SETTINGS,
  options?: SettingsKeyOptions,
): Promise<AppSettings> {
  const result = await kvGetJson<AppSettings>(settingsKey(options));
  return result.found ? { ...defaults, ...result.value } : { ...defaults };
}

/**
 * Persist app settings.
 *
 * **Behavior change:** this used to ignore `response.ok`, so a rejected
 * save reported success and the user's change silently vanished on the next
 * load. It now throws `KvError` on failure. Callers that relied on the old
 * silence need a `catch` — see `saveSettingsResult` for a non-throwing
 * form. `{ merge: true }` writes over the stored object instead of
 * replacing it (see `SaveSettingsOptions.merge`).
 */
export async function saveSettings(settings: AppSettings, options?: SaveSettingsOptions): Promise<void> {
  const key = settingsKey(options);
  let body: Record<string, unknown> = settings;
  if (options?.merge) {
    // kvGetJson throws KvError for a misroute or any failed read — and that
    // throw IS the abort: nothing below runs.
    const current = await kvGetJson<unknown>(key);
    if (current.found) {
      const value = current.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new KvError(
          `KV value at ${key} is not an object, so settings cannot be merged over it; nothing was written`,
          { key, bodyKind: 'json' },
        );
      }
      body = { ...(value as Record<string, unknown>), ...settings };
    }
  }
  await kvPutText(key, JSON.stringify(body));
}

/** Non-throwing {@link saveSettings}, for a settings page that would rather
 *  render the failure than unwind. */
export async function saveSettingsResult(
  settings: AppSettings,
  options?: SaveSettingsOptions,
): Promise<{ ok: true } | { ok: false; error: KvError }> {
  try {
    await saveSettings(settings, options);
    return { ok: true };
  } catch (error) {
    if (error instanceof KvError) return { ok: false, error };
    throw error;
  }
}
