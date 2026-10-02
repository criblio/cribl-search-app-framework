/**
 * Optional peers stay confined to their subpaths.
 *
 * `@criblio/app-utils` is router-free: `react-router-dom` is an optional
 * peer used by `/url-state` alone, and `@capra/core` by the Capra-based
 * components alone. An app without them must still be able to import the
 * root and every other subpath, so no other module may import the peer and
 * the root index must not re-export the modules that do. A missing
 * optional peer is invisible to this repo's own build (they are
 * devDependencies here) and only fails in the consumer's bundler.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function importers(peer: string): string[] {
  const pattern = new RegExp(`from ['"]${peer}['"]|import\\(['"]${peer}['"]\\)`);
  return sources(SRC)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(SRC, file));
}

describe('optional peer isolation', () => {
  it('only url-state imports a router', () => {
    expect(importers('react-router(-dom)?')).toEqual(['url-state.ts']);
  });

  it('the root index re-exports neither url-state nor a Capra component', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(index).not.toMatch(/url-state/);
    expect(index).not.toMatch(/PartialFailureBanner/);
    const capra = new Set(importers('@capra/core').map((f) => f.replace(/\.tsx?$/, '')));
    for (const [, spec] of index.matchAll(/from '\.\/([^']+)\.js'/g)) {
      expect(capra.has(spec!), `index re-exports Capra module ${spec}`).toBe(false);
    }
  });
});
