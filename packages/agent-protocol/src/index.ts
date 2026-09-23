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
  /**
   * Opaque, payload-defined blob carried verbatim from this call to
   * `buildInteractiveSeed`'s `InteractiveInput.payload`.
   *
   * The harness never reads it. It exists because every other field on
   * this body is dropped twice on the way in — the coordinator persists
   * only what it names, and the pump forwards only what it names — so a
   * payload that needs its own per-session input (an agent profile, a
   * tool allow-list, a skill set) had nowhere to put it and no clean
   * place to smuggle it.
   *
   * Keep it small: it round-trips through the coordinator's
   * `alert_json` column and the session DO's storage, both of which are
   * read on hot paths. Anything large belongs in the payload's own
   * durable state, keyed by whatever id this blob carries.
   */
  payload?: unknown;
  /**
   * Per-session LLM overrides. Absent fields fall back to the cell's
   * env (`LLM_MODEL`, `LLM_MAX_TOKENS`), which stays the default for
   * every session that doesn't ask for something else.
   *
   * `contextWindow` is deliberately NOT overridable here: it also
   * derives the compaction thresholds, which are read from env on
   * paths that have no session in hand, so a per-session value would
   * be honoured in one place and ignored in the other.
   */
  llm?: SessionLlmOverride;
}

/** The overridable subset of a session's LLM config. */
export interface SessionLlmOverride {
  model?: string;
  maxTokens?: number;
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
  /**
   * Estimated prompt tokens the model was handed on the last turn, and
   * the window it was measured against. Optional because a session that
   * has never run a turn has no estimate, and because a cell on an
   * older harness doesn't report it at all.
   *
   * Read from a stored value rather than recomputed: this route is
   * polled every few seconds and the estimate costs a full scan of the
   * message table. A proxy (≈4 chars per token, images charged flat),
   * not an accounting.
   */
  contextTokens?: number | null;
  contextWindow?: number;
  /** How many times this session has compacted its model history. Zero
   *  is meaningfully different from absent: zero means the cell supports
   *  compaction and has not needed it. */
  compactions?: number;
}

// ─────────────────────────────────────────────────────────────────
// Session execution receipts (capability `session-execution`)
// ─────────────────────────────────────────────────────────────────

/**
 * Durable record of one accepted request.
 *
 * Exists because no session status proves a request finished. `idle` means
 * "between turns" and is reachable before the answer as well as after it;
 * `assistantDone` ends one assistant message, and a single request may span
 * several tool/model rounds. A consumer that waits for either returns an
 * empty answer that looks like a successful one.
 *
 * `finalSeq` is the transcript cursor the terminal states commit with, so a
 * caller can tell whether it has actually consumed the response. `failed`
 * and `stopped` carry it too — diagnostics are part of the outcome and are
 * drained the same way.
 */
export interface SessionExecution {
  requestId: string;
  state: 'queued' | 'running' | 'complete' | 'failed' | 'stopped';
  acceptedAt: number;
  finalSeq: number | null;
}

/** Receipt states that will not change again. */
export type TerminalExecutionState = 'complete' | 'failed' | 'stopped';

/** Has this receipt reached its final state? A terminal receipt still needs
 *  its events drained through `finalSeq` before the outcome is reported. */
export function isTerminalExecution(execution: SessionExecution): boolean {
  return execution.state === 'complete'
    || execution.state === 'failed'
    || execution.state === 'stopped';
}

/**
 * Is the response for this receipt fully consumed?
 *
 * Both halves are required. A terminal state alone means the service is
 * finished writing, not that the caller has read what it wrote; a cursor at
 * `finalSeq` alone can coincide before the request completes.
 */
export function isExecutionDrained(execution: SessionExecution, cursor: number): boolean {
  if (!isTerminalExecution(execution)) return false;
  return execution.finalSeq == null || cursor >= execution.finalSeq;
}

/** Receipt returned by POST /investigations. `requestId` is the literal
 *  string `initial` for the session-creating request. */
export interface CreateSessionReceipt {
  id: string;
  title?: string;
  requestId: string;
}

/** Receipt returned by POST /investigations/:id/messages. HTTP 200 means the
 *  request started; 202 means it was queued behind the current turn. */
export interface SendMessageReceipt {
  ok: true;
  requestId: string;
  pending?: boolean;
}

/**
 * `execution` as it appears on /status and /events.
 *
 * `null` is load-bearing and must never be read as success: it means the
 * session predates receipt tracking or the server does not implement it.
 */
export interface WithExecution {
  execution?: SessionExecution | null;
}

// ─────────────────────────────────────────────────────────────────
// Event windows
// ─────────────────────────────────────────────────────────────────

/** Combined GET /status?eventsSince=N. Absent when no cursor was requested,
 *  and absent on a server that does not carry events on this route — which
 *  is the signal to read /events instead and keep reading it. */
export interface SessionEventWindow {
  since: number;
  frames: Array<{ seq: number; ev: WireLoopEvent }>;
}

// ─────────────────────────────────────────────────────────────────
// Agent image readiness (capability `agent-image-readiness`)
// ─────────────────────────────────────────────────────────────────

/**
 * Configuration-level readiness for image input. Discovery only: no provider
 * call is made, so `providerVerified` is always false.
 *
 * `unknown` is a real answer, not a soft no. An agent overriding the model
 * cannot be confirmed vision-capable from configuration alone, and reporting
 * that as `unavailable` would hide a working setup.
 */
export interface AgentImageReadiness {
  state: 'ready' | 'unavailable' | 'unknown';
  model: string | null;
  source: 'tenant' | 'cell';
  reason: string;
  providerVerified: false;
  sessionCheck: string;
}

/** A row of GET /agents. */
export interface AgentCatalogRow {
  slug: string;
  displayName?: string;
  description?: string;
  imageReadiness?: AgentImageReadiness;
}

// ─────────────────────────────────────────────────────────────────
// Session LLM (GET /investigations/:id/workspace/llm)
// ─────────────────────────────────────────────────────────────────

/**
 * `effective.vision` is the send preflight: it decides whether this session
 * accepts images at all. It is still only configuration — an actual image
 * probe is what verifies the model understands one.
 */
export interface SessionLlmSettings {
  override: { model: string | null; maxTokens: number | null };
  effective: { model: string; maxTokens: number | undefined; vision: boolean } | null;
}

// ─────────────────────────────────────────────────────────────────
// Configuration proposals (GET /protocol → proposalScope)
// ─────────────────────────────────────────────────────────────────

/**
 * The proposal scope a credential is assigned.
 *
 * `producerInput: 'credential'` is the whole point: the producer comes from
 * the credential, so proposal YAML must NOT carry a `producer` field and no
 * second token belongs in the browser. Activation is a human action at
 * `reviewPath`; nothing here activates anything.
 */
export interface AppConfigurationScope {
  appConnectionId: string;
  appId: string;
  producer: string;
  producerInput: 'credential';
  reviewPath: string;
}

/** GET /protocol. Capability strings are open — an older consumer must
 *  ignore names it does not know rather than reject the response. */
export interface ProtocolResponse {
  protocolVersion: number;
  compatibleProtocolVersions?: number[];
  capabilities: string[];
  sessionEvents?: unknown;
  sessionExecution?: unknown;
  agentImageReadiness?: unknown;
  imageInput?: ImageInputContract;
  proposalScope?: AppConfigurationScope | null;
}

/** Advertised image ceilings. Limits count BASE64 CHARACTERS, not decoded
 *  bytes — validating against byte counts accepts payloads the service
 *  rejects. */
export interface ImageInputContract {
  transport: string;
  field: string;
  mimeTypes: string[];
  maxImages: number;
  maxBase64CharsPerImage: number;
  historyMessages?: number;
  maxInlineBase64Chars: number;
}

/** Fallback ceilings for a server that advertises no `imageInput`. Matches
 *  the service defaults at the time of writing; the advertised contract wins
 *  whenever one is available. */
export const DEFAULT_IMAGE_INPUT: ImageInputContract = {
  transport: 'json-base64',
  field: 'images',
  mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  maxImages: 4,
  maxBase64CharsPerImage: 4 * 1024 * 1024,
  historyMessages: 3,
  maxInlineBase64Chars: 10 * 1024 * 1024,
};
