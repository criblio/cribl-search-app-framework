/**
 * Session-id prefix.
 *
 * The harness minted `inv-` ids unconditionally, which reads as leaked
 * history in any payload that isn't APM. `sessionIdPrefix` lets a
 * payload choose; these tests pin both halves of that: the default is
 * unchanged (existing deployments must keep minting `inv-`), and an
 * override applies to BOTH id-minting paths — the interactive
 * `/internal/create` route and the autonomous trigger-admission path,
 * which are separate call sites and were separately hard-coded.
 *
 * The autonomous path is exercised through `/internal/fire` rather than
 * by calling admitTriggers directly: it's private, and the route is
 * what a webhook actually hits.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { makeCoordinatorDO } from '../coordinatorDO';
import type { CellPayload } from '../payload';
import type { CellEnv } from '../env';

/** node:sqlite behind the DO SQL surface the harness uses. */
function makeSql(db: DatabaseSync) {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      const isSelect = /^\s*(SELECT|WITH)/i.test(query);
      const rows = isSelect
        ? (stmt.all(...(bindings as never[])) as Record<string, unknown>[])
        : (stmt.run(...(bindings as never[])), [] as Record<string, unknown>[]);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length === 0) throw new Error('no rows');
          return rows[0];
        },
      };
    },
  };
}

function harness(sessionIdPrefix?: string) {
  const db = new DatabaseSync(':memory:');
  const kv = new Map<string, unknown>();

  const payload = {
    parseTrigger: (raw: unknown) => raw as { id: string },
    triggerFacts: (t: { id: string }) => ({
      dedupeKey: t.id,
      subjectId: t.id,
      groupKey: t.id,
    }),
    interactiveGroupKey: () => 'interactive',
    ready: () => false,
    buildSeed: async () => ({ prompt: 'seed' }),
    buildInteractiveSeed: async () => ({ prompt: 'seed' }),
    createTools: () => ({
      definitions: [],
      executors: { executeToolCall: async () => ({ content: '' }) },
    }),
    ...(sessionIdPrefix == null ? {} : { sessionIdPrefix }),
  } as unknown as CellPayload<{ id: string }, CellEnv>;

  const CoordinatorDO = makeCoordinatorDO(payload);

  // Every dispatch "succeeds" so rows advance out of 'queued' without a
  // real session DO. The ids under test are assigned before dispatch, so
  // nothing here influences them.
  const env = {
    INVESTIGATION: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response('{}') }),
    },
  } as unknown as CellEnv;

  const storage = {
    sql: makeSql(db),
    get: async (key: string): Promise<unknown> => kv.get(key),
    put: async (key: string, value: unknown): Promise<void> => void kv.set(key, value),
    getAlarm: async (): Promise<number | null> => null,
    setAlarm: async (): Promise<void> => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = { storage } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inst = new (CoordinatorDO as any)(state, env);

  return {
    async create(prompt: string): Promise<string> {
      const resp = await inst.fetch(
        new Request('https://coordinator.internal/internal/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt }),
        }),
      );
      return String(((await resp.json()) as { id: string }).id);
    },
    async fire(id: string): Promise<void> {
      await inst.fetch(
        new Request('https://coordinator.internal/internal/fire', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify([{ id }]),
        }),
      );
    },
    ids: (): string[] =>
      makeSql(db)
        .exec(`SELECT id FROM investigations ORDER BY created_at`)
        .toArray()
        .map((r) => String(r.id)),
  };
}

describe('session id prefix', () => {
  it('defaults to inv- so existing deployments keep their id shape', async () => {
    const h = harness();
    const id = await h.create('do a thing');
    expect(id).toMatch(/^inv-[0-9a-f-]{36}$/);
  });

  it('uses the payload prefix for interactive sessions', async () => {
    const h = harness('kidder-');
    const id = await h.create('build me an app');
    expect(id).toMatch(/^kidder-[0-9a-f-]{36}$/);
  });

  it('uses the payload prefix for trigger-admitted sessions too', async () => {
    // The second, independently hard-coded call site — a payload that
    // renamed its sessions would otherwise get mixed prefixes depending
    // on how the session started.
    const h = harness('kidder-');
    await h.fire('alert-1');
    expect(h.ids()).toEqual([expect.stringMatching(/^kidder-[0-9a-f-]{36}$/)]);
  });

  it('keeps ids unique across both paths', async () => {
    const h = harness('kidder-');
    const a = await h.create('one');
    const b = await h.create('two');
    await h.fire('alert-1');
    const all = h.ids();
    expect(all).toHaveLength(3);
    expect(new Set(all).size).toBe(3);
    expect(all).toContain(a);
    expect(all).toContain(b);
  });
});
