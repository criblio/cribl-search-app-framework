/**
 * Run ONE request against a session and report what actually happened.
 *
 * This is the layer every consumer was writing badly. The observed defect:
 * an app's `sendClassificationPhoto` returned `Promise<void>`, discarding
 * the receipt `sendImageMessage` had just handed it. It then observed from
 * seq 0 with no `requestId` and stopped as soon as any answer existed. A
 * replay proved it could accept the *create* request's "no image attached"
 * response while the image request was still running — a confident,
 * well-formed, entirely wrong answer.
 *
 * Every part of that is prevented here by construction:
 *
 *  - the receipt is the input, not a discarded return value;
 *  - the cursor starts at the caller's consumed position, not 0;
 *  - completion is the receipt's terminal state AND a cursor drained
 *    through its `finalSeq` — never `idle`, never `assistantDone`, never
 *    "an answer exists";
 *  - the outcome is explicit, so "no answer" cannot be mistaken for one.
 *
 * Domain parsing stays OUT. This returns the transcript and a generic
 * conclusion; whether "NOT HOT DOG" means what the caller hopes is the
 * caller's business.
 */
import type { SessionExecution } from '@criblio/agent-protocol';
import { applyLoopEvent, type InvestigatorTranscriptEntry } from '../investigator/transcript.js';
import { conclusionFromEntries, type Conclusion } from '../investigator/conclusion.js';
import type { GoatTownClient, MessageImage } from './client.js';
import type { DiagnosticSink } from './diagnostics.js';
import { GoatTownError, MalformedResponseError } from './errors.js';
import { observeSession, type ObserveResult } from './observe.js';

/**
 * How a request ended.
 *
 * `completed` is the only value that means the service finished the work
 * and this consumer read all of it. Everything else names a distinct
 * situation the caller must handle differently, which is the whole reason
 * this is not a boolean.
 */
export type RequestOutcome =
  /** Terminal receipt `complete`, drained through finalSeq. */
  | 'completed'
  /** Terminal receipt `failed`. Diagnostics are drained; the transcript
   *  holds whatever the run produced before it failed. */
  | 'failed'
  /** Terminal receipt `stopped` — someone cancelled the turn. */
  | 'stopped'
  /** The caller aborted. Nothing is known about the service's state. */
  | 'aborted'
  /** Transport gave up: a routing failure, a rejected credential, a
   *  malformed body. NOT a model answer, and never reported as one. */
  | 'transport-error'
  /** The service tracks no receipt for this request (legacy, or no
   *  `session-execution` capability). Observation fell back to a terminal
   *  SESSION status, which is weaker evidence — named rather than
   *  laundered into `completed`. */
  | 'untracked'
  /** A terminal receipt promised events through `finalSeq` that never
   *  arrived. A real failure; deliberately not success. */
  | 'stalled';

export interface RequestResult {
  outcome: RequestOutcome;
  /** The receipt this run followed. Retained on EVERY outcome, including
   *  failures, so a caller can resume observation rather than resend — a
   *  resend is a second request against a session that may already be
   *  answering the first. */
  requestId: string;
  /** Last consumed seq. Pass as `since` to resume. */
  cursor: number;
  /** The receipt as last seen, or null when the service tracks none. */
  execution: SessionExecution | null;
  /** Entries folded from this request's events only. */
  entries: InvestigatorTranscriptEntry[];
  /** Report/summary conclusion, else assistant prose, else `source:'none'`.
   *  Present on any outcome — a failed run may still have said something
   *  useful before it failed. */
  conclusion: Conclusion;
  /** Set when `outcome` is 'transport-error'. */
  error?: Error;
}

export interface RunRequestOptions {
  /** Receipt to follow. From `createSession` or `sendMessage`. */
  requestId: string;
  /** Consumed seq to resume from (exclusive). Defaults to 0 for a fresh
   *  session; pass the previous result's `cursor` to continue. */
  since?: number;
  /** Seed entries so the conclusion is read against the full transcript.
   *  Defaults to empty — this request's events alone. */
  entries?: InvestigatorTranscriptEntry[];
  intervalMs?: number;
  signal?: AbortSignal;
  onEvent?: (entries: InvestigatorTranscriptEntry[]) => void;
  onUserMessage?: (content: string, seq: number, imageCount: number) => void;
  onDiagnostic?: DiagnosticSink;
  isHidden?: () => boolean;
}

/**
 * Observe one receipt to a definite end.
 *
 * Never throws for a service-side outcome — a failed or stalled request is
 * a `RequestResult`, not an exception, because the transcript and cursor
 * are exactly what the caller needs in those cases. Only a programming
 * error (an unknown receipt) propagates.
 */
export async function runRequest(
  client: GoatTownClient,
  sessionId: string,
  opts: RunRequestOptions,
): Promise<RequestResult> {
  let entries = opts.entries ?? [];
  let execution: SessionExecution | null = null;
  let cursor = opts.since ?? 0;

  const base = (): Omit<RequestResult, 'outcome'> => ({
    requestId: opts.requestId,
    cursor,
    execution,
    entries,
    conclusion: conclusionFromEntries(entries),
  });

  let observed: ObserveResult;
  try {
    observed = await observeSession(client, sessionId, {
      requestId: opts.requestId,
      since: cursor,
      intervalMs: opts.intervalMs,
      signal: opts.signal,
      isHidden: opts.isHidden,
      onEvent: (ev) => {
        entries = applyLoopEvent(entries, ev);
        opts.onEvent?.(entries);
      },
      onUserMessage: opts.onUserMessage,
      onExecution: (next) => { execution = next; },
    });
    cursor = observed.cursor;
  } catch (error) {
    // A transport failure is not a model answer. Keeping them apart is the
    // difference between "the agent could not tell" and "we never asked".
    if (error instanceof GoatTownError || error instanceof MalformedResponseError) {
      return { ...base(), outcome: 'transport-error', error };
    }
    throw error;
  }

  cursor = observed.cursor;
  execution = observed.execution;

  if (observed.reason === 'aborted') return { ...base(), outcome: 'aborted' };
  if (observed.reason === 'stalled') return { ...base(), outcome: 'stalled' };
  if (observed.reason === 'terminal-status') {
    // No receipt existed. The session reached a terminal status, which is
    // real but weaker evidence than a drained receipt; say so rather than
    // promoting it to `completed`.
    return { ...base(), outcome: 'untracked' };
  }

  // reason === 'drained'. The receipt's own state decides the outcome; a
  // drained `failed` is still a failure, however much the transcript holds.
  switch (execution?.state) {
    case 'complete': return { ...base(), outcome: 'completed' };
    case 'failed': return { ...base(), outcome: 'failed' };
    case 'stopped': return { ...base(), outcome: 'stopped' };
    default:
      // Drained without a terminal receipt state: the service reported
      // something this version does not understand. Not success.
      return { ...base(), outcome: 'untracked' };
  }
}

/** Input for {@link sendAndRun}. */
export interface SendRequestInput {
  content: string;
  /** Raw base64, no `data:` prefix. Validated locally before sending. */
  images?: MessageImage[];
}

/**
 * Send a message and observe exactly the receipt it returns.
 *
 * The one-call form that makes the original defect impossible to write:
 * the receipt cannot be discarded, because the send and the observation
 * are the same call.
 */
export async function sendAndRun(
  client: GoatTownClient,
  sessionId: string,
  input: SendRequestInput,
  opts: Omit<RunRequestOptions, 'requestId'>,
): Promise<RequestResult> {
  const receipt = input.images?.length
    ? await client.sendImageMessage(sessionId, input.content, input.images, opts.signal)
    : await client.sendMessage(sessionId, input.content, opts.signal);
  return runRequest(client, sessionId, { ...opts, requestId: receipt.requestId });
}
