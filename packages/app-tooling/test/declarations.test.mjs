/**
 * Every public subpath ships type declarations, and they declare every
 * runtime export. `./proxies` shipped with none, so a strict TS app got
 * TS7016 importing `parseProxiesYaml`; `npm run typecheck` compiles a
 * strict consumer through the exports map, and this pins the coverage so
 * a new export (or a new subpath) cannot land untyped.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pkgUrl = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));

/** Names a d.ts exports: `export function|const|class X`, `export { a, b } from`. */
function declaredNames(dts) {
  const names = new Set();
  for (const m of dts.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of dts.matchAll(/^export\s+\{([^}]*)\}\s+from/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  return names;
}

for (const [subpath, target] of Object.entries(pkg.exports)) {
  test(`${subpath} declares types for every runtime export`, async () => {
    assert.equal(typeof target, 'object', `${subpath} must use { types, default }`);
    assert.ok(target.types, `${subpath} has no "types" condition`);
    assert.equal(Object.keys(target)[0], 'types', `${subpath}: "types" must come first`);
    const dts = readFileSync(new URL(`../${target.types}`, import.meta.url), 'utf8');
    const declared = declaredNames(dts);
    const runtime = Object.keys(await import(new URL(`../${target.default}`, import.meta.url)));
    const missing = runtime.filter((name) => !declared.has(name));
    assert.deepEqual(missing, [], `${target.types} does not declare: ${missing.join(', ')}`);
  });
}
