/**
 * The transcript entry model and the reducer that builds it.
 *
 * Split out of InvestigatorTranscript.tsx so it carries NO stylesheet. The
 * GoatTown request controller folds events with `applyLoopEvent`, and
 * importing that from the component made the chat shell's stylesheet
 * reachable from two package entry points — which esm.sh code-splits into
 * a `.css.mjs` that esbuild consumers cannot load. That is the 0.8.4
 * breakage, and `scripts/check-css-build.mjs` caught the repeat before it
 * shipped.
 *
 * Nothing here renders. The component re-exports all of it, so every
 * existing import keeps working unchanged.
 */
import type { LoopEvent } from '../agent-loop.js';
import { isSessionExpiredError, type AgentToolCall } from '../agent.js';
import type { SummaryUi, ToolExecutionResult } from '../agent-tools.js';

export interface InvestigatorUserEntry {
  kind: 'user';
  id: string;
  content: string;
}

export interface InvestigatorAssistantEntry {
  kind: 'assistant';
  id: string;
  turnId: string;
  content: string;
  inProgress: boolean;
}

export interface InvestigatorToolCallEntry {
  kind: 'toolCall';
  id: string;
  turnId: string;
  call: AgentToolCall;
  needsApproval: boolean;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error';
  result?: ToolExecutionResult;
}

export interface InvestigatorErrorEntry {
  kind: 'error';
  id: string;
  message: string;
  /** True when this error is a session-expired from the platform's
   *  auth token. The UI shows a recovery explanation instead of
   *  just the raw message. */
  sessionExpired?: boolean;
}

export type InvestigatorTranscriptEntry =
  | InvestigatorUserEntry
  | InvestigatorAssistantEntry
  | InvestigatorToolCallEntry
  | InvestigatorErrorEntry;

export function applyLoopEvent(
  prev: InvestigatorTranscriptEntry[],
  ev: LoopEvent,
): InvestigatorTranscriptEntry[] {
  switch (ev.kind) {
    case 'assistantText': {
      // Find the most recent in-progress assistant entry for this
      // turn; append to it, or create one if missing.
      const lastIdx = findLastAssistant(prev, ev.turnId);
      if (lastIdx !== -1) {
        const next = prev.slice();
        const entry = next[lastIdx] as InvestigatorAssistantEntry;
        next[lastIdx] = { ...entry, content: entry.content + ev.chunk };
        return next;
      }
      return [
        ...prev,
        {
          kind: 'assistant',
          id: `a-${ev.turnId}`,
          turnId: ev.turnId,
          content: ev.chunk,
          inProgress: true,
        },
      ];
    }
    case 'assistantDone': {
      const lastIdx = findLastAssistant(prev, ev.turnId);
      if (lastIdx === -1) return prev;
      const next = prev.slice();
      const entry = next[lastIdx] as InvestigatorAssistantEntry;

      // If a conclusion card was already rendered from a real tool call,
      // the agent sometimes ALSO writes a redundant markdown dump starting
      // with "## Findings". Drop the whole assistant message in that case —
      // the card is the canonical rendering.
      //
      // Keyed on the PAYLOAD kind, not the tool name. This used to require
      // `present_investigation_summary`, which the framework cannot know a
      // host will use: a server-side agent concluding with `kind: 'report'`
      // rendered the card AND the dump, because the guard did not recognize
      // either the name or the kind. The renderer has understood 'report'
      // since 0.8.6; this is the reducer catching up.
      const hasRenderedSummary = next.some(
        (e) =>
          e.kind === 'toolCall' &&
          (e.result?.ui?.kind === 'summary' || e.result?.ui?.kind === 'report'),
      );
      const looksLikeRedundantSummary =
        hasRenderedSummary &&
        /^\s*##\s*(Findings|Conclusion)\b/m.test(entry.content);
      if (looksLikeRedundantSummary) {
        next.splice(lastIdx, 1);
        return next;
      }

      // Scrub any {% present_investigation_summary {...} %} text the
      // agent may have written instead of calling the tool. If we
      // find any, split the assistant entry into cleaned text +
      // synthetic summary entries that render via SummaryCard.
      const { cleaned, summaries } = scrubTemplateSummaries(entry.content);
      if (summaries.length === 0) {
        next[lastIdx] = { ...entry, inProgress: false };
        return next;
      }
      const insertions: InvestigatorTranscriptEntry[] = [];
      // Replace the assistant entry with the cleaned version (if any
      // text remains) and append a synthetic toolCall entry per
      // parsed summary. Use a nanoid-ish key so React keeps stable.
      next[lastIdx] = { ...entry, inProgress: false, content: cleaned };
      // If the cleaned content is now empty, drop the assistant entry.
      if (!cleaned.trim()) {
        next.splice(lastIdx, 1);
      }
      for (let i = 0; i < summaries.length; i++) {
        const synthId = `synthetic-summary-${ev.turnId}-${i}`;
        insertions.push({
          kind: 'toolCall',
          id: synthId,
          turnId: ev.turnId,
          call: {
            id: synthId,
            function: {
              name: 'present_investigation_summary',
              arguments: JSON.stringify(summaries[i]),
            },
          },
          needsApproval: false,
          status: 'done',
          result: {
            id: synthId,
            name: 'present_investigation_summary',
            content: '',
            ui: summaries[i],
          },
        });
      }
      return [...next, ...insertions];
    }
    case 'toolCall': {
      return [
        ...prev,
        {
          kind: 'toolCall',
          id: `tc-${ev.call.id}`,
          turnId: ev.turnId,
          call: ev.call,
          needsApproval: ev.needsApproval,
          status: ev.needsApproval ? 'pending' : 'running',
        },
      ];
    }
    case 'toolResult': {
      const ui = ev.result.ui;
      // Any card kind can carry an `error` field (search, trace, …) — mark
      // the entry errored so the card styles it.
      const uiError = ui?.error;
      const hasError = typeof uiError === 'string' && uiError.length > 0;
      const status: InvestigatorToolCallEntry['status'] = hasError ? 'error' : 'done';

      let matched = false;
      const next = prev.map((e) => {
        if (e.kind !== 'toolCall' || e.call.id !== ev.result.id) return e;
        matched = true;
        return { ...e, status, result: ev.result };
      });
      if (matched) return next;

      // No call carries this id. That used to return the transcript
      // unchanged, which discarded the result in silence — the call entry
      // sat at `running` forever and the answer inside the result never
      // rendered anywhere. A transport whose fallback ids do not match the
      // ones it sent produces exactly this, and nothing on screen says so.
      //
      // Synthesize an entry instead. The result carries its own name and
      // ui, which is everything a card needs, so the content reaches the
      // reader even though its call went missing.
      return [
        ...next,
        {
          kind: 'toolCall',
          id: `orphan-${ev.result.id || ev.result.name}`,
          turnId: ev.turnId,
          call: {
            id: ev.result.id,
            function: { name: ev.result.name, arguments: '{}' },
          },
          needsApproval: false,
          status,
          result: ev.result,
        },
      ];
    }
    case 'notification':
    case 'done':
      return prev;
    case 'error':
      return [
        ...prev,
        {
          kind: 'error',
          id: `err-${Date.now()}`,
          message: ev.error.message,
          sessionExpired: isSessionExpiredError(ev.error),
        },
      ];
  }
}

function findLastAssistant(
  entries: InvestigatorTranscriptEntry[],
  turnId: string,
): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'assistant' && e.turnId === turnId) return i;
  }
  return -1;
}

/**
 * Scrub any occurrences of `{% present_investigation_summary {...} %}`
 * text that the agent sometimes emits as plain text instead of
 * calling the tool properly. Returns the cleaned text (for the
 * assistant bubble) and an array of parsed summaries (to render as
 * Summary cards inline).
 *
 * This is a belt-and-suspenders fallback: seed prompts instruct the
 * agent to CALL the tool, but LLMs occasionally improvise this
 * template-literal format, and we don't want the user to see raw
 * JSON dumps in a pretty chat UI.
 */
function scrubTemplateSummaries(text: string): {
  cleaned: string;
  summaries: SummaryUi[];
} {
  const summaries: SummaryUi[] = [];
  // Two flavors seen in the wild:
  //   {% present_investigation_summary {...} %}
  //   {% present_investigation_summary("findings":[...]) %}
  // Match the tool name, then a balanced JSON object up to `%}`.
  const regex = /\{%\s*present_investigation_summary\s+(\{[\s\S]*?\})\s*%\}/g;
  let cleaned = text;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      const findings: Array<{ category: string; details: string }> = [];
      if (Array.isArray(obj.findings)) {
        for (const f of obj.findings) {
          findings.push({
            category: typeof f.category === 'string' ? f.category : 'Finding',
            details: typeof f.details === 'string' ? f.details : '',
          });
        }
      }
      summaries.push({
        kind: 'summary',
        findings,
        conclusion: typeof obj.conclusion === 'string' ? obj.conclusion : '',
      });
      cleaned = cleaned.replace(m[0], '').trim();
    } catch {
      /* leave the raw template in place if parsing fails */
    }
  }
  return { cleaned, summaries };
}
