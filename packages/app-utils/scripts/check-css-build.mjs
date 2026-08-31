import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

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

if (!existsSync(join(dist, 'styles.css'))) fail('aggregate styles.css is missing');
process.stderr.write(`validated ${classFiles.length} generated CSS class maps (${seen.size} globally unique names)\n`);
