/**
 * Wire protocol between a cell — a server-side agent harness running
 * on celld — and the app UI that renders its sessions.
 *
 * This is the single source of truth for the shapes both sides speak.
 * It replaces two hand-maintained mirrors (the APM cell's protocol.ts
 * and the app's investigationTransport.ts local types) whose headers
 * both said "converge me"; consumers now import from here and drift
 * is a compile error.
 *
 * `WireLoopEvent` structurally mirrors the app-utils `LoopEvent`
 * union (agent-loop.ts) with two deliberate differences: `error`
 * carries a plain message string instead of an Error instance so it
 * survives JSON, and `userMessage` (not a framework LoopEvent) records
 * the user's side of an interactive conversation so a reopened session
 * replays both sides. Consumers that render transcripts rehydrate wire
 * events back into LoopEvents and feed their existing reducer, which
 * is what makes a server-run transcript render identically to a
 * client-run one. A type-parity test in the consuming app pins the
 * mirror (this package deliberately has no dependency on app-utils).
 *
 * Naming: TYPE names are generic (session, not investigation) because
 * payloads other than the APM investigator run on the same harness.
 * WIRE names — JSON field names like `investigation`, `alertId`,
 * `incidentKey`, and URL paths — are frozen at protocol v1 for
 * compatibility with deployed cells and stored transcripts; a future
 * protocol v2 renames them alongside a PROTOCOL_VERSION bump.
 */

export const PROTOCOL_VERSION = 1;

/** Structural mirror of the app-utils tool-call shape. Carried opaquely
 *  by the wire — the UI only needs to pass it through. */
export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type WireLoopEvent =
  // A user's turn (interactive sessions): the opening prompt or a
  // follow-up message. Recorded as a transcript event so a reopened
  // session replays the user's side of the conversation, not just the
  // assistant's. Not a framework LoopEvent — the UI renders it as a
  // user bubble directly.
  /** `imageCount` records that the user attached screenshots, without
   *  putting their bytes in the event table — a replayed transcript can
   *  then show "2 images" instead of losing them silently. */
  | { kind: 'userMessage'; turnId: string; content: string; imageCount?: number }
  | { kind: 'assistantText'; turnId: string; chunk: string }
  | { kind: 'assistantDone'; turnId: string }
  | {
      kind: 'toolCall';
      turnId: string;
      call: WireToolCall;
      needsApproval: boolean;
    }
  | {
      kind: 'toolResult';
      turnId: string;
      result: { id: string; name: string; content: string; ui?: unknown };
    }
  | { kind: 'notification'; turnId: string; content: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; reason: string };

export type SessionStatus =
  | 'queued'
  | 'running'
  // Interactive sessions only: the loop answered the current user
  // turn and is waiting for the next message. Non-terminal — a new
  // message flips it back to 'running'.
  | 'idle'
  | 'concluded'
  | 'failed'
  | 'cancelled';

/** Terminal states: the loop is done and no alarm is pending. (`idle`
 *  is NOT terminal — an interactive run parks there awaiting a
 *  message.) Terminal states also stop the UI's polling. */
export function isTerminalStatus(status: SessionStatus): boolean {
  return status === 'concluded' || status === 'failed' || status === 'cancelled';
}

/** How a session was started. `autonomous` = a trigger drove it to a
 *  conclusion; `interactive` = a user started it from the UI and can
 *  keep chatting (see the 'idle' status). */
export type SessionMode = 'autonomous' | 'interactive';

/** One row of the session index (the UI's recall panel).
 *  `alertId`/`incidentKey` are wire-frozen v1 names for the payload's
 *  subject id and group key. */
export interface SessionSummaryRow {
  id: string;
  alertId: string;
  incidentKey: string;
  status: SessionStatus;
  /** Human-readable label. For interactive sessions it's derived from
   *  the user's opening prompt; for autonomous ones it falls back to
   *  the group key. */
  title: string;
  mode: SessionMode;
  createdAt: number;
  startedAt: number | null;
  concludedAt: number | null;
}

/** A source repo the agent may check out. `service` maps it to a
 *  telemetry service; `*`/undefined = monorepo catch-all. */
export interface SourceRepo {
  url: string;
  name?: string;
  service?: string;
  ref?: string;
}

/** Body for a UI-initiated (interactive) session. */
export interface CreateSessionBody {
  prompt: string;
  context?: { service?: string; earliest?: string; latest?: string } | null;
  title?: string;
  /** Repos the agent may check out (from app Settings). Falls back to
   *  the cell's REPOS_JSON env when absent. */
  repos?: SourceRepo[];
}

/** Derive a short recall-panel title from a free-form prompt. */
export function titleFromPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine || 'Investigation';
}

/** The small seed blob the cell stores and serves (NOT the full seed
 *  prompt). `question` carries the opening prompt of an interactive
 *  session so a reopened conversation can replay it; payloads may add
 *  fields of their own. */
export interface SessionSeed {
  question?: string;
  [k: string]: unknown;
}

/** Frames the cell's WebSocket surface sends. The `investigation`
 *  field name is wire-frozen at v1 (see the header note on naming). */
export type ServerFrame =
  | {
      type: 'hello';
      protocolVersion: number;
      investigation: {
        id: string;
        status: SessionStatus;
        seed: unknown;
        alertId: string;
        createdAt: number;
        concludedAt: number | null;
      };
      latestSeq: number;
    }
  | { type: 'event'; seq: number; ev: WireLoopEvent }
  | { type: 'status'; status: SessionStatus }
  | { type: 'ping' };

/** Response of the cell's poll transport (GET …/events?since=N —
 *  the primary UI transport; the iframe CSP blocks WebSockets). */
export interface EventsResponse {
  protocolVersion: number;
  status: SessionStatus;
  latestSeq: number;
  frames: Array<{ seq: number; ev: WireLoopEvent }>;
}

/** Response of GET …/status. */
export interface SessionStatusResponse {
  id: string;
  status: SessionStatus;
  mode?: SessionMode;
  title?: string | null;
  alertId: string;
  incidentKey: string;
  createdAt: number;
  startedAt: number | null;
  concludedAt: number | null;
  seed?: SessionSeed | null;
  conclusion: unknown | null;
  latestSeq: number;
}
