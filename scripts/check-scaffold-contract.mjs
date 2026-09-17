/**
 * Assert `skeleton/` still satisfies the @cribl/apps scaffold contract.
 *
 * `skeleton/` is an OVERLAY on the platform's scaffold, not a fork of it.
 * The previous fork drifted far enough that `apps upgrade` could not repair
 * it — vite.config.ts held the watched config files inline instead of in
 * the named const the live-preview migration edits — and backend functions
 * stayed broken for every generated app until a customer reported it.
 *
 * `apps upgrade` cannot police this. It is VERSION-gated: once
 * `cribl.createAppScriptVersion` names the current contract it skips every
 * migration without looking at file contents, so deleting the backend
 * plugins from vite.config.ts leaves `apps upgrade` a clean no-op. Verified
 * that way round before this script was written.
 *
 * So the requirements are derived from the shipped asset at check time
 * rather than hardcoded here. When the platform adds a plugin, a watched
 * config file, or a config template, this starts failing on the next
 * `@cribl/apps` bump — which is the entire point — instead of going quietly
 * stale the way a copied checklist would.
 *
 * Additions on our side are fine. The contract is "everything the platform
 * ships is present", never "nothing else is".
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skeleton = join(root, 'skeleton');
const appsPkg = join(root, 'node_modules', '@cribl', 'apps');

const failures = [];
const fail = (message) => failures.push(message);

if (!existsSync(appsPkg)) {
  console.error(
    `@cribl/apps is not installed at ${appsPkg}.\n` +
    'Install it at the repo root so the contract can be read from the shipped assets.',
  );
  process.exit(2);
}

const assets = join(appsPkg, 'assets');
const assetVite = await readFile(join(assets, 'vite.config.ts'), 'utf8');
const ourVite = await readFile(join(skeleton, 'vite.config.ts'), 'utf8');

/** Plugin calls inside `defineConfig({ plugins: [...] })`. */
function pluginCalls(source) {
  const match = /plugins:\s*\[([^\]]*)\]/s.exec(source);
  if (!match) return null;
  return [...match[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
}

/** String entries of the `WATCHED_CONFIG_FILES` declaration. */
function watchedFiles(source) {
  const match = /WATCHED_CONFIG_FILES\s*=\s*\[([^\]]*)\]/s.exec(source);
  if (!match) return null;
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/** `@cribl/apps/...` module specifiers the file imports from. */
function appsImports(source) {
  return [...source.matchAll(/from\s+['"](@cribl\/apps[^'"]*)['"]/g)].map((m) => m[1]);
}

const wantPlugins = pluginCalls(assetVite);
const gotPlugins = pluginCalls(ourVite);
if (!wantPlugins) fail('could not read the plugin array from the shipped vite.config.ts asset');
else if (!gotPlugins) fail('skeleton/vite.config.ts has no readable `plugins: [...]` array');
else {
  for (const plugin of wantPlugins) {
    if (!gotPlugins.includes(plugin)) {
      fail(`skeleton/vite.config.ts does not invoke ${plugin}(), which the scaffold ships`);
    }
  }
}

const wantWatched = watchedFiles(assetVite);
const gotWatched = watchedFiles(ourVite);
if (!wantWatched) fail('could not read WATCHED_CONFIG_FILES from the shipped asset');
else if (!gotWatched) {
  // Keeping the named const matters beyond readability: the live-preview
  // migration edits this exact declaration, so inlining the paths is what
  // makes the file unrepairable by `apps upgrade`.
  fail('skeleton/vite.config.ts has no WATCHED_CONFIG_FILES const — the live-preview migration edits that declaration by name');
} else {
  for (const file of wantWatched) {
    if (!gotWatched.includes(file)) {
      fail(`skeleton/vite.config.ts does not watch ${file}, which the scaffold watches`);
    }
  }
}

for (const specifier of appsImports(assetVite)) {
  if (!appsImports(ourVite).includes(specifier)) {
    fail(`skeleton/vite.config.ts does not import ${specifier}, which the scaffold imports`);
  }
}

// Every config template the scaffold ships must exist in the skeleton. An
// app missing config/backend.yml cannot declare an endpoint at all.
for (const name of await readdir(join(assets, 'config'))) {
  if (!existsSync(join(skeleton, 'config', name))) {
    fail(`skeleton/config/${name} is missing — the scaffold ships it`);
  }
}

// The contract version we claim has to be the one we are actually checked
// against, or `apps upgrade` skips migrations we never applied.
const installed = JSON.parse(await readFile(join(appsPkg, 'package.json'), 'utf8')).version;
const declared = JSON.parse(await readFile(join(skeleton, 'package.json'), 'utf8'))
  ?.cribl?.createAppScriptVersion;
if (declared !== installed) {
  fail(
    `skeleton/package.json declares createAppScriptVersion ${declared ?? '(absent)'} ` +
    `but @cribl/apps ${installed} is installed. Adopt the new scaffold and update the marker together.`,
  );
}

if (failures.length > 0) {
  console.error(`skeleton/ is behind the @cribl/apps ${installed} scaffold contract:\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('\nRe-derive the drifted file from node_modules/@cribl/apps/assets/.');
  process.exit(1);
}

console.log(
  `skeleton/ satisfies the @cribl/apps ${installed} scaffold contract ` +
  `(${wantPlugins.length} plugins, ${wantWatched.length} watched files)`,
);
