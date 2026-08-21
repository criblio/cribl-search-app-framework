/**
 * Write tools + git write-back over a REAL SQLite (node:sqlite), so
 * the dirty-tracking SQL and the store's read-after-write semantics
 * are exercised for real. open_pr's GitHub calls are captured by a
 * scripted fetch — the assertions pin the Data API sequence (tree →
 * commit → ref → pull) and the request bodies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { RepoStore } from '../repoStore';
import { createWriteToolExecutors } from '../writeTools';

/** Adapter: node:sqlite → the minimal Sql shape RepoStore uses. */
function sqliteSql() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        return { toArray: () => stmt.all(...(bindings as never[])) as Record<string, unknown>[] };
      }
      stmt.run(...(bindings as never[]));
      return { toArray: () => [] as Record<string, unknown>[] };
    },
  };
}

function storeWithRepo(): RepoStore {
  const store = new RepoStore(sqliteSql());
  store.beginRepo('demo');
  store.writeFile('demo', 'src/app.ts', 'const port = 8080;\nconst host = "a";\n');
  store.writeFile('demo', 'README.md', '# demo\n');
  store.finalizeRepo('demo', {
    stored: 2, bytes: 10, skippedLarge: 0, skippedBinary: 0, skippedNoise: 0, truncated: false,
  });
  store.setOrigin('demo', { owner: 'acme', repo: 'demo', ref: 'main', sha: 'base-sha' });
  return store;
}

const call = (name: string, args: Record<string, unknown>) => ({
  id: 't1',
  name,
  arguments: JSON.stringify(args),
});

afterEach(() => vi.unstubAllGlobals());

describe('write_file / edit_file', () => {
  it('writes a new file, marks it dirty, and open_pr sees it', async () => {
    const store = storeWithRepo();
    const tools = createWriteToolExecutors({ store });
    const res = await tools.executeToolCall(
      call('write_file', { repo: 'demo', path: 'src/new.ts', content: 'export {};\n' }),
    );
    expect(res.content).toContain('Created src/new.ts');
    expect(store.readFile('demo', 'src/new.ts')).toBe('export {};\n');
    expect(store.dirtyFiles('demo').map((f) => f.path)).toEqual(['src/new.ts']);
  });

  it('checkout-written files are NOT dirty; agent edits are', async () => {
    const store = storeWithRepo();
    expect(store.dirtyFiles('demo')).toEqual([]);
    const tools = createWriteToolExecutors({ store });
    await tools.executeToolCall(
      call('edit_file', {
        repo: 'demo', path: 'src/app.ts',
        old_string: 'const port = 8080;', new_string: 'const port = 9090;',
      }),
    );
    expect(store.readFile('demo', 'src/app.ts')).toBe('const port = 9090;\nconst host = "a";\n');
    expect(store.dirtyFiles('demo').map((f) => f.path)).toEqual(['src/app.ts']);
  });

  it('edit_file demands existence and a unique match', async () => {
    const store = storeWithRepo();
    store.writeFile('demo', 'dup.ts', 'x\nx\n');
    const tools = createWriteToolExecutors({ store });
    const missing = await tools.executeToolCall(
      call('edit_file', { repo: 'demo', path: 'nope.ts', old_string: 'a', new_string: 'b' }),
    );
    expect(missing.content).toContain('does not exist');
    const notFound = await tools.executeToolCall(
      call('edit_file', { repo: 'demo', path: 'src/app.ts', old_string: 'const port = 1;', new_string: 'x' }),
    );
    expect(notFound.content).toContain('not found');
    const ambiguous = await tools.executeToolCall(
      call('edit_file', { repo: 'demo', path: 'dup.ts', old_string: 'x', new_string: 'y' }),
    );
    expect(ambiguous.content).toContain('2 times');
    // Nothing dirtied by the failed attempts.
    expect(store.dirtyFiles('demo')).toEqual([]);
  });

  it('rejects tools on a repo that is not checked out', async () => {
    const store = new RepoStore(sqliteSql());
    const tools = createWriteToolExecutors({ store });
    const res = await tools.executeToolCall(
      call('write_file', { repo: 'ghost', path: 'a.ts', content: 'x' }),
    );
    expect(res.content).toContain('not checked out');
  });
});

describe('open_pr', () => {
  it('pushes dirty files via tree→commit→ref→pull and reports the URL', async () => {
    const store = storeWithRepo();
    const tools = createWriteToolExecutors({ store, token: 'tok' });
    await tools.executeToolCall(
      call('write_file', { repo: 'demo', path: 'src/new.ts', content: 'export {};\n' }),
    );
    await tools.executeToolCall(
      call('edit_file', {
        repo: 'demo', path: 'src/app.ts',
        old_string: 'const port = 8080;', new_string: 'const port = 9090;',
      }),
    );

    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const respond = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200 });
      if (url.endsWith('/git/commits/base-sha')) return respond({ tree: { sha: 'base-tree' } });
      if (url.endsWith('/git/trees')) return respond({ sha: 'new-tree' });
      if (url.endsWith('/git/commits')) return respond({ sha: 'new-commit' });
      if (url.endsWith('/git/refs')) return respond({ ref: 'refs/heads/x' });
      if (url.endsWith('/pulls')) return respond({ html_url: 'https://github.com/acme/demo/pull/7' });
      return new Response('unexpected', { status: 500 });
    });

    const res = await tools.executeToolCall(
      call('open_pr', { repo: 'demo', title: 'Fix the port', body: 'why', branch: 'cell/fix-port' }),
    );
    expect(res.content).toContain('https://github.com/acme/demo/pull/7');
    expect(res.content).toContain('2 files');

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /repos/acme/demo/git/commits/base-sha',
      'POST /repos/acme/demo/git/trees',
      'POST /repos/acme/demo/git/commits',
      'POST /repos/acme/demo/git/refs',
      'POST /repos/acme/demo/pulls',
    ]);
    const tree = calls[1].body as { base_tree: string; tree: Array<{ path: string; content: string }> };
    expect(tree.base_tree).toBe('base-tree');
    expect(tree.tree.map((t) => t.path).sort()).toEqual(['src/app.ts', 'src/new.ts']);
    const commit = calls[2].body as { message: string; parents: string[] };
    expect(commit).toMatchObject({ message: 'Fix the port', parents: ['base-sha'], tree: 'new-tree' });
    expect(calls[3].body).toMatchObject({ ref: 'refs/heads/cell/fix-port', sha: 'new-commit' });
    expect(calls[4].body).toMatchObject({ title: 'Fix the port', head: 'cell/fix-port', base: 'main', body: 'why' });
  });

  it('explains instead of pushing when no token / no changes', async () => {
    const store = storeWithRepo();
    const noToken = createWriteToolExecutors({ store });
    const res1 = await noToken.executeToolCall(call('open_pr', { repo: 'demo', title: 't' }));
    expect(res1.content).toContain('No GitHub token');

    const withToken = createWriteToolExecutors({ store, token: 'tok' });
    const res2 = await withToken.executeToolCall(call('open_pr', { repo: 'demo', title: 't' }));
    expect(res2.content).toContain('nothing to push');
  });

  it('surfaces a GitHub failure as tool content, not a thrown error', async () => {
    const store = storeWithRepo();
    const tools = createWriteToolExecutors({ store, token: 'tok' });
    await tools.executeToolCall(call('write_file', { repo: 'demo', path: 'a.ts', content: 'x' }));
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 403 }));
    const res = await tools.executeToolCall(call('open_pr', { repo: 'demo', title: 't' }));
    expect(res.content).toContain('open_pr failed');
    expect(res.content).toContain('403');
  });
});
