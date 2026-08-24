/**
 * App settings via the Cribl KV store — re-exported from
 * @criblio/app-utils so app code has one local path to import from.
 *
 * To widen the settings shape, declare your own interface here and use it
 * at the call sites; the framework's loader is schema-free.
 *
 * Imported by SUBPATH — see the note in cribl.ts for why the package root
 * breaks the browser build.
 */

export { loadSettings, saveSettings, type AppSettings } from '@criblio/app-utils/settings';
