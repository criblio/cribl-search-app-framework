/**
 * Convert CSS Modules in the TypeScript output into ordinary, globally unique
 * CSS plus plain JavaScript class maps. Published components keep importing
 * their own stylesheet automatically, but consumers and CDNs no longer need
 * to understand CSS Modules.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function kebab(value) {
  return value
    .replaceAll(sep, '/')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileModule(source, sourcePath) {
  const rel = relative(src, sourcePath).replaceAll(sep, '/');
  const stem = rel.replace(/\.module\.css$/, '');
  const prefix = `criblio-au-${kebab(stem)}`;
  const classes = new Map();
  const classPattern = /(^|[^\w./"'\\-])\.([A-Za-z_][A-Za-z0-9_-]*)/g;
  let css = source.replace(classPattern, (match, before, name) => {
    const scoped = classes.get(name) ?? `${prefix}__${name}`;
    classes.set(name, scoped);
    return `${before}.${scoped}`;
  });

  const keyframes = [...source.matchAll(/@(?:-webkit-)?keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)/g)]
    .map((match) => match[1]);
  for (const name of keyframes) {
    const scoped = `${prefix}__${name}`;
    css = css
      .replace(new RegExp(`(@(?:-webkit-)?keyframes\\s+)${escapeRegExp(name)}\\b`, 'g'), `$1${scoped}`)
      .replace(
        new RegExp(`((?:-webkit-)?animation(?:-name)?\\s*:[^;{}]*)\\b${escapeRegExp(name)}\\b`, 'g'),
        `$1${scoped}`,
      );
  }

  if (classes.size === 0) throw new Error(`${rel} contains no CSS classes`);
  const object = Object.fromEntries(classes);
  const js = `const classes = ${JSON.stringify(object, null, 2)};\nexport default classes;\n`;
  const dts = [
    'declare const classes: {',
    ...[...classes.keys()].map((name) => `  readonly ${JSON.stringify(name)}: string;`),
    '};',
    'export default classes;',
    '',
  ].join('\n');
  return { rel, stem, css, js, dts };
}

const modules = filesUnder(src)
  .filter((path) => path.endsWith('.module.css'))
  .sort()
  .map((path) => compileModule(readFileSync(path, 'utf8'), path));

for (const module of modules) {
  const base = join(dist, module.stem);
  mkdirSync(dirname(base), { recursive: true });
  writeFileSync(`${base}.css`, module.css);
  writeFileSync(`${base}.classes.js`, module.js);
  writeFileSync(`${base}.classes.d.ts`, module.dts);
}

const importPattern = /import\s+([A-Za-z_$][\w$]*)\s+from\s+(["'])(\.\.?\/[^"']+)\.module\.css\2\s*;/g;
for (const path of filesUnder(dist).filter((file) => file.endsWith('.js'))) {
  const source = readFileSync(path, 'utf8');
  const rewritten = source.replace(importPattern, (_match, binding, quote, specifier) =>
    `import ${binding} from ${quote}${specifier}.classes.js${quote};\nimport ${quote}${specifier}.css${quote};`);
  writeFileSync(path, rewritten);
}

const unresolved = filesUnder(dist)
  .filter((path) => path.endsWith('.js') &&
    /\b(?:from\s+|import\s+)[^;\n]*["'][^"']+\.module\.css["']/.test(readFileSync(path, 'utf8')));
if (unresolved.length > 0) {
  throw new Error(`published JavaScript still imports CSS Modules:\n${unresolved.map((path) => relative(dist, path)).join('\n')}`);
}

writeFileSync(
  join(dist, 'styles.css'),
  modules.map((module) => `/* ${module.rel} */\n${module.css.trim()}\n`).join('\n'),
);

process.stderr.write(`compiled ${modules.length} CSS Modules with stable prefixed class names\n`);
