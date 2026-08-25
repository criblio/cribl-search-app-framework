/**
 * The context policy, tested as pure functions.
 *
 * These assert the properties that are invisible from the outside. A
 * session with any of them broken still WORKS — it just costs more, or
 * lies to the model, or (in one case) sends the provider a request it
 * rejects outright. So the tests are written against the specific
 * failure each rule exists to prevent, not against the shape of the
 * output.
 */
import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message, Model, ToolResultMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  DEFAULT_CONTEXT_WINDOW,
  SUMMARY_RESERVE_TOKENS,
  boundToolResults,
  estimateTokens,
  foldSummary,
  mechanicalSummary,
  planCompaction,
  renderSpan,
  resolveContextConfig,
  summarizeSpan,
  summaryMessage,
  userQuotesOf,
  type ContextConfig,
} from '../compaction';

const cfg = (over: Partial<ContextConfig> = {}): ContextConfig => ({
  ...resolveContextConfig({}),
  ...over,
});

function user(content: string): Message {
  return { role: 'user', content, timestamp: 1 };
}

function assistant(text: string, calls: Array<{ id: string; name: string }> = []): Message {
  return {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...calls.map((c) => ({
        type: 'toolCall' as const,
        id: c.id,
        name: c.name,
        arguments: { path: 'x' },
      })),
    ],
    stopReason: calls.length ? 'toolUse' : 'stop',
    usage: { input: 1, output: 1 },
    timestamp: 1,
  } as AssistantMessage;
}

function toolResult(id: string, name: string, text: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 1,
  } as ToolResultMessage;
}

const bodyOf = (m: Message): string =>
  (m.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');

describe('token estimation', () => {
  it('does not price an image by the length of its base64', () => {
    // A 2 MB screenshot is ~2.8M base64 chars. Charged at 4 chars per
    // token that reads as 700k tokens, and a session with one pasted
    // picture and no text would compact itself forever.
    const big = 'A'.repeat(2_800_000);
    const withImage: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', data: big, mimeType: 'image/png' },
      ],
      timestamp: 1,
    };
    expect(estimateTokens([withImage])).toBeLessThan(5_000);
  });

  it('scales with text length', () => {
    const small = estimateTokens([user('x'.repeat(400))]);
    const large = estimateTokens([user('x'.repeat(4_000))]);
    expect(large).toBeGreaterThan(small * 8);
  });
});

describe('config', () => {
  it('derives every threshold from the declared window', () => {
    // The point of this: raising the window for a bigger model raises
    // the compaction point with it, so "use the 1M context" is a config
    // change and not a code change.
    const wide = resolveContextConfig({ LLM_CONTEXT_WINDOW: '1000000' });
    const narrow = resolveContextConfig({});
    expect(narrow.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(wide.compactAtTokens).toBeGreaterThan(narrow.compactAtTokens * 4);
    expect(wide.compactTargetTokens).toBeGreaterThan(narrow.compactTargetTokens * 4);
    expect(wide.toolResultBudgetChars).toBeGreaterThan(narrow.toolResultBudgetChars * 4);
  });

  it('never targets more than it triggers at', () => {
    const c = resolveContextConfig({ CONTEXT_COMPACT_AT: '1000', CONTEXT_COMPACT_TARGET: '9000' });
    expect(c.compactTargetTokens).toBeLessThanOrEqual(c.compactAtTokens);
  });

  it('can turn summarizing compaction off without touching tool bounding', () => {
    expect(resolveContextConfig({ CONTEXT_COMPACTION: 'off' }).enabled).toBe(false);
    expect(resolveContextConfig({}).enabled).toBe(true);
  });
});

describe('tool-result bounding', () => {
  const big = (n: number) => 'R'.repeat(n);

  it('keeps the pairing intact when it elides', () => {
    // Dropping the message instead of shrinking it would orphan its
    // assistant tool call, which most providers reject outright — a
    // failed request, not a degraded answer.
    const msgs = [
      user('go'),
      ...Array.from({ length: 8 }, (_, i) => [
        assistant('', [{ id: `t${i}`, name: 'read_file' }]),
        toolResult(`t${i}`, 'read_file', big(20_000)),
      ]).flat(),
    ];
    const out = boundToolResults(msgs, cfg({ toolResultBudgetChars: 1_000, toolResultMinKeep: 1 }));
    expect(out).toHaveLength(msgs.length);
    expect(out.map((m) => m.role)).toEqual(msgs.map((m) => m.role));
    expect(out.filter((m) => m.role === 'toolResult').map((m) => (m as ToolResultMessage).toolCallId))
      .toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
  });

  it('elides the oldest and keeps the newest', () => {
    const msgs = Array.from({ length: 6 }, (_, i) =>
      toolResult(`t${i}`, 'read_file', `${i}-${big(20_000)}`),
    );
    const out = boundToolResults(msgs, cfg({ toolResultBudgetChars: 1_000, toolResultMinKeep: 2 }));
    expect(bodyOf(out[5])).toContain('5-');
    expect(bodyOf(out[4])).toContain('4-');
    expect(bodyOf(out[0])).not.toContain('0-');
    expect(bodyOf(out[0])).toMatch(/elided/);
  });

  it('says which tool and how much, so the model can ask again', () => {
    const msgs = [toolResult('t0', 'run_search', big(50_000)), toolResult('t1', 'x', 'ok')];
    const out = boundToolResults(msgs, cfg({ toolResultBudgetChars: 0, toolResultMinKeep: 0 }));
    expect(bodyOf(out[0])).toContain('run_search');
    expect(bodyOf(out[0])).toContain('50000');
  });

  it('leaves small results alone whatever the budget', () => {
    // The marker would cost about as much, and short results are
    // disproportionately the ones carrying the answer.
    const msgs = [toolResult('t0', 'bash', 'exit 0'), toolResult('t1', 'bash', 'exit 0')];
    const out = boundToolResults(msgs, cfg({ toolResultBudgetChars: 0, toolResultMinKeep: 0 }));
    expect(out).toBe(msgs);
  });

  it('is a pure function of the stored rows', () => {
    // Nothing is persisted, so widening the budget later brings the
    // full results straight back. This is what makes tier 1 safe to be
    // aggressive about.
    const msgs = [toolResult('t0', 'read_file', big(50_000)), toolResult('t1', 'x', 'ok')];
    const tight = boundToolResults(msgs, cfg({ toolResultBudgetChars: 0, toolResultMinKeep: 0 }));
    const loose = boundToolResults(msgs, cfg({ toolResultBudgetChars: 1_000_000 }));
    expect(bodyOf(tight[0])).toMatch(/elided/);
    expect(bodyOf(loose[0])).toHaveLength(50_000);
  });
});

describe('compaction planning', () => {
  /** ~250 tokens each. */
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => assistant(`step ${i} ${'w'.repeat(1_000)}`));

  it('does nothing below the trigger', () => {
    expect(
      planCompaction({ live: filler(2), fixedTokens: 0, cfg: cfg({ compactAtTokens: 100_000 }) }),
    ).toBeNull();
  });

  it('never leaves a tool result as the first kept message, wherever the cut lands', () => {
    // An unpaired tool result is a hard API error on most providers —
    // a failed request, not a degraded answer. The cut has to walk PAST
    // them rather than stopping wherever the token arithmetic happened
    // to land, and "happened to land" is the point: a single fixture
    // only ever exercises one landing spot, and this guard survived a
    // mutation test until this became a sweep.
    const live: Message[] = [];
    for (let i = 0; i < 60; i++) {
      live.push(assistant(`step ${i}`, [{ id: `tc${i}`, name: 'read_file' }]));
      // Varying sizes so consecutive targets land at different indices.
      live.push(toolResult(`tc${i}`, 'read_file', 'r'.repeat(200 + ((i * 137) % 3_000))));
    }
    live.push(user('carry on'));

    let plans = 0;
    for (let target = 200; target <= 12_000; target += 37) {
      const plan = planCompaction({
        live,
        fixedTokens: 0,
        cfg: cfg({ compactAtTokens: 100, compactTargetTokens: target }),
      });
      if (!plan) continue;
      const first = live[plan.cutIndex];
      expect(first.role).not.toBe('toolResult');
      // Every kept tool result must still have its call in view.
      const seen = new Set<string>();
      for (const m of live.slice(plan.cutIndex)) {
        if (m.role === 'assistant') {
          for (const c of (m as AssistantMessage).content) {
            if (c.type === 'toolCall') seen.add(c.id);
          }
        }
        if (m.role === 'toolResult') {
          expect(seen.has((m as ToolResultMessage).toolCallId)).toBe(true);
        }
      }
      plans++;
    }
    expect(plans).toBeGreaterThan(50);
  });

  it('walks the cut PAST a tool result rather than stopping on it', () => {
    // The sweep above proves the invariant holds; it does not prove the
    // guard is what holds it, because the token arithmetic rarely comes
    // to rest on a tool result by chance. (It survived a mutation test
    // until this case existed.) So aim the cut at exactly that message.
    const prefix = Array.from({ length: 500 }, (_, i) => assistant(`step ${i} ${'w'.repeat(40)}`));
    const call = assistant('reading', [{ id: 'tc', name: 'read_file' }]);
    const result = toolResult('tc', 'read_file', 'x'.repeat(20_000));
    const tail: Message[] = [user('carry on'), assistant('sure')];
    const live: Message[] = [...prefix, call, result, ...tail];

    // Stop the accumulator with the prefix consumed and nothing more,
    // which leaves `cut` pointing straight at the tool result.
    const target = estimateTokens([result, ...tail]) + SUMMARY_RESERVE_TOKENS;
    const plan = planCompaction({
      live,
      fixedTokens: 0,
      cfg: cfg({ compactAtTokens: 100, compactTargetTokens: target }),
    });

    expect(plan).not.toBeNull();
    expect(live[plan!.cutIndex].role).not.toBe('toolResult');
    // Unguarded this is prefix.length + 1 — the tool result itself.
    expect(plan!.cutIndex).toBe(prefix.length + 2);
  });

  it('always keeps the request currently being worked on', () => {
    const live: Message[] = [...filler(60), user('the thing I actually asked for'), assistant('ok')];
    const plan = planCompaction({
      live,
      fixedTokens: 0,
      cfg: cfg({ compactAtTokens: 100, compactTargetTokens: 50 }),
    })!;
    const kept = live.slice(plan.cutIndex);
    expect(kept.some((m) => m.role === 'user' && m.content === 'the thing I actually asked for'))
      .toBe(true);
  });

  it('declines a cut too small to be worth a summarizer call', () => {
    // Without this, a session parked just over the threshold pays for a
    // summarizer call every single turn and never gets under it.
    const live = filler(4);
    const plan = planCompaction({
      live,
      fixedTokens: 0,
      cfg: cfg({ compactAtTokens: 1, compactTargetTokens: 1 }),
    });
    expect(plan).toBeNull();
  });

  it('terminates: a second plan on the already-cut tail asks for nothing', () => {
    const live = filler(80);
    const c = cfg({ compactAtTokens: 4_000, compactTargetTokens: 2_000 });
    const first = planCompaction({ live, fixedTokens: 0, cfg: c })!;
    expect(first.cutIndex).toBeGreaterThan(0);
    const second = planCompaction({ live: live.slice(first.cutIndex), fixedTokens: 0, cfg: c });
    expect(second).toBeNull();
  });

  it('force ignores the trigger but not the minimum', () => {
    const c = cfg({ compactAtTokens: 10_000_000, compactTargetTokens: 5_000_000 });
    expect(planCompaction({ live: filler(80), fixedTokens: 0, cfg: c, force: true })).not.toBeNull();
    // A short session has nothing to reclaim; forcing must not invent
    // work, or an unusable reply on turn two would compact the seed.
    expect(planCompaction({ live: filler(2), fixedTokens: 0, cfg: c, force: true })).toBeNull();
  });

  it('counts the summary it is about to add against the target', () => {
    const plan = planCompaction({
      live: filler(80),
      fixedTokens: 5_000,
      cfg: cfg({ compactAtTokens: 4_000, compactTargetTokens: 3_000 }),
    })!;
    expect(plan.afterTokens).toBeLessThan(plan.beforeTokens);
    expect(plan.afterTokens).toBeGreaterThanOrEqual(5_000);
  });
});

describe('the summary message', () => {
  it("carries the user's own words verbatim", () => {
    const span = [user('build me a dashboard'), assistant('ok'), user('use blue, not green')];
    const summary = foldSummary({
      previous: null,
      text: 'You started a dashboard.',
      newQuotes: userQuotesOf(span),
      throughSeq: 3,
      now: 1,
    });
    const text = summaryMessage(summary).content as string;
    expect(text).toContain('build me a dashboard');
    expect(text).toContain('use blue, not green');
  });

  it('elides the OLDEST quotes when the block outgrows its ceiling, and counts them', () => {
    let summary = foldSummary({ previous: null, text: 't', newQuotes: ['oldest'], throughSeq: 1, now: 1 });
    for (let i = 0; i < 20; i++) {
      summary = foldSummary({
        previous: summary,
        text: 't',
        newQuotes: [`${i}:${'q'.repeat(2_000)}`],
        throughSeq: i + 2,
        now: 1,
      });
    }
    const text = summaryMessage(summary).content as string;
    expect(text).not.toContain('oldest');
    expect(text).toContain('19:');
    expect(text).toMatch(/\d+ older messages? elided/);
  });

  it('is a user message — never something the model thinks it said', () => {
    const summary = foldSummary({ previous: null, text: 's', newQuotes: [], throughSeq: 1, now: 1 });
    expect(summaryMessage(summary).role).toBe('user');
  });

  it('counts rounds so a session can report how often it has compacted', () => {
    const one = foldSummary({ previous: null, text: 'a', newQuotes: [], throughSeq: 1, now: 1 });
    const two = foldSummary({ previous: one, text: 'b', newQuotes: [], throughSeq: 2, now: 2 });
    expect(two.rounds).toBe(2);
    // Folded, not appended: the narrative must not grow every round.
    expect(two.text).toBe('b');
  });
});

describe('rendering a span for the summarizer', () => {
  it('bounds its own prompt, keeping both ends', () => {
    const span: Message[] = Array.from({ length: 400 }, (_, i) =>
      toolResult(`t${i}`, 'read_file', `${i}-${'x'.repeat(2_000)}`),
    );
    span.unshift(user('THE OPENING ASK'));
    span.push(user('THE LATEST ASK'));
    const out = renderSpan(span);
    expect(out.length).toBeLessThan(260_000);
    expect(out).toContain('THE OPENING ASK');
    expect(out).toContain('THE LATEST ASK');
    expect(out).toMatch(/characters of the middle omitted/);
  });

  it('marks tool errors as errors', () => {
    const err = { ...toolResult('t', 'bash', 'boom'), isError: true } as ToolResultMessage;
    expect(renderSpan([err])).toContain('TOOL ERROR');
  });
});

describe('summarizing', () => {
  const model = { id: 'm', maxTokens: 100 } as unknown as Model<'openai-completions'>;
  const span = [user('hello'), assistant('hi')];

  const streamOf = (msg: Partial<AssistantMessage>): StreamFn =>
    (() => ({
      async *[Symbol.asyncIterator]() {},
      result: async () => ({ role: 'assistant', content: [], stopReason: 'stop', ...msg }),
    })) as unknown as StreamFn;

  it('returns the summary text', async () => {
    const out = await summarizeSpan({
      span,
      model,
      apiKey: 'k',
      streamFn: streamOf({ content: [{ type: 'text', text: 'you did a thing' }] }),
    });
    expect(out).toBe('you did a thing');
  });

  it('reports failure rather than throwing, on every failure shape', async () => {
    // Its only caller is on the path that keeps a session alive, so a
    // throw here would turn a cost problem into a stuck session.
    const empty = streamOf({ content: [{ type: 'text', text: '   ' }] });
    const errored = streamOf({ content: [], stopReason: 'error' });
    const thrown = (() => {
      throw new Error('upstream exploded');
    }) as unknown as StreamFn;
    expect(await summarizeSpan({ span, model, apiKey: 'k', streamFn: empty })).toBeNull();
    expect(await summarizeSpan({ span, model, apiKey: 'k', streamFn: errored })).toBeNull();
    expect(await summarizeSpan({ span, model, apiKey: 'k', streamFn: thrown })).toBeNull();
  });

  it('gives up on its own schedule rather than eating the turn budget', async () => {
    const hangs = (() => ({
      async *[Symbol.asyncIterator]() {},
      result: () => new Promise(() => {}),
    })) as unknown as StreamFn;
    expect(
      await summarizeSpan({ span, model, apiKey: 'k', streamFn: hangs, timeoutMs: 5 }),
    ).toBeNull();
  });

  it('asks the model to fold a previous summary in, not append to it', async () => {
    let seen = '';
    const capture = ((_m: unknown, ctx: { messages: Message[] }) => {
      seen = ctx.messages[0].content as string;
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => ({
          role: 'assistant',
          content: [{ type: 'text', text: 'folded' }],
          stopReason: 'stop',
        }),
      };
    }) as unknown as StreamFn;
    await summarizeSpan({ span, previousSummary: 'EARLIER STATE', model, apiKey: 'k', streamFn: capture });
    expect(seen).toContain('EARLIER STATE');
    expect(seen).toMatch(/do not append/i);
  });
});

describe('the mechanical fallback', () => {
  it('keeps what the agent did when the summarizer could not say it', () => {
    const span = [
      user('go'),
      assistant('reading', [{ id: 'a', name: 'read_file' }]),
      toolResult('a', 'read_file', 'x'),
      assistant('writing', [{ id: 'b', name: 'write_file' }]),
      toolResult('b', 'write_file', 'ok'),
      assistant('done for now'),
    ];
    const out = mechanicalSummary(span);
    expect(out).toContain('read_file');
    expect(out).toContain('write_file');
    expect(out).toContain('done for now');
    expect(out).toMatch(/mechanical/i);
  });
});
