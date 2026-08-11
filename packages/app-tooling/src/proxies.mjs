/**
 * Minimal YAML reader and comparator for Cribl App proxies.yml files.
 *
 * The proxies.yml schema is a small YAML subset: nested maps of scalars
 * plus string sequences (domains, timeout, paths.allowlist/blocklist,
 * headers.inject/allowlist/blocklist). Parsing that subset directly keeps
 * the tooling free of a YAML runtime dependency; anything outside the
 * subset fails loudly rather than being silently misread.
 */

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(token) {
  if (token.length >= 2 &&
      ((token.startsWith('"') && token.endsWith('"')) ||
       (token.startsWith("'") && token.endsWith("'")))) {
    return token.slice(1, -1);
  }
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'null' || token === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  return token;
}

function splitKey(text) {
  const separator = text.indexOf(': ');
  if (separator >= 0) return [text.slice(0, separator).trim(), text.slice(separator + 2).trim()];
  if (text.endsWith(':')) return [text.slice(0, -1).trim(), ''];
  return null;
}

function parseNodes(lines, start, indent) {
  if (lines[start].text.startsWith('- ') || lines[start].text === '-') {
    const items = [];
    let index = start;
    while (index < lines.length && lines[index].indent === indent &&
           (lines[index].text.startsWith('- ') || lines[index].text === '-')) {
      items.push(parseScalar(lines[index].text.replace(/^-\s*/, '')));
      index += 1;
    }
    return [items, index];
  }
  const map = {};
  let index = start;
  while (index < lines.length && lines[index].indent === indent) {
    const parts = splitKey(lines[index].text);
    if (!parts) throw new Error(`proxies.yml line not understood: "${lines[index].text}"`);
    const [key, inline] = parts;
    index += 1;
    if (inline) {
      map[key] = parseScalar(inline);
    } else if (index < lines.length && lines[index].indent > indent) {
      const [child, next] = parseNodes(lines, index, lines[index].indent);
      map[key] = child;
      index = next;
    } else {
      map[key] = null;
    }
  }
  if (index < lines.length && lines[index].indent > indent) {
    throw new Error(`proxies.yml has inconsistent indentation near: "${lines[index].text}"`);
  }
  return [map, index];
}

/** Parse a proxies.yml document (comments and blank lines ignored). */
export function parseProxiesYaml(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const withoutComment = stripComment(raw.replace(/\t/g, '  ')).trimEnd();
    if (!withoutComment.trim()) continue;
    lines.push({
      indent: withoutComment.length - withoutComment.trimStart().length,
      text: withoutComment.trim(),
    });
  }
  if (lines.length === 0) return {};
  const [value] = parseNodes(lines, 0, lines[0].indent);
  return value;
}

const isPlainObject = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const show = (value) => JSON.stringify(value);

function diffLists(actual, expected, path, labels, diffs) {
  const remaining = [...expected];
  for (const entry of actual) {
    const match = remaining.findIndex((candidate) => show(candidate) === show(entry));
    if (match >= 0) remaining.splice(match, 1);
    else diffs.push(`${path}: entry ${show(entry)} is in ${labels.actual} but not in ${labels.expected}`);
  }
  for (const entry of remaining) {
    diffs.push(`${path}: entry ${show(entry)} is in ${labels.expected} but missing from ${labels.actual}`);
  }
}

/**
 * Deep-compare two parsed proxies structures. Returns human-readable
 * difference strings (empty array means the structures match). List
 * order is ignored; every other difference — extra/missing domain,
 * path entry, injected header, changed timeout — is reported.
 */
export function diffProxies(actual, expected, {
  actualLabel = 'packaged proxies.yml',
  expectedLabel = 'expected manifest',
} = {}) {
  const labels = { actual: actualLabel, expected: expectedLabel };
  const diffs = [];
  const walk = (actualNode, expectedNode, path) => {
    if (isPlainObject(actualNode) && isPlainObject(expectedNode)) {
      const keys = [...new Set([...Object.keys(actualNode), ...Object.keys(expectedNode)])].sort();
      for (const key of keys) {
        const childPath = path ? `${path}.${key}` : key;
        if (!(key in expectedNode)) {
          diffs.push(`${childPath}: declared in ${labels.actual} but not in ${labels.expected} (${show(actualNode[key])})`);
        } else if (!(key in actualNode)) {
          diffs.push(`${childPath}: missing from ${labels.actual}; ${labels.expected} declares ${show(expectedNode[key])}`);
        } else {
          walk(actualNode[key], expectedNode[key], childPath);
        }
      }
      return;
    }
    if (Array.isArray(actualNode) && Array.isArray(expectedNode)) {
      diffLists(actualNode, expectedNode, path || '(root)', labels, diffs);
      return;
    }
    if (show(actualNode) !== show(expectedNode)) {
      diffs.push(`${path || '(root)'}: ${labels.actual} has ${show(actualNode)}, ${labels.expected} has ${show(expectedNode)}`);
    }
  };
  walk(actual ?? {}, expected ?? {}, '');
  return diffs;
}
