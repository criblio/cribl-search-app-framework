/**
 * Context management for a long session: bound what the model reads,
 * and summarize what falls off the front.
 *
 * WHY THIS EXISTS. `history()` re-reads the whole `agent_messages`
 * table every turn and re-sends it, so a session's per-turn cost grows
 * linearly with its own lifetime, and the model spends most of a large
 * history reading stale tool output. Measured on a real session
 * (2026-08-24): 217k tokens of transcript, 445 KB of 777 KB being tool
 * results alone, at `cached_tokens: 64` of 205,086 — i.e. essentially
 * no prompt-cache relief. The declared `contextWindow` is inert
 * (pi-agent-core never reads it), so nothing clamps, warns, or
 * truncates on its own.
 *
 * WHAT IT IS NOT. This is not a capacity fix. Measurement refuted the
 * two walls we expected: a `history()`-shaped SELECT returned 78 MB
 * successfully under wrangler dev, and latency tracks OUTPUT tokens,
 * not input size (181k prompt / 2,301 out took 87.5s; 333k prompt /
 * 1,971 out took 67.4s). What compaction buys is **cost** and
 * **correctness**, not headroom. A bigger window buys neither.
 *
 * THE POLICY, so it can be reversed on evidence rather than taste
 * (chosen 2026-08-24; see CONTEXT.md for the full write-up):
 *
 *   1. Tool results are compacted first and hardest. They dominate by
 *      volume and they are the part most likely to be actively
 *      misleading — an old `read_file` whose file has since been
 *      rewritten is worse than absent. Older, large tool results
 *      degrade to a one-line marker naming the tool and its size.
 *      This tier costs nothing: no LLM call, no state, recomputed from
 *      the stored rows on every `history()`. It generalizes the image
 *      window that already existed.
 *   2. A user's own words are never dropped. When the oldest span is
 *      summarized away, the user messages inside it are re-emitted
 *      verbatim inside the summary message. Only that verbatim block
 *      has a size ceiling, and crossing it elides the OLDEST quotes
 *      with an explicit count.
 *   3. Summarization is bounded and never wedges the session. It runs
 *      as its own alarm step (not inside a model turn), with its own
 *      timeout and a small output budget, and if the call fails it
 *      falls back to a mechanical digest and compacts anyway. A failed
 *      summarizer must not be able to stop a session from proceeding.
 *
 * Compaction affects MODEL history only. The transcript
 * (`transcript_events`) is the user's record and is never touched, so
 * a compacted session still replays in full.
 */
import type {
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';

// ── size estimation ────────────────────────────────────────────────

/** Chars per token. Deliberately crude: every consumer of this number
 *  compares it against a threshold with slack in it, and a real
 *  tokenizer is 400 KB of tables this isolate should not carry. */
const CHARS_PER_TOKEN = 4;

/**
 * Flat token cost charged for one image part.
 *
 * NOT `data.length / 4`: an image is base64, so its string length is
 * ~1.4× its bytes and bears no relation to what it costs the model.
 * A 2 MB screenshot would read as 700k tokens and trigger compaction
 * on a session with almost no text in it. 1,600 is the right order of
 * magnitude for a 1568px-long-edge image, which is what the composer
 * downscales to.
 */
const IMAGE_TOKENS = 1_600;

/** Per-message framing (role, delimiters) the provider adds. */
const MESSAGE_OVERHEAD_TOKENS = 4;

function textTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/** Every content part shape any pi message can carry. */
type AnyPart = TextContent | ImageContent | ThinkingContent | ToolCall;

/** The content parts of a message, whichever union it belongs to. */
function partsOf(msg: Message): AnyPart[] {
  return typeof msg.content === 'string' ? [] : (msg.content as AnyPart[]);
}

/** Estimated prompt tokens for one pi message. */
export function estimateMessageTokens(msg: Message): number {
  let n = MESSAGE_OVERHEAD_TOKENS;
  if (typeof msg.content === 'string') return n + textTokens(msg.content);
  for (const part of partsOf(msg)) {
    switch (part.type) {
      case 'text':
        n += textTokens(part.text);
        break;
      case 'thinking':
        n += textTokens(part.thinking);
        break;
      case 'image':
        n += IMAGE_TOKENS;
        break;
      case 'toolCall':
        n += textTokens(part.name) + textTokens(JSON.stringify(part.arguments ?? {}));
        break;
    }
  }
  if (msg.role === 'toolResult') n += textTokens(msg.toolName ?? '');
  return n;
}

/** Estimated prompt tokens for a whole conversation. */
export function estimateTokens(messages: readonly Message[]): number {
  let n = 0;
  for (const m of messages) n += estimateMessageTokens(m);
  return n;
}

// ── configuration ──────────────────────────────────────────────────

/** Declared input window when the cell doesn't say otherwise. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Output budget when the cell doesn't say otherwise. On an
 *  OpenAI-completions endpoint this is shared between reasoning and the
 *  answer, which is how a turn can spend the whole budget and still
 *  return `content: null`. */
export const DEFAULT_MAX_TOKENS = 16_384;

/** Compact when the prompt estimate crosses this share of the window. */
const COMPACT_AT_FRACTION = 0.5;
/** Compact until the estimate is at or under this share of the window. */
const COMPACT_TARGET_FRACTION = 0.3;
/** Verbatim budget for older tool results, as a share of the window. */
const TOOL_RESULT_BUDGET_FRACTION = 0.15;

/** Newest tool results that survive verbatim whatever their size —
 *  the model is usually mid-way through acting on them. */
const TOOL_RESULT_MIN_KEEP = 4;
/** A tool result this small is never worth eliding: the marker that
 *  replaces it would cost about as much, and short results are
 *  disproportionately the ones carrying the answer ("ok", an error). */
const TOOL_RESULT_SMALL_CHARS = 1_024;

/** Don't pay for a summarizer call to drop less than this. Also what
 *  makes repeated compaction terminate: a plan that can't reclaim this
 *  much returns null instead of spinning. */
const MIN_DROP_TOKENS = 4_000;
/** Room left for the summary message the compaction is about to add.
 *  Exported so a test can aim a cut at an exact message boundary
 *  without re-deriving the planner's arithmetic. */
export const SUMMARY_RESERVE_TOKENS = 2_000;

/** Output budget for the summarizer itself. Small on purpose: latency
 *  tracks output tokens, and this call runs inside the same handler
 *  budget it exists to protect. */
export const SUMMARY_MAX_TOKENS = 1_500;
/** Whole-call ceiling for the summarizer. Well inside the 180s turn
 *  timeout, which is itself well inside celld's ~300s handler budget —
 *  and blowing THAT kills the celld process, not just this isolate. */
export const SUMMARY_TIMEOUT_MS = 90_000;

/** Largest span we will hand the summarizer, after tool results in it
 *  have been reduced to markers. Bounds the summarizer's own prompt. */
const SUMMARY_INPUT_CHARS = 200_000;
/** Ceiling on the verbatim user-quote block carried in the summary. */
const USER_QUOTE_CHARS = 12_000;

export interface ContextConfig {
  /** Model input window, declared. */
  contextWindow: number;
  /** Model output budget. */
  maxTokens: number;
  /** Whether compaction (tier 2) may run at all. */
  enabled: boolean;
  compactAtTokens: number;
  compactTargetTokens: number;
  toolResultBudgetChars: number;
  toolResultMinKeep: number;
  toolResultSmallChars: number;
}

interface ContextEnv {
  LLM_CONTEXT_WINDOW?: string;
  LLM_MAX_TOKENS?: string;
  CONTEXT_COMPACTION?: string;
  CONTEXT_COMPACT_AT?: string;
  CONTEXT_COMPACT_TARGET?: string;
  CONTEXT_TOOL_RESULT_BUDGET?: string;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Resolve the context policy from the cell's env.
 *
 * Everything derives from `LLM_CONTEXT_WINDOW`, so raising the window
 * raises the compaction point with it — which is what makes "use the
 * model's full 1M context" a config change on a deployed cell rather
 * than a code change. The thresholds can still be pinned individually
 * when a specific endpoint needs it.
 */
export function resolveContextConfig(env: ContextEnv): ContextConfig {
  const contextWindow = positiveInt(env.LLM_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW);
  const compactAtTokens = positiveInt(
    env.CONTEXT_COMPACT_AT,
    Math.floor(contextWindow * COMPACT_AT_FRACTION),
  );
  const compactTargetTokens = Math.min(
    positiveInt(env.CONTEXT_COMPACT_TARGET, Math.floor(contextWindow * COMPACT_TARGET_FRACTION)),
    compactAtTokens,
  );
  return {
    contextWindow,
    maxTokens: positiveInt(env.LLM_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    // Off is a deliberate escape hatch, not a default: a cell that hits
    // a summarizer problem in production can turn tier 2 off without a
    // redeploy and keep tier 1, which needs no LLM call.
    enabled: env.CONTEXT_COMPACTION !== 'off',
    compactAtTokens,
    compactTargetTokens,
    toolResultBudgetChars: positiveInt(
      env.CONTEXT_TOOL_RESULT_BUDGET,
      Math.floor(contextWindow * TOOL_RESULT_BUDGET_FRACTION) * CHARS_PER_TOKEN,
    ),
    toolResultMinKeep: TOOL_RESULT_MIN_KEEP,
    toolResultSmallChars: TOOL_RESULT_SMALL_CHARS,
  };
}

// ── tier 1: bound tool results ─────────────────────────────────────

function toolResultChars(msg: ToolResultMessage): number {
  let n = 0;
  for (const part of msg.content) {
    if (part.type === 'text') n += part.text.length;
    else if (part.type === 'image') n += IMAGE_TOKENS * CHARS_PER_TOKEN;
  }
  return n;
}

function elideToolResult(msg: ToolResultMessage): ToolResultMessage {
  const chars = toolResultChars(msg);
  return {
    ...msg,
    content: [
      {
        type: 'text',
        text:
          `[${msg.toolName} result elided to bound context — ${chars} characters. ` +
          `It may also be out of date; run the tool again if you still need it.]`,
      },
    ],
  };
}

/**
 * Replace older, large tool results with a marker.
 *
 * Newest-first so the model keeps what it is currently working with.
 * Pure and recomputed every turn, which is what lets the stored rows
 * stay untouched: nothing here is persisted, so widening the budget
 * later brings the full results straight back.
 *
 * Tool-call/tool-result PAIRING is preserved — the message stays in
 * place with the same `toolCallId`, only its content shrinks. Dropping
 * the message instead would orphan its assistant tool call, which most
 * providers reject outright.
 */
export function boundToolResults(messages: readonly Message[], cfg: ContextConfig): Message[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'toolResult') indices.push(i);
  }
  const elide = new Set<number>();
  let spent = 0;
  for (let k = indices.length - 1; k >= 0; k--) {
    const i = indices[k];
    const size = toolResultChars(messages[i] as ToolResultMessage);
    const fromEnd = indices.length - 1 - k;
    if (fromEnd < cfg.toolResultMinKeep) continue;
    if (size <= cfg.toolResultSmallChars) continue;
    if (spent + size <= cfg.toolResultBudgetChars) {
      spent += size;
      continue;
    }
    elide.add(i);
  }
  if (elide.size === 0) return messages as Message[];
  return messages.map((m, i) => (elide.has(i) ? elideToolResult(m as ToolResultMessage) : m));
}

// ── tier 2: summarize and cut ──────────────────────────────────────

/** The durable record of everything compacted out of model history so
 *  far. One entry per session, rewritten (not appended) each round. */
export interface ContextSummary {
  /** The rolling narrative summary. Each round folds the previous one
   *  in rather than concatenating, so this does not grow without
   *  bound. */
  text: string;
  /** The user's own messages from every compacted span, verbatim. */
  userQuotes: string[];
  /** `agent_messages.seq` at and below which rows are out of model
   *  history. The rows themselves are never deleted. */
  throughSeq: number;
  /** How many times this session has compacted. */
  rounds: number;
  updatedAt: number;
}

export interface CompactionPlan {
  /** Number of leading live messages to compact away. */
  cutIndex: number;
  /** Estimated tokens the cut reclaims. */
  droppedTokens: number;
  /** Estimated tokens the model would read before the cut. */
  beforeTokens: number;
  /** Estimated tokens after, including room reserved for the summary. */
  afterTokens: number;
}

function isUser(m: Message): m is UserMessage {
  return m.role === 'user';
}

/**
 * Decide how much of the front of the live history to compact away.
 * Pure — the caller does the summarizing and the writing.
 *
 * Three invariants, each of which has a way of failing loudly if
 * broken:
 *
 *  - **The kept span never begins with a tool result.** Its assistant
 *    tool call would be gone, and an unpaired tool result is a hard API
 *    error on most providers, not a degraded answer.
 *  - **The most recent user message and everything after it always
 *    survive**, because that is the request currently being worked on.
 *  - **A plan that reclaims less than `MIN_DROP_TOKENS` is no plan.**
 *    Without this, a session parked just over the threshold would pay
 *    for a summarizer call every single turn and never get under it.
 */
export function planCompaction(opts: {
  /** Live messages, already tier-1 bounded — i.e. what would actually
   *  be sent, which is what the threshold has to be measured against. */
  live: readonly Message[];
  /** Tokens for the parts of the prompt a cut cannot reclaim: the seed
   *  prompt and the existing summary message. */
  fixedTokens: number;
  cfg: ContextConfig;
  /** Ignore the trigger threshold and compact if there is anything
   *  worth compacting at all. Used after an unusable model reply, where
   *  the context is the leading suspect regardless of the estimate. */
  force?: boolean;
}): CompactionPlan | null {
  const { live, fixedTokens, cfg, force = false } = opts;
  const per = live.map(estimateMessageTokens);
  const liveTokens = per.reduce((a, b) => a + b, 0);
  const beforeTokens = fixedTokens + liveTokens;
  if (!force && beforeTokens <= cfg.compactAtTokens) return null;

  // Never cut into the request currently being worked on.
  let lastUser = -1;
  for (let i = live.length - 1; i >= 0; i--) {
    if (isUser(live[i])) {
      lastUser = i;
      break;
    }
  }
  const limit = lastUser >= 0 ? lastUser : live.length;

  const target = force
    ? Math.min(cfg.compactTargetTokens, Math.floor(beforeTokens * 0.6))
    : cfg.compactTargetTokens;
  const budget = Math.max(target - SUMMARY_RESERVE_TOKENS, 0);

  let cut = 0;
  let remaining = beforeTokens;
  while (cut < limit && remaining > budget) {
    remaining -= per[cut];
    cut++;
  }
  // Never leave a tool result as the first kept message.
  while (cut < limit && live[cut].role === 'toolResult') {
    remaining -= per[cut];
    cut++;
  }
  if (cut === 0) return null;

  const droppedTokens = beforeTokens - remaining;
  if (droppedTokens < MIN_DROP_TOKENS) return null;
  return {
    cutIndex: cut,
    droppedTokens,
    beforeTokens,
    afterTokens: remaining + SUMMARY_RESERVE_TOKENS,
  };
}

// ── summarizing ────────────────────────────────────────────────────

const SUMMARIZER_SYSTEM = `You compact the history of a long-running coding-agent session so the
session can continue in a smaller context window.

You are given a transcript of the EARLIEST part of a session, which is
about to be removed from the agent's working memory. Everything after it
is kept verbatim, so do not describe it — you cannot see it.

Write a dense factual briefing, in the second person ("you"), addressed
to the agent that will continue this session. Cover, in this order and
only where they apply:

1. What the user asked for, and any constraints or preferences they gave.
2. Decisions made and why, including approaches that were tried and
   rejected — a rejected approach re-tried is the most expensive kind of
   forgetting.
3. The current state of the work: files created or edited and what is in
   them, commands run and their outcome, anything left unfinished.
4. Facts discovered that are expensive to rediscover: API shapes,
   identifiers, error messages, versions, paths.

Rules: no preamble, no sign-off, no markdown headings. Prefer concrete
names and values over descriptions of them. If something is uncertain,
say so rather than inventing it. Be comprehensive about state and
decisions; be brief about narrative. Aim for under 600 words.`;

function contentText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  return partsOf(msg)
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

/** The verbatim user messages in a span, oldest first. */
export function userQuotesOf(span: readonly Message[]): string[] {
  return span
    .filter(isUser)
    .map((m) => contentText(m).trim())
    .filter((s) => s.length > 0);
}

/** Per-item cap when rendering a span for the summarizer. */
const RENDER_ITEM_CHARS = 2_000;

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…[+${s.length - n} chars]`;
}

/**
 * Render a span as a plain-text transcript for the summarizer.
 *
 * Deliberately NOT replayed as real pi messages: the span's assistant
 * turns would read as the summarizer's own prior output, its tool calls
 * would need matching tool definitions, and its tool results would need
 * intact pairing. One user message containing a transcript has none of
 * those failure modes, and it is the form that lets us bound the
 * summarizer's own prompt.
 */
export function renderSpan(span: readonly Message[]): string {
  const lines: string[] = [];
  for (const m of span) {
    if (m.role === 'user') {
      lines.push(`USER: ${clip(contentText(m), RENDER_ITEM_CHARS)}`);
    } else if (m.role === 'assistant') {
      const text = contentText(m).trim();
      if (text) lines.push(`ASSISTANT: ${clip(text, RENDER_ITEM_CHARS)}`);
      for (const c of (m as AssistantMessage).content) {
        if (c.type === 'toolCall') {
          lines.push(`ASSISTANT calls ${c.name}(${clip(JSON.stringify(c.arguments ?? {}), 400)})`);
        }
      }
    } else {
      const r = m as ToolResultMessage;
      lines.push(
        `${r.isError ? 'TOOL ERROR' : 'TOOL'} ${r.toolName}: ` +
          clip(contentText(m).trim(), RENDER_ITEM_CHARS),
      );
    }
  }
  const body = lines.join('\n');
  if (body.length <= SUMMARY_INPUT_CHARS) return body;
  // Keep both ends: the opening establishes what the session is FOR,
  // the tail is the state the continuing agent inherits.
  const head = Math.floor(SUMMARY_INPUT_CHARS * 0.4);
  const tail = SUMMARY_INPUT_CHARS - head;
  return `${body.slice(0, head)}\n\n…[${body.length - SUMMARY_INPUT_CHARS} characters of the middle omitted]…\n\n${body.slice(-tail)}`;
}

/**
 * Mechanical digest used when the summarizer call fails.
 *
 * The point is that compaction still HAPPENS. A summarizer outage must
 * not be able to park a session that has outgrown its window — that
 * would turn a cost problem into an availability one. This is a poor
 * summary and an adequate safety net: it keeps what the agent did
 * (tool names and counts) and what it last said, and the caller adds
 * the user's own words verbatim regardless.
 */
export function mechanicalSummary(span: readonly Message[]): string {
  const toolCounts = new Map<string, number>();
  let assistantTurns = 0;
  let lastAssistantText = '';
  for (const m of span) {
    if (m.role === 'assistant') {
      assistantTurns++;
      const t = contentText(m).trim();
      if (t) lastAssistantText = t;
      for (const c of (m as AssistantMessage).content) {
        if (c.type === 'toolCall') toolCounts.set(c.name, (toolCounts.get(c.name) ?? 0) + 1);
      }
    }
  }
  const tools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ×${n}`)
    .join(', ');
  const parts = [
    'The summarizer was unavailable, so this is a mechanical digest rather than a summary.',
    `The elided span holds ${span.length} messages and ${assistantTurns} of your turns.`,
  ];
  if (tools) parts.push(`Tools you called: ${tools}.`);
  if (lastAssistantText) {
    parts.push(`The last thing you said before this point: ${clip(lastAssistantText, 1_000)}`);
  }
  parts.push('Re-read anything you need rather than assuming it is still as you left it.');
  return parts.join(' ');
}

/**
 * Summarize a span with one bounded LLM call. Returns null on any
 * failure — an empty answer, an errored stream, a timeout — and the
 * caller falls back to `mechanicalSummary`. This function never
 * throws, because its only caller is on the path that keeps a session
 * alive.
 */
export async function summarizeSpan(opts: {
  span: readonly Message[];
  previousSummary?: string;
  model: Model<'openai-completions'>;
  apiKey: string;
  streamFn: StreamFn;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string | null> {
  const { span, previousSummary, model, apiKey, streamFn, signal } = opts;
  const timeoutMs = opts.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const rendered = renderSpan(span);
  if (!rendered.trim()) return null;

  const prompt = previousSummary
    ? `An earlier part of this same session was already compacted. That summary is:\n\n${previousSummary}\n\n` +
      `Below is the transcript of what happened NEXT, which is now also being compacted. ` +
      `Produce ONE briefing that folds both together — do not append, rewrite.\n\n${rendered}`
    : `Transcript to compact:\n\n${rendered}`;

  // Own timer, not the turn's: this call runs as its own alarm step and
  // must fail on its own schedule rather than eating the turn budget it
  // exists to protect.
  //
  // The deadline is enforced HERE, by racing, and not only by aborting
  // the signal. Aborting asks the provider adapter to settle; racing
  // guarantees this function returns. An adapter that ignores its
  // signal would otherwise leave the alarm hanging until celld's
  // handler budget runs out, and blowing THAT kills the celld process
  // and every other session on the node — the exact failure this whole
  // module exists to move away from.
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        ctl.abort();
        resolve(null);
      }, timeoutMs);
    });
    const call = (async (): Promise<string | null> => {
      const s = await streamFn(
        model as Model<'openai-completions'>,
        {
          systemPrompt: SUMMARIZER_SYSTEM,
          messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        },
        { apiKey, signal: ctl.signal, maxTokens: SUMMARY_MAX_TOKENS },
      );
      const msg = await s.result();
      if (msg.stopReason === 'error' || msg.stopReason === 'aborted') return null;
      const text = contentText(msg).trim();
      return text.length > 0 ? text : null;
    })();
    return await Promise.race([call, deadline]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Fold a completed round into the durable summary record.
 *
 * The user's quotes accumulate across rounds and are the one thing that
 * is never paraphrased. They still need a ceiling, or a chatty session
 * would rebuild the problem compaction exists to solve — so the OLDEST
 * quotes are the ones elided, and the elision is counted out loud
 * rather than being silent.
 */
export function foldSummary(opts: {
  previous: ContextSummary | null;
  text: string;
  newQuotes: string[];
  throughSeq: number;
  now: number;
}): ContextSummary {
  const { previous, text, newQuotes, throughSeq, now } = opts;
  let quotes = [...(previous?.userQuotes ?? []), ...newQuotes];
  let total = quotes.reduce((n, q) => n + q.length, 0);
  let elided = 0;
  while (quotes.length > 1 && total > USER_QUOTE_CHARS) {
    total -= quotes[0].length;
    quotes = quotes.slice(1);
    elided++;
  }
  if (elided > 0) {
    quotes = [`[${elided} older message${elided === 1 ? '' : 's'} elided]`, ...quotes];
  }
  return {
    text,
    userQuotes: quotes,
    throughSeq,
    rounds: (previous?.rounds ?? 0) + 1,
    updatedAt: now,
  };
}

/**
 * The single synthetic message that stands in for everything compacted
 * away. A `user` message rather than an `assistant` one: it must not
 * read as something the model itself said, and it must not sit where a
 * tool result is expected.
 */
export function summaryMessage(summary: ContextSummary): UserMessage {
  const quotes = summary.userQuotes.length
    ? `\n\nMy own messages from that part of the conversation, verbatim and in order:\n${summary.userQuotes
        .map((q, i) => `${i + 1}. ${q}`)
        .join('\n')}`
    : '';
  return {
    role: 'user',
    content:
      `[The earlier part of this conversation has been compacted to stay inside the ` +
      `context window. It is gone from your working memory but still in the user's ` +
      `transcript. Treat the summary below as your own memory of what happened, and ` +
      `re-read files or re-run tools rather than trusting remembered contents.]\n\n` +
      `${summary.text}${quotes}\n\n` +
      `[End of compacted history. Everything after this point is verbatim.]`,
    timestamp: summary.updatedAt,
  };
}
