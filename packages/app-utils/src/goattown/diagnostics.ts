/**
 * Bounded, redacted capture of what a session actually sent back.
 *
 * When an app reports "the answer was empty but GoatTown looks fine", the
 * only thing that settles it is the raw frames. So the client can record
 * them — but a raw transcript is exactly where credentials and multi-megabyte
 * image payloads live, and a disclosure that dumps those is one screenshot
 * away from leaking a token into a bug report.
 *
 * Hence: a ring buffer with a hard cap, image bytes replaced by their
 * length, and anything that looks like a credential replaced by a marker.
 */
import type { SessionExecution, SessionStatus } from '@criblio/agent-protocol';
import type { SessionFrame } from './wire.js';

/**
 * One recorded interaction. Deliberately narrow: enough to tell a routing
 * failure from a model answer, and nothing that could carry a secret.
 *
 * What is NOT here is the point — no headers (so no Authorization, no
 * cookies), no request bodies (so no image bytes and no KV values), and no
 * raw URL (so no query or path secrets). `path` is the route SHAPE with
 * ids replaced, which is what actually identifies a misroute.
 */
export interface DiagnosticEvent {
  at: number;
  /** Route family: 'status', 'events', 'messages', 'protocol', … */
  op: string;
  method: string;
  /** Route shape with dynamic segments and every query VALUE removed. */
  path: string;
  status?: number;
  /** Decisive for the failure this exists to catch: an HTML body on a
   *  JSON route is a proxy misroute, not an empty result. */
  contentType?: string | null;
  /** Which event collection the response carried, or 'absent'. */
  collection?: 'eventWindow.frames' | 'frames' | 'events' | 'absent';
  requestId?: string;
  cursor?: number;
  finalSeq?: number | null;
  executionState?: SessionExecution['state'];
  /** Message only — never a body, never a value. */
  error?: string;
}

/** Called for each interaction. Wired through the client and observer so an
 *  app never has to wrap `fetch` to see what happened. */
export type DiagnosticSink = (event: DiagnosticEvent) => void;

/** Opaque id segments in the session routes. */
const ID_SEGMENT = /^[0-9a-f]{8,}$|^[A-Za-z0-9_-]{16,}$/;

/**
 * Reduce a URL to its route shape.
 *
 * Path ids become `:id` and every query value is dropped while its key is
 * kept — a caller needs to know that `requestId` was sent, not what it was.
 * Ids are not usually secret, but a signed ticket in a path is, and the
 * shape is what identifies a misroute anyway.
 */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw, 'https://redacted.invalid');
  } catch {
    return '(unparseable url)';
  }
  const path = url.pathname.split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
  const keys = [...new Set([...url.searchParams.keys()])];
  return keys.length > 0 ? `${path}?${keys.map((k) => `${k}=…`).join('&')}` : path;
}

/** Route family from a path, for grouping. */
export function operationOf(path: string): string {
  const match = /\/investigations(?:\/[^/?]+)?\/?([^/?]*)/.exec(path);
  if (match) return match[1] || 'investigations';
  return path.replace(/^\//, '').split(/[/?]/)[0] || 'root';
}

/** Frames retained. Enough to see a whole short session; small enough that
 *  the buffer cannot become the memory problem. */
const DEFAULT_LIMIT = 200;
/** Per-string ceiling in the redacted output. */
const MAX_STRING = 2000;

export interface DiagnosticSnapshot {
  status: SessionStatus | null;
  execution: SessionExecution | null;
  cursor: number;
  /** Frames seen, newest last, already redacted. */
  frames: Array<{ seq: number; ev: unknown }>;
  /** Frames dropped from the front of the ring. */
  dropped: number;
  /** Recorded interactions, newest last. */
  events: DiagnosticEvent[];
  /** Interactions dropped from the front of the ring. */
  droppedEvents: number;
}

/** Key names whose values are never shown. Matched case-insensitively and
 *  by substring, so `sharedCellToken` and `x-api-key` both land. */
const SECRET_KEY = /(token|secret|password|authorization|credential|apikey|api_key|bearer)/i;
/** Fields carrying image bytes. Replaced by a length, so a reader can still
 *  see that an image was attached and how big it was. */
const IMAGE_KEY = /^(data|image|images|b64|base64)$/i;

export class SessionDiagnostics {
  private frames: Array<{ seq: number; ev: unknown }> = [];
  private events: DiagnosticEvent[] = [];
  private dropped = 0;
  private droppedEvents = 0;
  private status: SessionStatus | null = null;
  private execution: SessionExecution | null = null;
  private cursor = 0;

  constructor(private readonly limit: number = DEFAULT_LIMIT) {}

  /** Pass this as the client's / observer's `onDiagnostic`. */
  get sink(): DiagnosticSink {
    return (event) => this.record(event);
  }

  record(event: DiagnosticEvent): void {
    this.events.push(event);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
      this.droppedEvents += 1;
    }
  }

  recordFrame(frame: SessionFrame): void {
    this.frames.push({ seq: frame.seq, ev: redact(frame.ev) });
    this.cursor = Math.max(this.cursor, frame.seq);
    if (this.frames.length > this.limit) {
      this.frames.splice(0, this.frames.length - this.limit);
      this.dropped += 1;
    }
  }

  recordStatus(status: SessionStatus): void {
    this.status = status;
  }

  recordExecution(execution: SessionExecution): void {
    this.execution = execution;
  }

  snapshot(): DiagnosticSnapshot {
    return {
      status: this.status,
      execution: this.execution,
      cursor: this.cursor,
      frames: this.frames.slice(),
      dropped: this.dropped,
      events: this.events.slice(),
      droppedEvents: this.droppedEvents,
    };
  }

  /** Pretty JSON for a disclosure element or a bug report. */
  toText(): string {
    return JSON.stringify(this.snapshot(), null, 2);
  }
}

/**
 * Deep-copy a value, replacing secrets and image bytes.
 *
 * Redacts on the KEY rather than by sniffing values: a heuristic that looks
 * for long base64-ish strings also eats legitimate content, and misses a
 * short token entirely.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[…depth]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[${value.length} chars]` : value;
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (IMAGE_KEY.test(key) && typeof entry === 'string') {
      out[key] = `[image ${entry.length} base64 chars]`;
      continue;
    }
    out[key] = redact(entry, depth + 1);
  }
  return out;
}
