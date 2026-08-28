/**
 * The interactive create body's payload-defined blob and LLM override.
 *
 * Both exist for the same reason: a create body's fields are dropped
 * TWICE on the way in. The coordinator persists only the keys it names
 * into `alert_json`, and the pump forwards only the keys it names to the
 * session DO. Either omission is silent — the field simply arrives as
 * undefined, the seed builds fine, and the payload's per-session config
 * is quietly the default forever.
 *
 * So the coordinator test asserts on **what the session DO stub
 * receives**, not on the created row: a row whose alert_json carries the
 * blob and a pump that forgets to forward it is exactly the bug, and it
 * passes any test that only reads the row back.
 *
 * The session-DO tests go the other way and read what the payload and
 * the model actually got, since "stored on the DO" is equally not the
 * point.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { makeCoordinatorDO } from '../coordinatorDO';
import { makeSessionDO } from '../sessionDO';
import type { CellPayload, InteractiveInput } from '../payload';
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

// ── the coordinator hop ────────────────────────────────────────────

/** A coordinator whose session-DO stub records every body it is sent. */
function coordinator() {
  const db = new DatabaseSync(':memory:');
  const kv = new Map<string, unknown>();
  /** Bodies the session DO stub received, parsed. */
  const dispatched: Array<Record<string, unknown>> = [];

  const payload = {
    parseTrigger: (raw: unknown) => raw as { id: string },
    triggerFacts: (t: { id: string }) => ({ dedupeKey: t.id, subjectId: t.id, groupKey: t.id }),
    interactiveGroupKey: () => 'interactive',
    ready: () => false,
    buildSeed: async () => ({ prompt: 'seed', seed: null }),
    buildInteractiveSeed: async () => ({ prompt: 'seed', seed: null }),
    createTools: () => ({
      definitions: [],
      executors: { executeToolCall: async () => ({ content: '' }) },
    }),
  } as unknown as CellPayload<{ id: string }, CellEnv>;

  const CoordinatorDO = makeCoordinatorDO(payload);
  const env = {
    INVESTIGATION: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async (_url: string, init?: RequestInit) => {
          dispatched.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
          return new Response('{}');
        },
      }),
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
  const inst = new (CoordinatorDO as any)({ storage } as any, env);

  return {
    dispatched,
    async create(body: unknown): Promise<void> {
      await inst.fetch(
        new Request('https://coordinator.internal/internal/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    },
  };
}

describe('interactive create: payload blob through the coordinator', () => {
  it('forwards the payload blob to the session DO verbatim', async () => {
    const c = coordinator();
    const blob = { profile: 'investigator', tools: ['run_search'], nested: { depth: 2 } };
    await c.create({ prompt: 'look into this', payload: blob });
    expect(c.dispatched).toHaveLength(1);
    expect(c.dispatched[0].payload).toEqual(blob);
  });

  it('forwards the llm override to the session DO', async () => {
    const c = coordinator();
    await c.create({ prompt: 'hi', llm: { model: 'cheap-model', maxTokens: 2048 } });
    expect(c.dispatched[0].llm).toEqual({ model: 'cheap-model', maxTokens: 2048 });
  });

  it('sends null, not undefined, when the caller supplies neither', async () => {
    // Explicit null distinguishes "the caller sent nothing" from "the
    // pump dropped it" when reading a stored body back later.
    const c = coordinator();
    await c.create({ prompt: 'hi' });
    expect(c.dispatched[0]).toHaveProperty('payload', null);
    expect(c.dispatched[0]).toHaveProperty('llm', null);
  });
});

// ── the session DO end ─────────────────────────────────────────────

function assistantReply(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 1, output: 1 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** A session DO that records the InteractiveInput its payload saw and
 *  the model descriptor each turn was run with. */
function session() {
  const db = new DatabaseSync(':memory:');
  const kv = new Map<string, unknown>();
  const seeded: InteractiveInput[] = [];
  const models: Array<{ id: string; maxTokens?: number }> = [];

  const payload = {
    triggerFacts: (t: { id: string }) => ({ dedupeKey: t.id, subjectId: t.id, groupKey: t.id }),
    parseTrigger: (raw: unknown) => raw as { id: string },
    ready: () => true,
    buildSeed: async () => ({ prompt: 'seed', seed: null }),
    buildInteractiveSeed: async (input: InteractiveInput) => {
      seeded.push(input);
      return { prompt: `seed: ${input.prompt}`, seed: null };
    },
    createTools: () => ({
      definitions: [],
      executors: { executeToolCall: async () => ({ name: 'x', content: '' }) },
    }),
    commit: async () => {},
  } as unknown as CellPayload<{ id: string }, CellEnv>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streamFn = ((model: any) => {
    models.push({ id: String(model?.id), maxTokens: model?.maxTokens as number });
    const msg = assistantReply('ok');
    return {
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'text_start', partial: msg };
        yield { type: 'text_delta', delta: 'ok', partial: msg };
        yield { type: 'text_end', partial: msg };
      },
      result: async () => msg,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const SessionDO = makeSessionDO(payload, { streamFn });
  const env = {
    COORDINATOR: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response('{}') }),
    },
    LLM_BASE_URL: 'http://unused',
    LLM_API_KEY: 'k',
    LLM_MODEL: 'env-model',
    LLM_MAX_TOKENS: '4096',
  } as unknown as CellEnv;

  const make = () => {
    const storage = {
      sql: makeSql(db),
      get: async (key: string): Promise<unknown> => kv.get(key),
      put: async (key: string, value: unknown): Promise<void> => void kv.set(key, value),
      delete: async (key: string): Promise<boolean> => kv.delete(key),
      setAlarm: async (): Promise<void> => {},
      deleteAlarm: async (): Promise<void> => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = { storage, acceptWebSocket: () => {}, getWebSockets: () => [] } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (SessionDO as any)(state, env);
  };

  return {
    seeded,
    models,
    /** Create + run the opening turn. */
    async open(body: Record<string, unknown>): Promise<void> {
      await make().fetch(
        new Request('https://cell.internal/investigations/s1/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 's1', prompt: 'hi', ...body }),
        }),
      );
      await make().alarm();
    },
    /** Corrupt the stored override the way a bad config would. */
    corruptOverride(): void {
      makeSql(db).exec(`UPDATE investigation SET llm_override = 'not json'`);
    },
    async runTurn(): Promise<void> {
      await make().fetch(
        new Request('https://cell.internal/investigations/s1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'again' }),
        }),
      );
      await make().alarm();
    },
    status: () =>
      String(makeSql(db).exec(`SELECT status FROM investigation LIMIT 1`).toArray()[0]?.status),
  };
}

describe('interactive create: the session DO end', () => {
  it('hands the payload blob to buildInteractiveSeed', async () => {
    const s = session();
    const blob = { profile: 'triage' };
    await s.open({ payload: blob });
    expect(s.seeded[0]?.payload).toEqual(blob);
  });

  it('passes null when no blob was sent', async () => {
    const s = session();
    await s.open({});
    expect(s.seeded[0]?.payload).toBeNull();
  });

  it('runs the turn with the overridden model and output budget', async () => {
    const s = session();
    await s.open({ llm: { model: 'profile-model', maxTokens: 1024 } });
    expect(s.models[0]).toEqual({ id: 'profile-model', maxTokens: 1024 });
  });

  it('falls back to the cell env when no override was sent', async () => {
    const s = session();
    await s.open({});
    expect(s.models[0]).toEqual({ id: 'env-model', maxTokens: 4096 });
  });

  it('keeps the override for later turns, not just the first', async () => {
    // The override lives on the row, so a follow-up message must still
    // see it — storing it only on the consumed-once interactivePayload
    // would give turn 1 the profile's model and turn 2 the cell's.
    const s = session();
    await s.open({ llm: { model: 'profile-model' } });
    await s.runTurn();
    expect(s.models.map((m) => m.id)).toEqual(['profile-model', 'profile-model']);
  });

  it('treats a malformed override as no override rather than failing the turn', async () => {
    const s = session();
    await s.open({});
    s.corruptOverride();
    await s.runTurn();
    expect(s.models.at(-1)?.id).toBe('env-model');
    expect(s.status()).toBe('idle');
  });
});
