/**
 * Context management, driven through the real session DO.
 *
 * Two failures are under test here and both are silent by nature, so
 * the assertions are about what the SESSION did, not about wording:
 *
 *  1. A model turn that comes back empty used to be indistinguishable
 *     from "the model is finished" — `done` is computed from "no tool
 *     calls" — so the session appended `done`, parked at `idle`, and
 *     reported success. Found in production 2026-08-24 on a ~217k-token
 *     session; three consecutive turns answered nothing, including a
 *     bare "Are you there?". Nothing in the UI distinguished it from a
 *     hung network. The test for it asserts the session does NOT end at
 *     idle claiming success.
 *
 *  2. Nothing bounded the history. Compaction is invisible when it
 *     works, so these read the actual pi history the model is handed
 *     (captured at the `streamFn` seam) rather than any internal.
 *
 * Same node:sqlite + real-DO shim as watchdog.test.ts and images.test.ts.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { WireLoopEvent } from '@criblio/agent-protocol';
import { makeSessionDO } from '../sessionDO';
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

/** What a scripted turn hands back. */
type Reply =
  | { kind: 'text'; text: string }
  /** No text, no tool calls — the production symptom. */
  | { kind: 'empty' }
  /** The same, with the provider reporting it burned the output budget. */
  | { kind: 'truncated-empty' }
  /** Cut off mid-answer: real text, `finish_reason: length`. */
  | { kind: 'truncated-text'; text: string };

function replyMessage(r: Reply): AssistantMessage {
  const base = {
    role: 'assistant',
    usage: { input: 1, output: 1 },
    provider: 'test',
    model: 'test',
    api: 'openai-completions',
    timestamp: 1,
  } as unknown as AssistantMessage;
  switch (r.kind) {
    case 'text':
      return { ...base, content: [{ type: 'text', text: r.text }], stopReason: 'stop' };
    case 'empty':
      return { ...base, content: [], stopReason: 'stop' };
    case 'truncated-empty':
      return { ...base, content: [], stopReason: 'length' };
    case 'truncated-text':
      return { ...base, content: [{ type: 'text', text: r.text }], stopReason: 'length' };
  }
}

interface HarnessOpts {
  /** Replies for successive model turns; the last one repeats. */
  script?: Reply[];
  /** What the summarizer call does. */
  summarizer?: 'ok' | 'fail';
  env?: Record<string, string>;
}

function harness(opts: HarnessOpts = {}) {
  const db = new DatabaseSync(':memory:');
  const kv = new Map<string, unknown>();
  const script = opts.script ?? [{ kind: 'text', text: 'ok' }];
  /** The pi history handed to the model, one entry per model turn. */
  const histories: Message[][] = [];
  /** Prompts the summarizer was given, one per compaction. */
  const summarizerPrompts: string[] = [];
  let turnCalls = 0;

  // One seam serves both the turn loop and the summarizer. They're told
  // apart by the system prompt: a turn runs with '' (the seed prompt is
  // history[0], parity with the browser loop), the summarizer has one.
  const streamFn = ((
    _model: unknown,
    ctx: { systemPrompt?: string; messages: Message[] },
  ) => {
    if (ctx.systemPrompt) {
      summarizerPrompts.push(ctx.messages[0].content as string);
      if (opts.summarizer === 'fail') throw new Error('summarizer unavailable');
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => ({
          role: 'assistant',
          content: [{ type: 'text', text: 'SUMMARY OF EARLIER WORK' }],
          stopReason: 'stop',
        }),
      };
    }
    histories.push(ctx.messages);
    const r = script[Math.min(turnCalls, script.length - 1)];
    turnCalls++;
    const msg = replyMessage(r);
    const text = 'text' in r ? r.text : '';
    // `start` first, and not optional: pi-agent-core forwards a
    // text_delta only once it has a partial message to attach it to, so
    // a stub that skips `start` emits no assistant text at all — which
    // looks exactly like the bug this file is about.
    const events = text
      ? [
          { type: 'start', partial: msg },
          { type: 'text_start', partial: msg },
          { type: 'text_delta', delta: text, partial: msg },
          { type: 'text_end', partial: msg },
        ]
      : [];
    return {
      async *[Symbol.asyncIterator]() {
        for (const ev of events) yield ev;
      },
      result: async () => msg,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const payload = {
    triggerFacts: (t: { id: string }) => ({ subjectId: t.id, dedupeKey: t.id, groupKey: t.id }),
    normalizeTrigger: (t: unknown) => t as { id: string },
    ready: () => true,
    buildSeed: async () => ({ prompt: 'seed', seed: null }),
    buildInteractiveSeed: async (input: { prompt: string }) => ({
      prompt: `seed: ${input.prompt}`,
      seed: null,
    }),
    createTools: () => ({
      definitions: [],
      executors: { executeToolCall: async () => ({ name: 'x', content: '' }) },
    }),
    commit: async () => {},
  } as unknown as CellPayload<{ id: string }, CellEnv>;

  const SessionDO = makeSessionDO(payload, { streamFn });

  const env = {
    COORDINATOR: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response('{}') }),
    },
    LLM_BASE_URL: 'http://unused',
    LLM_API_KEY: 'k',
    LLM_MODEL: 'test',
    ...(opts.env ?? {}),
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

  const request = (path: string, body?: unknown): Request =>
    new Request(`https://cell.internal/investigations/s1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });

  return {
    histories,
    summarizerPrompts,
    turnCalls: () => turnCalls,
    /** Start an interactive session, leaving it parked at idle. */
    async open(): Promise<void> {
      await make().fetch(request('/create', { id: 's1', prompt: 'hi' }));
      await make().alarm();
    },
    /** Post a message; does NOT run the alarm. */
    post: async (content: string): Promise<Response> =>
      make().fetch(request('/messages', { content })),
    /** Fire one alarm — one turn, or one compaction step. */
    tick: async (): Promise<void> => void (await make().alarm()),
    status: async (): Promise<Record<string, unknown>> =>
      (await (await make().fetch(request('/status'))).json()) as Record<string, unknown>,
    /** Append raw pi messages to the stored history, standing in for a
     *  long session without running hundreds of turns. */
    seedMessages(messages: Message[]): void {
      const sql = makeSql(db);
      for (const m of messages) {
        sql.exec(`INSERT INTO agent_messages (message_json) VALUES (?)`, JSON.stringify(m));
      }
    },
    storedMessages: (): Message[] =>
      makeSql(db)
        .exec(`SELECT message_json FROM agent_messages ORDER BY seq`)
        .toArray()
        .map((r) => JSON.parse(String(r.message_json)) as Message),
    events: (): WireLoopEvent[] =>
      makeSql(db)
        .exec(`SELECT ev_json FROM transcript_events ORDER BY seq`)
        .toArray()
        .map((r) => JSON.parse(String(r.ev_json)) as WireLoopEvent),
    dbStatus: () =>
      String(makeSql(db).exec(`SELECT status FROM investigation LIMIT 1`).toArray()[0]?.status),
    turn: (): number =>
      Number(makeSql(db).exec(`SELECT turn FROM investigation LIMIT 1`).toArray()[0]?.turn ?? 0),
    summary: () => kv.get('contextSummary') as { text: string; rounds: number } | undefined,
    lastHistory: (): Message[] => histories[histories.length - 1] ?? [],
  };
}

const textOf = (m: Message | undefined): string => {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return (m.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
};

/** ~1,000 tokens of assistant chatter plus its tool result. */
function bulkTurn(i: number): Message[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `step ${i}` },
        { type: 'toolCall', id: `tc${i}`, name: 'read_file', arguments: { path: `f${i}.ts` } },
      ],
      stopReason: 'toolUse',
      usage: { input: 1, output: 1 },
      timestamp: 1,
    } as AssistantMessage,
    {
      role: 'toolResult',
      toolCallId: `tc${i}`,
      toolName: 'read_file',
      content: [{ type: 'text', text: `contents of f${i}.ts ${'x'.repeat(4_000)}` }],
      isError: false,
      timestamp: 1,
    } as Message,
  ];
}

describe('an unusable model reply', () => {
  it('does not park at idle reporting success', async () => {
    // The whole defect in one assertion. Before the fix this session
    // ended at idle with an assistantDone + done and no error frame:
    // healthy status, empty transcript entry, nothing to look at.
    const h = harness({ script: [{ kind: 'text', text: 'hello' }, { kind: 'empty' }] });
    await h.open();
    await h.post('are you there?');
    await h.tick(); // empty reply → retry scheduled
    await h.tick(); // still empty → give up, loudly

    const kinds = h.events().map((e) => e.kind);
    expect(kinds).toContain('error');
    // Not "the model finished": no assistantDone for the empty turns.
    const afterUser = h.events().slice(kinds.indexOf('userMessage'));
    expect(afterUser.some((e) => e.kind === 'assistantDone')).toBe(false);
  });

  it('retries exactly once', async () => {
    const h = harness({ script: [{ kind: 'text', text: 'hi' }, { kind: 'empty' }] });
    await h.open();
    const before = h.turnCalls();
    await h.post('go');
    await h.tick();
    await h.tick();
    await h.tick(); // a stray alarm must not start a third attempt
    expect(h.turnCalls() - before).toBe(2);
  });

  it('does not persist the empty message into the model history', async () => {
    // Persisting it replays an empty turn for the rest of the session
    // AND leaves the stored history ending on an assistant message,
    // which is not a turn boundary Agent.continue() accepts.
    const h = harness({ script: [{ kind: 'text', text: 'hi' }, { kind: 'empty' }] });
    await h.open();
    await h.post('go');
    await h.tick();
    const stored = h.storedMessages();
    expect(stored[stored.length - 1].role).not.toBe('assistant');
    // The retry therefore sees the same history the failed turn saw.
    expect(textOf(h.lastHistory().at(-1))).toBe('go');
  });

  it('does not spend the user step budget on a turn that produced nothing', async () => {
    const h = harness({ script: [{ kind: 'text', text: 'hi' }, { kind: 'empty' }] });
    await h.open();
    await h.post('go');
    const before = h.turn();
    await h.tick();
    expect(h.turn()).toBe(before);
  });

  it('recovers silently when the retry answers', async () => {
    const h = harness({
      script: [{ kind: 'text', text: 'hi' }, { kind: 'empty' }, { kind: 'text', text: 'yes' }],
    });
    await h.open();
    await h.post('are you there?');
    await h.tick();
    await h.tick();

    expect(h.dbStatus()).toBe('idle');
    expect(h.events().some((e) => e.kind === 'error')).toBe(false);
    expect(
      h.events().some((e) => e.kind === 'assistantText' && e.chunk === 'yes'),
    ).toBe(true);
  });

  it('names the conversation size when it finally gives up', async () => {
    // "It stopped responding" is the report this arrived as. How big
    // the conversation is is the first question anyone asks next.
    const h = harness({ script: [{ kind: 'text', text: 'hi' }, { kind: 'empty' }] });
    await h.open();
    await h.post('go');
    await h.tick();
    await h.tick();
    const err = h.events().find((e) => e.kind === 'error');
    expect(err && 'message' in err ? err.message : '').toMatch(/tokens/);
  });

  it('treats a burned output budget as a failure, not an answer', async () => {
    const h = harness({ script: [{ kind: 'text', text: 'hi' }, { kind: 'truncated-empty' }] });
    await h.open();
    await h.post('write me a long thing');
    await h.tick();
    await h.tick();
    const err = h.events().find((e) => e.kind === 'error');
    expect(err && 'message' in err ? err.message : '').toMatch(/output budget|length/i);
  });

  it('keeps a cut-off ANSWER and says it was cut off', async () => {
    // A truncated reply that produced real text is a worse answer, not
    // no answer. Failing it would break every long generation.
    const h = harness({
      script: [{ kind: 'text', text: 'hi' }, { kind: 'truncated-text', text: 'chapter one…' }],
    });
    await h.open();
    await h.post('write me a long thing');
    await h.tick();

    expect(h.dbStatus()).toBe('idle');
    expect(h.events().some((e) => e.kind === 'error')).toBe(false);
    expect(h.events().some((e) => e.kind === 'assistantText' && e.chunk === 'chapter one…')).toBe(
      true,
    );
    expect(
      h.events().some((e) => e.kind === 'notification' && /cut off/i.test(e.content)),
    ).toBe(true);
  });
});

/** A window small enough that a few seeded turns cross it. */
const SMALL_WINDOW = {
  LLM_CONTEXT_WINDOW: '20000',
  // Isolate tier 2: without this the tool-result budget would shrink
  // the seeded history on its own and the trigger would never fire.
  CONTEXT_TOOL_RESULT_BUDGET: '10000000',
};

describe('compaction', () => {
  async function grown(opts: HarnessOpts = {}) {
    const h = harness({ env: SMALL_WINDOW, ...opts });
    await h.open();
    h.seedMessages(Array.from({ length: 14 }, (_, i) => bulkTurn(i)).flat());
    return h;
  }

  it('runs as its own step and shrinks what the next turn is handed', async () => {
    const h = await grown();
    await h.post('carry on');
    // What the model WOULD have been handed: seed + every stored row.
    const uncompacted = h.storedMessages().length + 1;

    await h.tick(); // compaction step — no model turn
    expect(h.summary()?.rounds).toBe(1);
    await h.tick(); // the turn that benefits

    const after = h.lastHistory();
    expect(after.length).toBeLessThan(uncompacted);
    // history[0] is still the seed prompt; the summary sits right after.
    expect(textOf(after[1])).toContain('SUMMARY OF EARLIER WORK');
    expect(textOf(after[1])).toMatch(/compacted/i);
  });

  it('never hands the model an unpaired tool result', async () => {
    // The cut walking into the middle of a tool exchange is a hard API
    // error on most providers, not a degraded answer.
    const h = await grown();
    await h.post('carry on');
    await h.tick();
    await h.tick();

    const live = h.lastHistory().slice(2); // past seed + summary
    const seen = new Set<string>();
    for (const m of live) {
      if (m.role === 'assistant') {
        for (const c of (m as AssistantMessage).content) {
          if (c.type === 'toolCall') seen.add(c.id);
        }
      }
      if (m.role === 'toolResult') expect(seen.has(m.toolCallId)).toBe(true);
    }
  });

  it("keeps the user's own words verbatim", async () => {
    const h = harness({ env: SMALL_WINDOW });
    await h.open();
    await h.post('use blue, not green');
    await h.tick();
    h.seedMessages(Array.from({ length: 14 }, (_, i) => bulkTurn(i)).flat());
    await h.post('carry on');
    await h.tick();
    await h.tick();

    expect(textOf(h.lastHistory()[1])).toContain('use blue, not green');
  });

  it('leaves the user-facing transcript untouched', async () => {
    // The transcript is the user's record; compaction is a model-history
    // concern only. A compacted session must still replay in full.
    const h = await grown();
    await h.post('carry on');
    const before = h.events().length;
    await h.tick();
    const after = h.events();
    expect(after.length).toBeGreaterThan(before);
    expect(after.slice(0, before)).toEqual(h.events().slice(0, before));
    // ...and it says out loud that it happened.
    expect(
      after.some((e) => e.kind === 'notification' && /compacted/i.test(e.content)),
    ).toBe(true);
  });

  it('keeps the compacted rows in the table', async () => {
    const h = await grown();
    const before = h.storedMessages().length;
    await h.post('carry on');
    await h.tick();
    expect(h.storedMessages().length).toBeGreaterThanOrEqual(before);
  });

  it('compacts anyway when the summarizer fails', async () => {
    // A summarizer outage must not be able to park a session that has
    // outgrown its window — that turns a cost problem into an
    // availability one.
    const h = await grown({ summarizer: 'fail' });
    await h.post('carry on');
    await h.tick();
    await h.tick();

    expect(h.summary()?.rounds).toBe(1);
    expect(h.dbStatus()).toBe('idle');
    expect(textOf(h.lastHistory()[1])).toMatch(/mechanical/i);
  });

  it('does not compact a session that has not grown', async () => {
    const h = harness({ env: SMALL_WINDOW });
    await h.open();
    await h.post('hi');
    await h.tick();
    expect(h.summary()).toBeUndefined();
    expect(h.dbStatus()).toBe('idle');
  });

  it('can be turned off without a redeploy', async () => {
    const h = await grown({ env: { ...SMALL_WINDOW, CONTEXT_COMPACTION: 'off' } });
    await h.post('carry on');
    await h.tick();
    expect(h.summary()).toBeUndefined();
    expect(h.dbStatus()).toBe('idle');
  });

  it('terminates instead of compacting on every turn', async () => {
    const h = await grown();
    await h.post('carry on');
    await h.tick(); // compaction
    await h.tick(); // turn
    const rounds = h.summary()?.rounds;
    await h.post('again');
    await h.tick(); // must be a turn, not another compaction
    expect(h.summary()?.rounds).toBe(rounds);
  });

  it('folds an earlier summary in rather than stacking summaries', async () => {
    const h = await grown();
    await h.post('carry on');
    await h.tick();
    await h.tick();
    h.seedMessages(Array.from({ length: 14 }, (_, i) => bulkTurn(100 + i)).flat());
    await h.post('and again');
    await h.tick();

    expect(h.summary()?.rounds).toBe(2);
    expect(h.summarizerPrompts[1]).toContain('SUMMARY OF EARLIER WORK');
  });

  it('compacts before retrying an unusable reply, not after', async () => {
    // When the cause IS the context, an immediate retry on the same
    // history is a second expensive way to fail.
    const h = await grown({
      script: [{ kind: 'text', text: 'hi' }, { kind: 'empty' }, { kind: 'text', text: 'better' }],
      env: { ...SMALL_WINDOW, CONTEXT_COMPACT_AT: '10000000' },
    });
    await h.post('go');
    await h.tick(); // turn → empty; forced compaction + retry scheduled
    expect(h.summary()?.rounds).toBe(1);
    await h.tick(); // the retry, on the smaller history
    expect(h.dbStatus()).toBe('idle');
    expect(h.events().some((e) => e.kind === 'error')).toBe(false);
  });
});

describe('reporting the size', () => {
  it('is on /status without rescanning the message table', async () => {
    const h = harness({ env: SMALL_WINDOW });
    await h.open();
    const s = await h.status();
    expect(typeof s.contextTokens).toBe('number');
    expect(s.contextWindow).toBe(20_000);
    expect(s.compactions).toBe(0);
  });

  it('counts compactions', async () => {
    const h = harness({ env: SMALL_WINDOW });
    await h.open();
    h.seedMessages(Array.from({ length: 14 }, (_, i) => bulkTurn(i)).flat());
    await h.post('carry on');
    await h.tick();
    expect((await h.status()).compactions).toBe(1);
  });
});
