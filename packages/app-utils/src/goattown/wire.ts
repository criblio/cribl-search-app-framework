/**
 * Wire ⇄ framework mapping for GoatTown sessions.
 *
 * The service speaks a JSON-safe mirror of the framework's `LoopEvent`
 * union. Two kinds do not map one-to-one, and both have bitten a consumer:
 *
 *  - `error` carries `message: string` on the wire and `error: Error` in the
 *    framework. `applyLoopEvent` and the error card read `ev.error.message`,
 *    so a wire event passed through unconverted renders an empty banner.
 *  - `userMessage` is wire-only. It is the caller's own turn and belongs to
 *    whatever optimistic/replayed user entry the app renders; feeding it to
 *    `applyLoopEvent` does nothing, silently, because the reducer has no
 *    case for it.
 *
 * Every other kind is already structurally a LoopEvent and is passed through
 * rather than rebuilt field-by-field, so a service that adds a field to an
 * existing kind does not need a change here.
 *
 * No field-name heuristics live in this file on purpose. "Looks like an
 * event because it has a `kind`" is how an envelope (`{seq, ev}`) ends up
 * being fed to a reducer as though it were the event.
 */
import type { WireLoopEvent, SessionEventWindow } from '@criblio/agent-protocol';
import type { LoopEvent } from '../agent-loop.js';
import type { ToolResultUi } from '../agent-tools.js';

/** One consumed frame: the service's sequence identity plus its event. */
export interface SessionFrame {
  seq: number;
  ev: WireLoopEvent;
}

/**
 * Convert a wire event to a framework LoopEvent.
 *
 * Returns `null` for `userMessage` (wire-only, see the module note) and for
 * any kind this version does not know, so a newer service can add event
 * kinds without breaking an older consumer. Callers that need the user's
 * turns read them from the frame directly — see `isUserMessageFrame`.
 */
export function wireEventToLoopEvent(ev: WireLoopEvent): LoopEvent | null {
  switch (ev.kind) {
    case 'error':
      // The one genuine conversion.
      return { kind: 'error', error: new Error(ev.message) };
    case 'userMessage':
      return null;
    case 'toolResult':
      // `ui` is `unknown` on the wire because the service passes whatever
      // the executor produced straight through. It was produced by a real
      // executor, so the shape is already a card payload; narrow rather
      // than validate, and let an unknown `kind` fall through to the app's
      // own renderToolCard.
      return {
        kind: 'toolResult',
        turnId: ev.turnId,
        result: { ...ev.result, ui: ev.result.ui as ToolResultUi | undefined },
      };
    case 'done':
      return { kind: 'done', reason: ev.reason === 'aborted' ? 'aborted' : 'complete' };
    case 'assistantText':
    case 'assistantDone':
    case 'toolCall':
    case 'notification':
      return ev;
    default:
      return null;
  }
}

/** Is this frame the user's own turn? Those render through the caller's user
 *  entry, never through `applyLoopEvent`. */
export function isUserMessageFrame(
  frame: SessionFrame,
): frame is SessionFrame & { ev: Extract<WireLoopEvent, { kind: 'userMessage' }> } {
  return frame.ev.kind === 'userMessage';
}

/**
 * The event collection carried by an observation response, or `null` when
 * the response carries none.
 *
 * Three shapes are read, all of them explicitly:
 *   - `eventWindow.frames`  — combined GET /status?eventsSince=N
 *   - `frames`              — authoritative GET /events?since=N
 *   - `events`              — a captured legacy collection, same envelope
 *
 * `null` (no collection at all) is deliberately distinct from `[]` (a
 * collection that is empty right now). The first means this route cannot
 * serve events and the caller should switch to /events permanently; the
 * second means there is simply nothing new. Collapsing them sends a caller
 * back to /status forever, polling a route that will never answer.
 */
export function readEventCollection(payload: unknown): SessionFrame[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as {
    eventWindow?: Partial<SessionEventWindow>;
    frames?: unknown;
    events?: unknown;
  };
  const windowFrames = body.eventWindow?.frames;
  if (Array.isArray(windowFrames)) return windowFrames.filter(isFrame);
  if (Array.isArray(body.frames)) return body.frames.filter(isFrame);
  if (Array.isArray(body.events)) return body.events.filter(isFrame);
  return null;
}

/** An envelope is `{seq, ev}`. Checked structurally so a bare event — which
 *  has a `kind` but no `seq` — can never be mistaken for one. */
function isFrame(value: unknown): value is SessionFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as { seq?: unknown; ev?: unknown };
  return typeof frame.seq === 'number'
    && !!frame.ev
    && typeof frame.ev === 'object'
    && typeof (frame.ev as { kind?: unknown }).kind === 'string';
}
