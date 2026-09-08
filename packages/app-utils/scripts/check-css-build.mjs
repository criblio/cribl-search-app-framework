import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function fail(message) {
  throw new Error(`CSS package check failed: ${message}`);
}

const jsFiles = filesUnder(dist).filter((path) => path.endsWith('.js'));
const unresolved = jsFiles.filter((path) =>
  /\b(?:from\s+|import\s+)[^;\n]*["'][^"']+\.module\.css["']/.test(readFileSync(path, 'utf8')));
if (unresolved.length > 0) {
  fail(`JavaScript still imports CSS Modules:\n${unresolved.map((path) => relative(dist, path)).join('\n')}`);
}

const classFiles = filesUnder(dist).filter((path) => path.endsWith('.classes.js'));
if (classFiles.length === 0) fail('no generated class maps');
const seen = new Map();
for (const path of classFiles) {
  const source = readFileSync(path, 'utf8');
  const values = [...source.matchAll(/:\s*"([^"]+)"/g)].map((match) => match[1]);
  if (values.length === 0) fail(`${relative(dist, path)} has no class names`);
  const cssPath = path.replace(/\.classes\.js$/, '.css');
  if (!existsSync(cssPath)) fail(`${relative(dist, path)} has no matching CSS file`);
  const css = readFileSync(cssPath, 'utf8');
  for (const value of values) {
    const owner = seen.get(value);
    if (owner) fail(`${value} is shared by ${owner} and ${relative(dist, path)}`);
    seen.set(value, relative(dist, path));
    if (!css.includes(`.${value}`) && !css.includes(`@keyframes ${value}`)) {
      fail(`${value} from ${relative(dist, path)} is absent from its CSS`);
    }
  }
}

const investigatorJs = readFileSync(join(dist, 'investigator', 'InvestigatorChat.js'), 'utf8');
if (!investigatorJs.includes("from './InvestigatorChat.classes.js'")) fail('InvestigatorChat does not import its generated class map');
if (!investigatorJs.includes("import './InvestigatorChat.css'")) fail('InvestigatorChat does not load its generated CSS');
const investigatorCss = readFileSync(join(dist, 'investigator', 'InvestigatorChat.css'), 'utf8');
if (!investigatorCss.includes('@keyframes criblio-au-investigator-investigator-chat__bounce')) {
  fail('InvestigatorChat keyframes are not scoped');
}

const provisioning = readFileSync(join(dist, 'ProvisioningPanel.classes.js'), 'utf8');
for (const name of ['actionKind_create', 'summaryChip_noop']) {
  if (!provisioning.includes(`"${name}"`)) fail(`dynamic class ${name} is missing`);
}

/**
 * A stylesheet must not be reachable from two entry points except through
 * an exported subpath.
 *
 * esm.sh builds each exported subpath as its own bundle and inlines what
 * only that bundle uses. An import that names another exported subpath is
 * a clean boundary — it becomes `import "…/es2022/viz.mjs"`, a real build,
 * and its CSS is handled. A *deep internal* module reachable from two
 * entry points is not: esm.sh serves it from the raw `dist/` path and
 * leaves its CSS import as `<name>.css.mjs` — raw CSS in a file an esbuild
 * consumer parses as JavaScript, dying on the first rule.
 *
 * 0.8.4 shipped exactly that. A shared `ResultTable`, imported by deep
 * path from both the transcript and the metrics card, pulled the chat
 * shell's stylesheet across the boundary and broke every esm.sh consumer
 * of either entry. `./viz` proves the legal shape: the metrics card reaches
 * it too, but through the exported subpath, so it has always been fine.
 *
 * Nothing about the tarball looks wrong — the break only appears
 * downstream — so it has to be caught here.
 */
const entryPoints = new Map();
for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
  if (typeof target !== 'string' || !target.endsWith('.js')) continue;
  entryPoints.set(join(root, target), subpath);
}
if (entryPoints.size === 0) fail('no entry points found in package.json exports');

/**
 * Stylesheets an entry bundles itself.
 *
 * Traversal stops at any *other* entry point: esm.sh serves that as its own
 * bundle, so whatever lies beyond it is that entry's problem, not this
 * one's. Everything short of such a boundary gets inlined into this bundle.
 */
function stylesheetsBundledBy(entry) {
  const found = new Set();
  const visited = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file) || !existsSync(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const resolved = join(dirname(file), match[1]);
      if (resolved.endsWith('.css')) found.add(relative(dist, resolved));
      else if (resolved.endsWith('.js') && !entryPoints.has(resolved)) queue.push(resolved);
    }
  }
  return found;
}

const bundledBy = new Map();
for (const [entry, subpath] of entryPoints) {
  for (const sheet of stylesheetsBundledBy(entry)) {
    if (!bundledBy.has(sheet)) bundledBy.set(sheet, []);
    bundledBy.get(sheet).push(subpath);
  }
}
const shared = [...bundledBy].filter(([, subpaths]) => subpaths.length > 1);
if (shared.length > 0) {
  fail(
    'a stylesheet is bundled into more than one entry point, which esm.sh ' +
      'code-splits into a .css.mjs that esbuild consumers cannot load:\n' +
      shared.map(([sheet, subpaths]) => `  ${sheet} <- ${subpaths.join(', ')}`).join('\n') +
      '\nGive each entry point its own stylesheet, and share only CSS-free ' +
      'modules or whole exported subpaths.',
  );
}

if (!existsSync(join(dist, 'styles.css'))) fail('aggregate styles.css is missing');
process.stderr.write(
  `validated ${classFiles.length} generated CSS class maps (${seen.size} globally unique names), ` +
    `${bundledBy.size} stylesheets each bundled by one entry point\n`,
);
