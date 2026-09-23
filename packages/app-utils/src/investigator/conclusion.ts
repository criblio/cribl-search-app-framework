/**
 * Read an agent's final answer out of a rendered transcript.
 *
 * Every consumer needs this and the obvious implementation is wrong. When an
 * agent concludes by calling a report or summary tool — which is the
 * recommended pattern, and what the tool exists for — the verdict lives in
 * the tool RESULT. An extractor that scans assistant entries returns an
 * empty string precisely when the agent did the right thing, and an empty
 * answer parses downstream as "couldn't tell" while the session looks
 * perfect in GoatTown.
 *
 * So tool conclusions are read first, assistant prose second, and both are
 * read rather than one replacing the other.
 */
import type {
  InvestigatorTranscriptEntry,
  InvestigatorToolCallEntry,
} from './InvestigatorTranscript.js';

/** Where a conclusion was found. Callers surface this in diagnostics: "no
 *  answer" and "answer from prose" are different problems. */
export type ConclusionSource = 'report' | 'summary' | 'assistant' | 'none';

export interface Conclusion {
  /** The answer text, or `''` when the transcript carries none. */
  text: string;
  source: ConclusionSource;
  /** A report's one-line headline, when it had one. */
  headline: string;
  /** How many entries were considered, for diagnostics on an empty answer. */
  entryCount: number;
}

const EMPTY: Conclusion = { text: '', source: 'none', headline: '', entryCount: 0 };

/**
 * Derive the conclusion from folded transcript entries.
 *
 * Scans backwards: the last report or summary is the agent's final word,
 * and an investigation may legitimately produce several.
 */
export function conclusionFromEntries(
  entries: readonly InvestigatorTranscriptEntry[],
): Conclusion {
  if (entries.length === 0) return EMPTY;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind !== 'toolCall') continue;
    const found = fromToolCall(entry as InvestigatorToolCallEntry);
    if (found) return { ...found, entryCount: entries.length };
  }

  // No tool conclusion. Fall back to the last completed assistant message —
  // an agent without a report tool answers in prose, and that is a real
  // answer rather than a degraded one.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind !== 'assistant') continue;
    const text = entry.content.trim();
    if (text) {
      return { text, source: 'assistant', headline: '', entryCount: entries.length };
    }
  }

  return { ...EMPTY, entryCount: entries.length };
}

/** Pull a conclusion out of one tool result, keyed on the payload's `kind`
 *  rather than the tool's name — the framework cannot know what a given host
 *  calls its report tool. */
function fromToolCall(
  entry: InvestigatorToolCallEntry,
): Omit<Conclusion, 'entryCount'> | null {
  const ui = entry.result?.ui;
  if (!ui || typeof ui !== 'object') return null;
  const payload = ui as { kind?: unknown; headline?: unknown; report?: unknown; conclusion?: unknown };

  if (payload.kind === 'report') {
    const headline = typeof payload.headline === 'string' ? payload.headline.trim() : '';
    const body = typeof payload.report === 'string' ? payload.report.trim() : '';
    // Both halves, headline first: the headline is usually the verdict a
    // caller wants to parse, and the body is the evidence for it. Returning
    // only the body buries the answer; only the headline discards the
    // reasoning.
    const text = [headline, body].filter(Boolean).join('\n\n');
    return text ? { text, source: 'report', headline } : null;
  }

  if (payload.kind === 'summary') {
    const conclusion = typeof payload.conclusion === 'string' ? payload.conclusion.trim() : '';
    return conclusion ? { text: conclusion, source: 'summary', headline: conclusion } : null;
  }

  return null;
}
