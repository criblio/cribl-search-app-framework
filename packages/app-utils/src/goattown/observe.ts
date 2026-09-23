/**
 * Observe a GoatTown session: poll, dedupe, and know when it is finished.
 *
 * Knowing when to stop is the hard part, and every intuitive answer is
 * wrong:
 *
 *  - `idle` is NOT completion. It means "between turns", and a session is
 *    idle before the first turn as well as after the last one. Treating it
 *    as done ends observation before the answer arrives, which reads
 *    downstream as an empty answer rather than as an error.
 *  - `assistantDone` ends one assistant MESSAGE, not a request. One request
 *    can span several tool/model rounds.
 *  - A terminal receipt is not the same as a consumed one. The service
 *    commits `complete` with the final events; the caller still has to read
 *    through `finalSeq`. A page bounded at 100 frames means the last page
 *    of a completed request often arrives after the state flips.
 *
 * So completion is: a terminal execution receipt AND a local cursor that has
 * reached its `finalSeq`. Sessions with no receipt (legacy, or a service
 * without `session-execution`) get an explicitly labelled compatibility path
 * that stops on a terminal SESSION status — never on idle.
 */
import type { SessionExecution, SessionStatus } from '@criblio/agent-protocol';
import { isExecutionDrained, isTerminalStatus } from '@criblio/agent-protocol';
import type { LoopEvent } from '../agent-loop.js';
import { GoatTownError } from './errors.js';
import type { GoatTownClient, SessionSnapshot } from './client.js';
import { isUserMessageFrame, wireEventToLoopEvent, type SessionFrame } from './wire.js';

export interface ObserveOptions {
  /** Poll cadence while work is in flight (ms). */
  intervalMs?: number;
  /** Start from this consumed seq (exclusive). Default 0 — the whole
   *  transcript, which is what a reopened session wants. */
  since?: number;
  /**
   * Observe one specific request receipt.
   *
   * With it, observation follows that receipt even if another message
   * arrives meanwhile. Without it, the service reports the latest accepted
   * request, which is the right default for a UI following a live session.
   */
  requestId?: string;
  /** Each framework event, in seq order. */
  onEvent?: (ev: LoopEvent, seq: number) => void;
  /** Each user turn. Wire-only — NOT a LoopEvent, and must not be fed to
   *  `applyLoopEvent`. */
  onUserMessage?: (content: string, seq: number, imageCount: number) => void;
  onStatus?: (status: SessionStatus) => void;
  onExecution?: (execution: SessionExecution) => void;
  /** Transport errors. Polling continues — a single failed poll is not a
   *  failed session. */
  onError?: (error: unknown) => void;
  /** Abort observation. */
  signal?: AbortSignal;
  /**
   * Is the page currently hidden? Polling pauses while it is, so a
   * backgrounded tab does not keep a session warm for hours. Defaults to
   * `document.visibilityState`, and to "always visible" outside a browser.
   */
  isHidden?: () => boolean;
}

export interface ObserveResult {
  /** Why observation ended. `drained` is the only one that means the
   *  response was fully consumed. */
  reason: 'drained' | 'terminal-status' | 'aborted';
  status: SessionStatus;
  execution: SessionExecution | null;
  /** Last consumed seq. */
  cursor: number;
  frameCount: number;
}

const DEFAULT_INTERVAL = 2000;
/** Cap on backoff after repeated transport failures. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Poll until the observed request is finished and drained.
 *
 * Polls are serialized by construction — this is a sequential loop, never a
 * timer that can overlap with a slow response. Two concurrent polls both
 * advance the cursor and one of them silently loses frames.
 */
export async function observeSession(
  client: GoatTownClient,
  id: string,
  opts: ObserveOptions = {},
): Promise<ObserveResult> {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL;
  const isHidden = opts.isHidden ?? defaultIsHidden;
  let cursor = opts.since ?? 0;
  let frameCount = 0;
  let status: SessionStatus = 'queued';
  let execution: SessionExecution | null = null;
  let lastStatus: SessionStatus | null = null;
  let failures = 0;
  // Start on the combined route and fall back permanently once it proves it
  // cannot carry events; flapping between the two re-asks a route that has
  // already answered no.
  let useCombined = true;
  /** Highest seq handed to the caller. Dedupe is by service seq only —
   *  never by turnId or text, both of which legitimately repeat. */
  let highestSeq = cursor;

  const finish = (reason: ObserveResult['reason']): ObserveResult =>
    ({ reason, status, execution, cursor, frameCount });

  for (;;) {
    if (opts.signal?.aborted) return finish('aborted');

    if (isHidden()) {
      await delay(interval, opts.signal);
      continue;
    }

    let snapshot: SessionSnapshot;
    try {
      snapshot = useCombined
        ? await client.status(id, { eventsSince: cursor, requestId: opts.requestId, signal: opts.signal })
        : await client.events(id, cursor, { requestId: opts.requestId, signal: opts.signal });
      if (useCombined && !snapshot.carriedEvents) {
        // This route serves status only. Switch for good and re-poll now
        // rather than waiting out an interval on a route we have abandoned.
        useCombined = false;
        continue;
      }
      failures = 0;
    } catch (error) {
      if (opts.signal?.aborted) return finish('aborted');
      // An unknown receipt is a caller error, not a transient one: retrying
      // re-asks a question the service has already answered definitively.
      if (error instanceof GoatTownError && error.isUnknownReceipt) throw error;
      opts.onError?.(error);
      failures += 1;
      const waitMs = error instanceof GoatTownError && error.retryAfterSeconds != null
        ? error.retryAfterSeconds * 1000
        : Math.min(interval * 2 ** (failures - 1), MAX_BACKOFF_MS);
      await delay(waitMs, opts.signal);
      continue;
    }

    status = snapshot.status;
    if (status !== lastStatus) {
      lastStatus = status;
      opts.onStatus?.(status);
    }
    if (snapshot.execution) {
      execution = snapshot.execution;
      opts.onExecution?.(execution);
    }

    const fresh = sortBySeq(snapshot.frames).filter((frame) => frame.seq > highestSeq);
    for (const frame of fresh) {
      highestSeq = frame.seq;
      cursor = frame.seq;
      frameCount += 1;
      if (isUserMessageFrame(frame)) {
        opts.onUserMessage?.(frame.ev.content, frame.seq, frame.ev.imageCount ?? 0);
        continue;
      }
      const loopEvent = wireEventToLoopEvent(frame.ev);
      if (loopEvent) opts.onEvent?.(loopEvent, frame.seq);
    }

    // More pages to drain: keep going without waiting out the interval.
    // A page is bounded at 100 frames, so a completed request routinely has
    // several pages left after its receipt turns terminal.
    if (cursor < snapshot.latestSeq && fresh.length > 0) continue;

    if (execution) {
      if (isExecutionDrained(execution, cursor)) return finish('drained');
      // Terminal receipt whose finalSeq we have not reached: there are
      // events still to read, so poll again immediately.
      if (execution.finalSeq != null && cursor < execution.finalSeq) continue;
    } else if (isTerminalStatus(status)) {
      // Legacy compatibility path: no receipt exists, so a terminal SESSION
      // status is the only completion signal available. Explicitly NOT
      // `idle` — an idle session is between turns and may still answer.
      return finish('terminal-status');
    }

    await delay(interval, opts.signal);
  }
}

/** Frames arrive in order, but sorting makes the cursor rule independent of
 *  that promise — a single out-of-order page would otherwise strand the
 *  cursor below `latestSeq` forever. */
function sortBySeq(frames: SessionFrame[]): SessionFrame[] {
  return [...frames].sort((a, b) => a.seq - b.seq);
}

function defaultIsHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Interruptible sleep. Resolves early on abort so observation stops
 *  promptly rather than after one more full interval. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
