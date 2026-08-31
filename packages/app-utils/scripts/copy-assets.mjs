/**
 * Copy non-TS assets from src/ into dist/, preserving layout.
 *
 * `tsc` emits only what it compiles, so the CSS token sheets and the
 * generated OpenAPI digest have to be copied alongside. This replaces
 * a `find … -exec cp --parents` one-liner that only worked on GNU
 * coreutils: on macOS `cp` has no `--parents`, so `npm run build`
 * failed locally while passing in Linux CI, and dist/styles/ was
 * silently absent on a developer's machine.
 */
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

/** Extensions tsc doesn't emit but the package ships. */
const ASSETS = new Set(['.css', '.json']);

let copied = 0;
for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const ext = entry.name.slice(entry.name.lastIndexOf('.'));
  if (!ASSETS.has(ext)) continue;
  // CSS Modules are compiled into stable class maps and ordinary CSS by
  // compile-css-modules.mjs. Publishing the raw source beside them would make
  // it too easy for a consumer to depend on the old bundler-specific path.
  if (entry.name.endsWith('.module.css')) continue;
  // `parentPath` is absolute; keep the path relative to src so
  // src/styles/tokens.css lands at dist/styles/tokens.css.
  const from = join(entry.parentPath, entry.name);
  const to = join(dist, relative(src, from));
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  copied++;
}

process.stderr.write(`copied ${copied} asset${copied === 1 ? '' : 's'} to dist/\n`);
