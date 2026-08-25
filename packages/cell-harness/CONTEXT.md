# Context management in a cell session

What the harness does about a conversation that outgrows its model, why
each choice was made, and **what to change if the choice turns out to be
wrong**. The last part is the point of this document: the policy below is
deliberately aggressive, and the evidence that would reverse it is named
here rather than left to be rediscovered.

Code: `src/compaction.ts` (policy, pure), `src/sessionDO.ts` (`history()`,
`compact()`, `retryUnusable()`), `src/realTurn.ts` (`classifyReply`).

---

## The failure this exists for

Found in production 2026-08-24, reported as "the session stopped
responding".

A session reached ~217k tokens of transcript — 433 frames, 445 KB of that
tool results alone. Three consecutive turns came back as
`userMessage → assistantDone → done` with no text and no tool call,
including on a bare "Are you there? Respond with yes/no". The model
returned an **empty assistant message**, and the turn runner computed

```ts
done = conclusion != null || calls.length === 0
```

so an empty reply was indistinguishable from "the model is finished": the
session appended `done` and parked at **`idle` reporting success**. No
error frame, healthy status, nothing in the UI to tell it apart from a
hung network.

Reproduced rather than inferred. Replaying that session's own history
against the live model at the cell's real `maxTokens: 16_384` gave
`prompt_tokens: 205,086`, and one trial returned `finish_reason: "length"`
with `content: null` — the entire output budget went to a response that
never arrived. Retries at the same size sometimes answer, so the symptom
is **intermittent**, which is exactly why it reads as flakiness rather
than a limit.

## What compaction is NOT for

Two walls we expected turned out not to exist, and both were cheap to
check. They are recorded because the reasoning that produced them is the
kind worth not repeating:

- **~~`history()`'s single `SELECT` will trip the SQL result-set cap.~~**
  Measured under `wrangler dev` against an `agent_messages`-shaped table
  read exactly the way `history()` reads it: 0.78 MB, 3.52 MB, 7.81 MB,
  15.63 MB, 39 MB and 78 MB all returned successfully — 20,338 rows at the
  top end. The ~3.6 MB a 1M-token history needs has an order of magnitude
  of headroom. Caveats: measured locally, not on celld; and it says
  nothing about the memory cost of materializing that array inside a
  128 MB isolate.
- **~~Latency scales with input, so a big history times the turn out.~~**
  It scales with **output**. Identical final prompt, identical
  `max_tokens: 16384`, only history length varying:

  | prompt tokens | completion tokens | wall clock | ms/output token |
  | --- | --- | --- | --- |
  | 181,495 | 2,301 | 87.5s | 38.0 |
  | 332,947 | 1,971 | 67.4s | 34.2 |

  Input grew 83% and the call got *faster*. A 333k-token prompt asked for
  one word (`max_tokens: 64`) answered in 10.7s.

So compaction buys **cost** and **correctness**, not capacity:

- **Cost.** The whole history is re-sent every turn, and prompt caching is
  barely engaging — measured `cached_tokens: 64` out of 205,086. Spend
  grows quadratically over a session's life.
- **Correctness.** Most of a large coding history is stale tool output.
  An old `read_file` result whose file has since been rewritten is
  actively misleading, not merely bulky.

A bigger context window fixes neither. See "Raising the window" below.

---

## The policy

Chosen 2026-08-24. **Aggressive on tool results, never on user
messages.**

### Tier 1 — bound tool results (always on, no LLM call)

Recomputed on every `history()` from the stored rows; nothing is
persisted. Newest-first, a tool result survives verbatim if it is one of
the newest `TOOL_RESULT_MIN_KEEP` (4), or is at or under
`TOOL_RESULT_SMALL_CHARS` (1,024), or still fits the running budget
(`CONTEXT_TOOL_RESULT_BUDGET`, default 15% of the window in tokens ×4
chars). Everything else becomes a one-line marker naming the tool and its
size.

The message stays in place with the same `toolCallId` — only its content
shrinks. Dropping it would orphan its assistant tool call, which most
providers reject outright.

Because nothing is persisted, **widening the budget brings the full
results straight back**. That is what makes being aggressive here cheap
to be wrong about.

### Tier 2 — summarize and cut (over a threshold)

When the estimated prompt crosses `CONTEXT_COMPACT_AT` (default half the
window), the oldest span of live messages is summarized into one
synthetic `user` message and cut from model history, aiming at
`CONTEXT_COMPACT_TARGET` (default 30% of the window).

Three invariants:

1. **The kept span never begins with a tool result.** The cut walks past
   them. An unpaired tool result is a hard API error, not a degraded
   answer.
2. **The most recent user message and everything after it always
   survive** — that is the request being worked on.
3. **A cut reclaiming less than 4,000 tokens is no cut.** Without this, a
   session parked just over the threshold pays for a summarizer call
   every turn and never gets under it. This is also what makes repeated
   compaction terminate.

The compacted rows stay in `agent_messages`; only `throughSeq` moves.
Compaction affects **model history only** — `transcript_events` is the
user's record and is never touched, so a compacted session still replays
in full.

### What is never paraphrased

The user's own messages from every compacted span are re-emitted verbatim
inside the summary message. Only that block has a ceiling (12,000 chars);
crossing it elides the **oldest** quotes and says how many out loud.

### Compaction runs as its own alarm step

Not inside a model turn. A summarizer call folded into the turn it
protects adds its latency to the same ~300s handler budget, and blowing
that kills the **celld process** — every session on the node, not just
this isolate. So: one alarm compacts, the next runs the turn. The
compaction step does not advance the turn counter, so it costs the user
no step budget.

The summarizer has `SUMMARY_MAX_TOKENS` (1,500) and
`SUMMARY_TIMEOUT_MS` (90s), and the timeout is enforced by racing, not
only by aborting the signal — an adapter that ignores its signal would
otherwise leave the alarm hanging until the handler budget ran out.

**If the summarizer fails, compaction happens anyway** with a mechanical
digest (tool names and counts, the last thing the agent said). A
summarizer outage must not turn a cost problem into an availability one.

### An unusable reply: compact, retry once, then fail loudly

`classifyReply()` names two cases the loop cannot act on — `empty` (no
text, no tool calls) and `truncated` (the same, with
`finish_reason: length`). Both take the failed-turn path: no
`assistantDone`, and the message is **not persisted** (persisting it
replays an empty turn forever and leaves the stored history ending on an
assistant message, which is not a turn boundary `Agent.continue()`
accepts).

The DO then compacts (forced) and retries **once**. Compact-then-retry,
not retry-then-compact: when the cause is the context, an immediate retry
on the same history is a second expensive way to fail. When it isn't, the
planner declines and it is a plain retry. A second unusable reply emits
an error frame naming the conversation's size.

A message with tool calls is never unusable — the loop has real work, and
pi-agent-core already fails truncated tool calls explicitly. A truncated
reply that *did* produce text is not unusable either: the user keeps the
cut-off answer plus a notification. Failing that would break every long
generation.

---

## Configuration

Everything derives from `LLM_CONTEXT_WINDOW`, so raising the window for a
bigger model raises the compaction point with it.

| var | default | what it does |
| --- | --- | --- |
| `LLM_CONTEXT_WINDOW` | 200,000 | declared input window; the base for every threshold below |
| `LLM_MAX_TOKENS` | 16,384 | output budget per turn |
| `CONTEXT_COMPACTION` | on | `off` disables tier 2; tier 1 stays |
| `CONTEXT_COMPACT_AT` | 50% of window | trigger, in tokens |
| `CONTEXT_COMPACT_TARGET` | 30% of window | aim, in tokens |
| `CONTEXT_TOOL_RESULT_BUDGET` | 15% of window ×4 | verbatim tool-result budget, in chars |

`GET /investigations/:id/status` reports `contextTokens`,
`contextWindow`, and `compactions`. `contextTokens` is read from a KV
entry written by the last `history()` — it is not recomputed on the
route, which the UI polls every few seconds.

---

## Reversing this

The aggressive setting was chosen because measurement showed nothing
breaks at 333k tokens, so a conservative policy does not avoid a wall —
it just costs more and leaves more stale tool output in front of the
model. That makes aggressive the cheaper thing to be wrong about. Here is
what "wrong" would look like and what to do.

**Symptom: the agent keeps re-reading files it read minutes ago.**
Tier 1's budget is too tight. Raise `CONTEXT_TOOL_RESULT_BUDGET`. Costs
nothing else — tier 1 is recomputed from untouched rows, so this takes
effect on the very next turn with no migration and no data loss.

**Symptom: the agent forgets a decision and re-tries a rejected
approach.** Tier 2 is cutting too early or the summary is too thin.
Raise `CONTEXT_COMPACT_AT` first (compact later), then
`CONTEXT_COMPACT_TARGET` (keep more). If the summary itself is the
problem, raise `SUMMARY_MAX_TOKENS` — but note latency tracks output
tokens, so this is the one knob that can push the compaction step toward
its ceiling.

**Symptom: compaction fires on nearly every turn.** The trigger and the
target are too close, or `MIN_DROP_TOKENS` is too low for this workload.
Widen the gap between `CONTEXT_COMPACT_AT` and `CONTEXT_COMPACT_TARGET`.

**Symptom: a provider rejects a request after a compaction.** Almost
certainly message pairing. `planCompaction` has a sweep test for exactly
this; add the failing shape to it before changing anything.

**Symptom: the summarizer is unreliable or expensive.** Set
`CONTEXT_COMPACTION=off` per cell. Tier 1 keeps working and needs no LLM
call. This is a config change, not a redeploy.

**To abandon tier 2 entirely**: delete the `compact()` call in
`runTurn()` and the `contextSummary` KV read in `buildHistory()`. Stored
rows are unmodified, so any session mid-compaction simply becomes
uncompacted again — `throughSeq` is the only thing that would be
ignored, and no data is lost.

## Raising the window

Setting `LLM_CONTEXT_WINDOW` to 1,000,000 is now a config change: the
declared window is passed to pi-ai and every threshold scales with it.
But it is **viable, not valuable**. pi-agent-core never reads
`contextWindow` (its own default is 0), so the old 200,000 clamped
nothing and raising it clamps nothing either — a 205k-token prompt was
measured going out and being served. A bigger window on its own buys a
more expensive version of the same failure, further out.

Do compaction first. Then, before raising it in production, measure the
one thing still unmeasured: **time to first token at 600k and 1M**,
separately from total latency. The 181k-vs-333k pair shows prefill is not
dominating at that scale, but it does not prove prefill stays cheap at
1M — and TTFT is what `TURN_TIMEOUT_MS` (180s) actually races. Note also
that a shared provider pool returned upstream `429`s at 205k; a 1M-token
turn is a much larger unit of work to have rejected and retried.
