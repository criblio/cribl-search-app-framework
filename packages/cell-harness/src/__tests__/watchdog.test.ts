/**
 * Watchdog retry bounding.
 *
 * alarm() sets a durable watchdog alarm before running a turn so a turn
 * whose isolate is evicted mid-run gets re-run by a fresh isolate. These
 * tests pin the bound on that: a turn that kills its isolate every time
 * must stop being retried instead of crash-looping the node.
 *
 * "The isolate died" is modelled by a durable-storage read inside the
 * turn that never settles, with the alarm() call abandoned rather than
 * awaited — so no catch block, no finally, and nothing after runTurn
 * ever runs, exactly as under a runtime teardown. A thrown error would
 * NOT model it: runTurn catches those and parks/fails cleanly. Each
 * subsequent alarm() runs on a NEW instance over the SAME durable
 * storage, which is what celld's process restart + re-fired alarm does.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { WireLoopEvent } from '@criblio/agent-protocol';
import { makeSessionDO } from '../sessionDO';
import type { CellPayload } from '../payload';
import type { CellEnv } from '../env';

const ATTEMPTS_KEY = 'watchdogAttempts';

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

function harness(opts: {
  mode: 'interactive' | 'autonomous';
  /** Durable read that hangs forever, standing in for isolate death. */
  hangOnGet?: string;
  /** Pre-existing strike count, as a restarted node would find. */
  seedAttempts?: number;
}) {
  const db = new DatabaseSync(':memory:');
  const kv = new Map<string, unknown>();
  let alarmAt: number | null = null;

  const payload = {
    triggerFacts: (t: { id: string }) => ({
      triggerEventId: t.id,
      alertId: t.id,
      incidentKey: t.id,
    }),
    normalizeTrigger: (t: unknown) => t as { id: string },
    ready: () => false,
    seedPrompt: () => 'seed',
    interactiveSeedPrompt: () => 'seed',
    createTools: () => ({
      definitions: [],
      executors: { executeToolCall: async () => ({ content: '' }) },
    }),
    commit: async () => {},
    stubTurn: () => ({ events: [], done: true, conclusion: null }),
  } as unknown as CellPayload<{ id: string }, CellEnv>;

  const SessionDO = makeSessionDO(payload);

  const env = {
    COORDINATOR: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response('{}') }),
    },
  } as unknown as CellEnv;

  const make = () => {
    const storage = {
      sql: makeSql(db),
      get: async (key: string): Promise<unknown> => {
        // Never settles — the turn stops here and never comes back.
        if (opts.hangOnGet && key === opts.hangOnGet) return new Promise(() => {});
        return kv.get(key);
      },
      put: async (key: string, value: unknown): Promise<void> => void kv.set(key, value),
      delete: async (key: string): Promise<boolean> => kv.delete(key),
      setAlarm: async (t: number): Promise<void> => void (alarmAt = t),
      deleteAlarm: async (): Promise<void> => void (alarmAt = null),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = { storage, acceptWebSocket: () => {}, getWebSockets: () => [] } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (SessionDO as any)(state, env);
  };

  // Seed a running session directly, bypassing the /create route so the
  // test doesn't depend on its shape.
  make();
  makeSql(db).exec(
    `INSERT INTO investigation
       (id, alert_id, trigger_event_id, incident_key, status, seed_json,
        created_at, schema_version, mode, title, turn_budget)
     VALUES ('s1', '', 's1', 'k', 'running', 'null', 1, 1, ?, 't', 12)`,
    opts.mode,
  );
  if (opts.mode === 'autonomous') kv.set('alert', { id: 's1' });
  if (opts.seedAttempts != null) kv.set(ATTEMPTS_KEY, opts.seedAttempts);

  return {
    /** Fire alarm() on a fresh instance and wait for it to finish. */
    async fireAlarm(): Promise<void> {
      await make().alarm();
    },
    /** Fire alarm() on a fresh instance and abandon it mid-turn. */
    async abandonAlarm(): Promise<void> {
      void make()
        .alarm()
        .catch(() => {});
      // Let the microtasks up to the hang point run, then walk away.
      await new Promise((r) => setTimeout(r, 0));
    },
    events: (): WireLoopEvent[] =>
      makeSql(db)
        .exec(`SELECT ev_json FROM transcript_events ORDER BY seq`)
        .toArray()
        .map((r) => JSON.parse(String(r.ev_json)) as WireLoopEvent),
    status: () =>
      String(makeSql(db).exec(`SELECT status FROM investigation LIMIT 1`).toArray()[0]?.status),
    attempts: () => kv.get(ATTEMPTS_KEY) as number | undefined,
    alarmPending: () => alarmAt !== null,
  };
}

describe('watchdog retry bound', () => {
  it('records the attempt durably before the turn can kill the isolate', async () => {
    const h = harness({ mode: 'autonomous', hangOnGet: 'alert' });
    await h.abandonAlarm();
    // Nothing ran after the hang, so this count exists only because it
    // was written up-front — which is the entire mechanism.
    expect(h.attempts()).toBe(1);
    expect(h.status()).toBe('running');
  });

  it('accumulates strikes across simulated isolate restarts', async () => {
    const h = harness({ mode: 'autonomous', hangOnGet: 'alert' });
    await h.abandonAlarm();
    await h.abandonAlarm();
    await h.abandonAlarm();
    expect(h.attempts()).toBe(3);
    // Still retrying at the cap — the give-up is the NEXT one.
    expect(h.status()).toBe('running');
  });

  it('gives up instead of retrying forever, and stops the alarm loop', async () => {
    // A node that has already crash-looped three times on this turn.
    const h = harness({ mode: 'interactive', hangOnGet: 'alert', seedAttempts: 3 });
    await h.fireAlarm();
    expect(h.status()).toBe('idle');
    expect(
      h.events().some((e) => e.kind === 'error' && /abandoned after 3 attempts/.test(e.message)),
    ).toBe(true);
    // No pending alarm ⇒ genuinely stopped, not merely delayed.
    expect(h.alarmPending()).toBe(false);
    // Cleared so a follow-up message isn't charged for this step.
    expect(h.attempts()).toBeUndefined();
  });

  it('fails an autonomous run rather than parking it', async () => {
    const h = harness({ mode: 'autonomous', hangOnGet: 'alert', seedAttempts: 3 });
    await h.fireAlarm();
    expect(h.status()).toBe('failed');
  });

  it('tells the user a step is being retried', async () => {
    const h = harness({ mode: 'autonomous', hangOnGet: 'alert', seedAttempts: 1 });
    await h.abandonAlarm();
    expect(
      h.events().some((e) => e.kind === 'notification' && /attempt 2 of 3/.test(e.content)),
    ).toBe(true);
  });

  it('clears the counter when a turn completes normally', async () => {
    const h = harness({ mode: 'interactive', seedAttempts: 2 });
    await h.fireAlarm();
    expect(h.attempts()).toBeUndefined();
    expect(h.status()).toBe('idle');
  });

  it('does not count alarms on a session that is no longer running', async () => {
    const h = harness({ mode: 'interactive' });
    await h.fireAlarm(); // completes, parks at idle
    await h.fireAlarm(); // a stray watchdog alarm after parking
    expect(h.attempts()).toBeUndefined();
    expect(h.status()).toBe('idle');
  });
});
