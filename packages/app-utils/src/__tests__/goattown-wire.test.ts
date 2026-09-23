/**
 * Wire mapping and conclusion extraction.
 *
 * The fixtures are the shapes that actually reached a consumer, including
 * the dachshund `assistantText` payload from the service's own published
 * example — these are regressions, not invented cases.
 */
import { describe, expect, it } from 'vitest';
import type { WireLoopEvent } from '@criblio/agent-protocol';
import {
  isUserMessageFrame,
  readEventCollection,
  wireEventToLoopEvent,
} from '../goattown/wire.js';
import { conclusionFromEntries } from '../goattown/conclusion.js';
import { applyLoopEvent, type InvestigatorTranscriptEntry } from '../investigator/InvestigatorTranscript.js';

const DACHSHUND = {
  kind: 'assistantText',
  turnId: 'turn-0',
  chunk: 'NOT HOT DOG\nThe photo shows a dachshund, not a hot dog.',
} satisfies WireLoopEvent;

describe('wireEventToLoopEvent', () => {
  it('passes the dachshund assistantText through unchanged', () => {
    expect(wireEventToLoopEvent(DACHSHUND)).toEqual(DACHSHUND);
  });

  it('converts a wire error message into a real Error', () => {
    // applyLoopEvent and the error card read ev.error.message; a wire event
    // passed through unconverted renders an empty banner.
    const loop = wireEventToLoopEvent({ kind: 'error', message: 'boom' });
    expect(loop).toMatchObject({ kind: 'error' });
    const error = (loop as { error: Error }).error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('boom');
  });

  it('refuses userMessage — it is wire-only and not a LoopEvent', () => {
    expect(wireEventToLoopEvent({ kind: 'userMessage', turnId: 'u', content: 'hi' })).toBeNull();
  });

  it('returns null for a kind this version does not know', () => {
    expect(wireEventToLoopEvent({ kind: 'invented' } as unknown as WireLoopEvent)).toBeNull();
  });

  it('normalizes a done reason but keeps aborted distinct', () => {
    expect(wireEventToLoopEvent({ kind: 'done', reason: 'aborted' })).toEqual({
      kind: 'done', reason: 'aborted',
    });
    expect(wireEventToLoopEvent({ kind: 'done', reason: 'whatever' })).toEqual({
      kind: 'done', reason: 'complete',
    });
  });
});

describe('readEventCollection', () => {
  const frame = { seq: 1, ev: DACHSHUND };

  it('reads the combined status window', () => {
    expect(readEventCollection({ eventWindow: { since: 0, frames: [frame] } })).toEqual([frame]);
  });

  it('reads the authoritative events collection', () => {
    expect(readEventCollection({ frames: [frame] })).toEqual([frame]);
  });

  it('reads the captured legacy collection', () => {
    expect(readEventCollection({ events: [frame] })).toEqual([frame]);
  });

  it('distinguishes "no collection" from "an empty collection"', () => {
    // null means this route cannot serve events and the caller should switch
    // to /events permanently; [] means nothing is new right now. Collapsing
    // them polls a route that will never answer.
    expect(readEventCollection({ status: 'running', latestSeq: 3 })).toBeNull();
    expect(readEventCollection({ frames: [] })).toEqual([]);
  });

  it('never mistakes a bare event for an envelope', () => {
    // A LoopEvent has `kind` but no `seq`. Treating one as a frame feeds the
    // envelope to the reducer as though it were the event.
    expect(readEventCollection({ frames: [DACHSHUND] })).toEqual([]);
  });
});

describe('isUserMessageFrame', () => {
  it('identifies the user turn so it bypasses applyLoopEvent', () => {
    expect(isUserMessageFrame({ seq: 1, ev: { kind: 'userMessage', turnId: 'u', content: 'hi' } })).toBe(true);
    expect(isUserMessageFrame({ seq: 2, ev: DACHSHUND })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────

/** Fold wire frames the way a consumer does, so conclusions are read from a
 *  real transcript rather than a hand-built entry array. */
function transcript(events: WireLoopEvent[]): InvestigatorTranscriptEntry[] {
  let entries: InvestigatorTranscriptEntry[] = [];
  for (const ev of events) {
    const loop = wireEventToLoopEvent(ev);
    if (loop) entries = applyLoopEvent(entries, loop);
  }
  return entries;
}

const reportCall = (ui: unknown): WireLoopEvent[] => [
  { kind: 'toolCall', turnId: 't', call: { id: 'c1', type: 'function', function: { name: 'report', arguments: '{}' } }, needsApproval: false },
  { kind: 'toolResult', turnId: 't', result: { id: 'c1', name: 'report', content: '', ui } },
];

describe('conclusionFromEntries', () => {
  it('reads a report tool result, which no assistant entry carries', () => {
    // The regression: the verdict lives in the tool result, so an extractor
    // scanning assistant entries returns '' exactly when the agent did the
    // recommended thing, and '' parses downstream as "couldn't tell".
    const entries = transcript(reportCall({
      kind: 'report',
      headline: 'NOT HOT DOG',
      report: '## Verdict\n\nThe photo shows a dachshund.',
    }));
    const found = conclusionFromEntries(entries);
    expect(found.source).toBe('report');
    expect(found.headline).toBe('NOT HOT DOG');
    expect(found.text).toContain('NOT HOT DOG');
    expect(found.text).toContain('dachshund');
  });

  it('reads a summary conclusion', () => {
    const entries = transcript(reportCall({ kind: 'summary', findings: [], conclusion: 'Root cause: disk full.' }));
    expect(conclusionFromEntries(entries)).toMatchObject({
      source: 'summary', text: 'Root cause: disk full.',
    });
  });

  it('falls back to assistant prose when no tool concluded', () => {
    const entries = transcript([DACHSHUND, { kind: 'assistantDone', turnId: 'turn-0' }]);
    expect(conclusionFromEntries(entries)).toMatchObject({
      source: 'assistant', text: DACHSHUND.chunk,
    });
  });

  it('prefers the tool conclusion over assistant prose', () => {
    const entries = transcript([
      DACHSHUND,
      { kind: 'assistantDone', turnId: 'turn-0' },
      ...reportCall({ kind: 'report', headline: 'NOT HOT DOG', report: 'body' }),
    ]);
    expect(conclusionFromEntries(entries).source).toBe('report');
  });

  it('reports "none" with a count rather than a misleading empty success', () => {
    const empty = conclusionFromEntries([]);
    expect(empty).toEqual({ text: '', source: 'none', headline: '', entryCount: 0 });
    const noAnswer = conclusionFromEntries(transcript([
      { kind: 'notification', turnId: 't', content: 'working' },
    ]));
    expect(noAnswer.source).toBe('none');
    expect(noAnswer.entryCount).toBeGreaterThanOrEqual(0);
  });

  it('takes the last report when a session produced several', () => {
    const entries = transcript([
      ...reportCall({ kind: 'report', headline: 'first', report: 'a' }),
      { kind: 'toolCall', turnId: 't', call: { id: 'c2', type: 'function', function: { name: 'report', arguments: '{}' } }, needsApproval: false },
      { kind: 'toolResult', turnId: 't', result: { id: 'c2', name: 'report', content: '', ui: { kind: 'report', headline: 'second', report: 'b' } } },
    ]);
    expect(conclusionFromEntries(entries).headline).toBe('second');
  });
});
