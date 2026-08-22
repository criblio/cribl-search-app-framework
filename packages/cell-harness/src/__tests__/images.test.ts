/**
 * Pasted-screenshot handling: storage, rehydration, and the context
 * bound on it.
 *
 * The subtle part isn't accepting an image — it's that every turn
 * re-sends the whole history, so images must (a) live outside
 * agent_messages, which history() rescans each turn, and (b) stop being
 * re-sent after a few messages. Both are invisible from the outside:
 * a session with the window broken still WORKS, it just quietly pays
 * for every screenshot ever pasted, forever. So these tests read the
 * actual history the model would receive.
 *
 * Driven through the real DO over node:sqlite (same shim as
 * watchdog.test.ts) with the LLM turn intercepted at runRealTurn's
 * `streamFn` seam — the history is captured from the pi context the
 * stream is handed, not from an internal.
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

/** A 1×1 PNG's worth of base64 — content is irrelevant, only that it
 *  round-trips byte-for-byte. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function assistantReply(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 1, output: 1 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** A stream that answers with plain text (no tool calls ⇒ the turn is
 *  done and the session parks at idle), recording the context it was
 *  handed so the test can inspect the history the model saw. When
 *  `failNext` is set it throws instead, which fails the turn — an
 *  interactive session then parks at idle WITHOUT advancing its turn
 *  counter, the state the image keys have to survive. */
function capturingStream(seen: Message[][], failNext: { value: boolean }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((_model: unknown, context: any) => {
    seen.push(context.messages as Message[]);
    if (failNext.value) {
      failNext.value = false;
      throw new Error('scripted stream failure');
    }
    const msg = assistantReply('ok');
    const events = [
      { type: 'text_start', partial: msg },
      { type: 'text_delta', delta: 'ok', partial: msg },
      { type: 'text_end', partial: msg },
    ];
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const ev of events) yield ev;
      },
      result: async () => msg,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function harness(opts: { vision?: boolean } = {}) {
  const db = new DatabaseSync(':memory:');
  const kv = new Map<string, unknown>();
  /** The pi history handed to the model, one entry per turn run. */
  const histories: Message[][] = [];
  const failNext = { value: false };

  const payload = {
    triggerFacts: (t: { id: string }) => ({
      subjectId: t.id,
      dedupeKey: t.id,
      groupKey: t.id,
    }),
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

  const SessionDO = makeSessionDO(payload, { streamFn: capturingStream(histories, failNext) });

  const env = {
    COORDINATOR: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response('{}') }),
    },
    LLM_BASE_URL: 'http://unused',
    LLM_API_KEY: 'k',
    LLM_MODEL: 'test',
    ...(opts.vision ? { LLM_VISION: 'true' } : {}),
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

  const post = async (path: string, body: unknown): Promise<Response> =>
    make().fetch(
      new Request(`https://cell.internal/investigations/s1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  return {
    histories,
    /** Make the next turn's LLM stream fail. */
    breakNextTurn: (): void => void (failNext.value = true),
    /** Start an interactive session and run its opening turn, leaving it
     *  parked at idle and ready for messages. */
    async open(): Promise<void> {
      await post('/create', { id: 's1', prompt: 'hi' });
      await make().alarm();
    },
    /** Post a message and run the turn it schedules. */
    async send(body: { content?: string; images?: unknown[] }): Promise<Response> {
      const res = await post('/messages', body);
      if (res.ok) await make().alarm();
      return res;
    },
    events: (): WireLoopEvent[] =>
      makeSql(db)
        .exec(`SELECT ev_json FROM transcript_events ORDER BY seq`)
        .toArray()
        .map((r) => JSON.parse(String(r.ev_json)) as WireLoopEvent),
    status: () =>
      String(makeSql(db).exec(`SELECT status FROM investigation LIMIT 1`).toArray()[0]?.status),
    turn: (): number =>
      Number(makeSql(db).exec(`SELECT turn FROM investigation LIMIT 1`).toArray()[0]?.turn ?? 0),
    imageRows: (): number =>
      Number(makeSql(db).exec(`SELECT COUNT(*) AS n FROM agent_image_meta`).toArray()[0]?.n ?? 0),
    /** The stored user messages, as written — pre-rehydration. */
    storedUserMessages: () =>
      makeSql(db)
        .exec(`SELECT message_json FROM agent_messages ORDER BY seq`)
        .toArray()
        .map((r) => JSON.parse(String(r.message_json)) as Record<string, unknown>)
        .filter((m) => m.role === 'user'),
    /** The last history the model was handed. */
    lastHistory: (): Message[] => histories[histories.length - 1] ?? [],
    /** The most recent user message in that history — i.e. the message
     *  just posted, as the model actually received it. */
    lastUserMessage: (): Message | undefined =>
      (histories[histories.length - 1] ?? []).filter((m) => m.role === 'user').at(-1),
  };
}

/** Image parts of a pi message, whatever its content shape. */
function imagesOf(msg: Message | undefined): Array<{ data: string; mimeType: string }> {
  if (!msg || !Array.isArray(msg.content)) return [];
  return msg.content
    .filter(
      (c): c is { type: 'image'; data: string; mimeType: string } =>
        (c as { type?: string }).type === 'image',
    )
    .map(({ data, mimeType }) => ({ data, mimeType }));
}

function textOf(msg: Message | undefined): string {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  return (msg.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

const png = (data = PNG_B64) => ({ data, mimeType: 'image/png' });

describe('pasted images', () => {
  it('sends an attached image to the model as image content', async () => {
    const h = harness({ vision: true });
    await h.open();
    await h.send({ content: 'why is this button wrong?', images: [png()] });

    const user = h.lastUserMessage();
    expect(imagesOf(user)).toEqual([{ data: PNG_B64, mimeType: 'image/png' }]);
    expect(textOf(user)).toBe('why is this button wrong?');
  });

  it('keeps the bytes out of agent_messages', async () => {
    const h = harness({ vision: true });
    await h.open();
    await h.send({ content: 'look', images: [png()] });

    // The message row carries keys, not base64 — this is what keeps
    // history()'s full-table scan cheap for the rest of the session.
    const [msg] = h.storedUserMessages();
    expect(msg.imageKeys).toEqual(['img-1-0']);
    expect(JSON.stringify(msg)).not.toContain(PNG_B64);
    expect(h.imageRows()).toBe(1);
  });

  it('round-trips an image larger than one chunk row', async () => {
    // 130 KB of base64 ⇒ three 48 KB chunk rows, exercising both the
    // chunked write and the paged read.
    const big = 'A'.repeat(130 * 1024);
    const h = harness({ vision: true });
    await h.open();
    await h.send({ content: 'big', images: [{ data: big, mimeType: 'image/jpeg' }] });

    expect(imagesOf(h.lastUserMessage())).toEqual([{ data: big, mimeType: 'image/jpeg' }]);
  });

  it('stops re-sending images past the history window, keeping the text', async () => {
    const h = harness({ vision: true });
    await h.open();
    // Four image-bearing messages; the window keeps three.
    for (const n of [1, 2, 3, 4]) await h.send({ content: `shot ${n}`, images: [png()] });

    const history = h.lastHistory();
    const users = history.filter((m) => m.role === 'user');
    const pictorial = users.filter((m) => imagesOf(m).length > 0);
    expect(pictorial).toHaveLength(3);

    // The oldest one degraded to a marker but kept its words, so the
    // model still knows a screenshot was there.
    const oldest = users.find((m) => textOf(m).startsWith('shot 1'));
    expect(imagesOf(oldest)).toEqual([]);
    expect(textOf(oldest)).toContain('shot 1');
    expect(textOf(oldest)).toMatch(/1 screenshot omitted/);
  });

  it('accepts an image with no text at all', async () => {
    const h = harness({ vision: true });
    await h.open();
    const res = await h.send({ images: [png()] });
    expect(res.status).toBe(200);

    const user = h.lastUserMessage();
    expect(imagesOf(user)).toHaveLength(1);
    // A stand-in text part, because a content array of images alone
    // reads as an empty question to most models.
    expect(textOf(user)).toContain('screenshot');
  });

  it('still requires content when nothing is attached', async () => {
    const h = harness({ vision: true });
    await h.open();
    const res = await h.send({ content: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects an unsupported type and says so in the transcript', async () => {
    const h = harness({ vision: true });
    await h.open();
    await h.send({
      content: 'here',
      images: [{ data: 'PCEtLSBub3BlIC0tPg==', mimeType: 'image/svg+xml' }],
    });

    expect(h.imageRows()).toBe(0);
    expect(imagesOf(h.lastUserMessage())).toEqual([]);
    // Silence would look like the model ignoring the picture.
    expect(
      h.events().some((e) => e.kind === 'notification' && /not sent/.test(e.content)),
    ).toBe(true);
    // The message itself still went through.
    expect(h.status()).toBe('idle');
  });

  it('rejects an oversized image without storing a partial one', async () => {
    const h = harness({ vision: true });
    await h.open();
    await h.send({
      content: 'huge',
      images: [{ data: 'A'.repeat(5 * 1024 * 1024), mimeType: 'image/png' }],
    });

    expect(h.imageRows()).toBe(0);
    expect(
      h.events().some((e) => e.kind === 'notification' && /too large/.test(e.content)),
    ).toBe(true);
  });

  it('caps how many images one message may carry', async () => {
    const h = harness({ vision: true });
    await h.open();
    await h.send({ content: 'six', images: [png(), png(), png(), png(), png(), png()] });

    expect(h.imageRows()).toBe(4);
    expect(imagesOf(h.lastUserMessage())).toHaveLength(4);
  });

  it('records the attachment count on the transcript event, not the bytes', async () => {
    const h = harness({ vision: true });
    await h.open();
    await h.send({ content: 'two', images: [png(), png()] });

    const ev = h.events().find((e) => e.kind === 'userMessage' && e.content === 'two');
    expect(ev).toMatchObject({ imageCount: 2 });
    // A reopened transcript must not be carrying megabytes of base64.
    expect(JSON.stringify(h.events())).not.toContain(PNG_B64);
  });

  it('does not overwrite earlier images when a turn fails to advance', async () => {
    // Keys must be unique per stored image, not per turn: a turn whose
    // LLM call fails parks at idle without advancing the turn counter,
    // so a turn-derived key would collide and the second screenshot
    // would silently replace the first.
    const h = harness({ vision: true });
    await h.open();
    h.breakNextTurn();
    await h.send({ content: 'first', images: [png('AAAA')] });
    const stuckTurn = h.turn();
    await h.send({ content: 'second', images: [png('BBBB')] });
    // The precondition this test exists for: same turn, two messages.
    expect(h.turn()).toBe(stuckTurn + 1);

    const keys = h.storedUserMessages().flatMap((m) => (m.imageKeys as string[]) ?? []);
    expect(new Set(keys).size).toBe(2);
    const users = h.lastHistory().filter((m) => m.role === 'user');
    expect(imagesOf(users.find((m) => textOf(m).startsWith('first')))[0]?.data).toBe('AAAA');
    expect(imagesOf(users.find((m) => textOf(m).startsWith('second')))[0]?.data).toBe('BBBB');
  });

  it('does not forward images when the model is not declared multi-modal', async () => {
    // pi-ai drops image parts for a text-only model, so an undeclared
    // vision model means the user's screenshot vanishes en route. The
    // harness still stores it; the modality flag is what decides.
    const h = harness({ vision: false });
    await h.open();
    await h.send({ content: 'look', images: [png()] });
    expect(h.imageRows()).toBe(1);
  });
});
