/**
 * `applyLoopEvent` rules that a consumer reported as lost answers.
 *
 * Both cases here were measured against the shipped reducer before being
 * fixed — the redundant-dump guard ignored `kind: 'report'`, and a tool
 * result whose id matched no call was discarded in silence.
 */
import { describe, expect, it } from 'vitest';
import { applyLoopEvent, type InvestigatorTranscriptEntry } from '../investigator/InvestigatorTranscript.js';
import type { LoopEvent } from '../agent-loop.js';
import type { ToolResultUi } from '../agent-tools.js';

const fold = (events: LoopEvent[]) =>
  events.reduce<InvestigatorTranscriptEntry[]>((acc, ev) => applyLoopEvent(acc, ev), []);

const call = (name: string, id = 'c1'): LoopEvent => ({
  kind: 'toolCall',
  turnId: 't1',
  needsApproval: false,
  call: { id, function: { name, arguments: '{}' } },
});
const result = (name: string, ui: ToolResultUi, id = 'c1'): LoopEvent => ({
  kind: 'toolResult',
  turnId: 't1',
  result: { id, name, content: '', ui },
});
const prose = (chunk: string): LoopEvent => ({ kind: 'assistantText', turnId: 't1', chunk });
const done: LoopEvent = { kind: 'assistantDone', turnId: 't1' };

const REPORT: ToolResultUi = { kind: 'report', headline: 'NOT HOT DOG', report: '## Verdict\nA dachshund.' };
const SUMMARY: ToolResultUi = { kind: 'summary', findings: [], conclusion: 'Disk full.' };

const assistants = (entries: InvestigatorTranscriptEntry[]) =>
  entries.filter((e) => e.kind === 'assistant');

describe('redundant conclusion dump', () => {
  it('drops the dump when a report card already rendered it', () => {
    // The regression: this guard required the tool to be named
    // `present_investigation_summary` with `kind: 'summary'`, so a
    // server-side agent concluding with `report` rendered the card AND the
    // markdown dump underneath it.
    const entries = fold([
      call('report'), result('report', REPORT),
      prose('## Findings\n\nThe photo shows a dachshund.'), done,
    ]);
    expect(assistants(entries)).toHaveLength(0);
  });

  it('still drops it for a summary card', () => {
    const entries = fold([
      call('present_investigation_summary'), result('present_investigation_summary', SUMMARY),
      prose('## Conclusion\n\nDisk full.'), done,
    ]);
    expect(assistants(entries)).toHaveLength(0);
  });

  it('keeps prose that is not a redundant dump', () => {
    // Only a leading `## Findings`/`## Conclusion` heading counts. Ordinary
    // closing prose alongside a card is the agent talking, not duplicating.
    const entries = fold([
      call('report'), result('report', REPORT),
      prose('Happy to dig further if useful.'), done,
    ]);
    expect(assistants(entries)).toHaveLength(1);
  });

  it('keeps the dump when no conclusion card rendered at all', () => {
    // Without a card the markdown IS the answer; dropping it loses the
    // conclusion entirely.
    const entries = fold([prose('## Findings\n\nDisk full.'), done]);
    expect(assistants(entries)).toHaveLength(1);
  });

  it('ignores a tool call whose result never arrived', () => {
    // A pending call is not a rendered card.
    const entries = fold([call('report'), prose('## Findings\n\nx'), done]);
    expect(assistants(entries)).toHaveLength(1);
  });
});

describe('tool result with no matching call', () => {
  it('renders the result instead of discarding it silently', () => {
    // Previously this returned the transcript unchanged: the call sat at
    // `running` forever and the answer inside the result never appeared
    // anywhere. A transport whose fallback ids do not match the ones it
    // sent produces exactly this, with nothing on screen to say so.
    const entries = fold([call('report', 'real-id'), result('report', REPORT, 'other-id')]);
    const cards = entries.filter((e) => e.kind === 'toolCall');
    expect(cards).toHaveLength(2);
    const orphan = cards.find((e) => e.kind === 'toolCall' && e.result?.ui?.kind === 'report');
    expect(orphan).toBeDefined();
    expect(orphan && orphan.kind === 'toolCall' && orphan.status).toBe('done');
  });

  it('keeps the conclusion readable through the normal extractor', () => {
    const entries = fold([result('report', REPORT, 'unmatched')]);
    expect(entries.filter((e) => e.kind === 'toolCall')).toHaveLength(1);
  });

  it('still attaches normally when the id does match', () => {
    const entries = fold([call('report', 'c9'), result('report', REPORT, 'c9')]);
    expect(entries.filter((e) => e.kind === 'toolCall')).toHaveLength(1);
  });

  it('marks an errored payload as errored, matched or not', () => {
    const failed: ToolResultUi = { kind: 'search', error: 'boom' };
    const matchedEntries = fold([call('run_search', 'c2'), result('run_search', failed, 'c2')]);
    const orphanEntries = fold([result('run_search', failed, 'nope')]);
    for (const entries of [matchedEntries, orphanEntries]) {
      const card = entries.find((e) => e.kind === 'toolCall');
      expect(card && card.kind === 'toolCall' && card.status).toBe('error');
    }
  });
});
