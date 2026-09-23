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
}

/** Key names whose values are never shown. Matched case-insensitively and
 *  by substring, so `sharedCellToken` and `x-api-key` both land. */
const SECRET_KEY = /(token|secret|password|authorization|credential|apikey|api_key|bearer)/i;
/** Fields carrying image bytes. Replaced by a length, so a reader can still
 *  see that an image was attached and how big it was. */
const IMAGE_KEY = /^(data|image|images|b64|base64)$/i;

export class SessionDiagnostics {
  private frames: Array<{ seq: number; ev: unknown }> = [];
  private dropped = 0;
  private status: SessionStatus | null = null;
  private execution: SessionExecution | null = null;
  private cursor = 0;

  constructor(private readonly limit: number = DEFAULT_LIMIT) {}

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
