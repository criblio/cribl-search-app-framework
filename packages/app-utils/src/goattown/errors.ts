/**
 * Typed errors for the GoatTown session client.
 *
 * Callers need to branch on *why* a call failed — a 429 is retried, a 422
 * `image_input_unavailable` must be surfaced rather than silently retried as
 * text, and an unknown receipt is a caller bug rather than a transient fault.
 * A bare `Error` with a formatted string forces every consumer to re-parse
 * the status out of the message, which is how "retry on anything" gets
 * written.
 */

/** A structured failure from the GoatTown service. */
export class GoatTownError extends Error {
  readonly status: number;
  /** Service-supplied machine code, when the body carried one. */
  readonly code: string | null;
  /** Seconds the service asked us to wait, from `retry-after`. */
  readonly retryAfterSeconds: number | null;
  readonly body: string;

  constructor(
    status: number,
    message: string,
    opts: { code?: string | null; retryAfterSeconds?: number | null; body?: string } = {},
  ) {
    super(message);
    this.name = 'GoatTownError';
    this.status = status;
    this.code = opts.code ?? null;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
    this.body = opts.body ?? '';
  }

  /** Throttled. The only status this client waits on and retries. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /**
   * The session's model cannot accept images.
   *
   * Deliberately its own predicate: the temptation on a 422 here is to drop
   * the attachments and resend the text, which produces a confident answer
   * about an image the model never saw.
   */
  get isImageInputUnavailable(): boolean {
    return this.status === 422 && this.code === 'image_input_unavailable';
  }

  /** The requestId named in an observation is not a receipt this session
   *  knows. Never a retry — the caller is observing the wrong thing. */
  get isUnknownReceipt(): boolean {
    return this.status === 404 && this.code === 'execution_not_found';
  }
}

/** Local rejection before anything is sent. Separate from GoatTownError so a
 *  caller can tell "we refused" from "the service refused". */
export class ImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageInputError';
  }
}

/** Parse `retry-after`, which the service sends in seconds. Missing or
 *  unparseable yields null so the caller applies its own backoff rather than
 *  busy-looping on a header it could not read. */
export function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  // HTTP allows an absolute date here; convert it to a delay rather than
  // ignoring it.
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, (at - Date.now()) / 1000);
}

/** Build a GoatTownError from a failed response, lifting `code` out of a
 *  JSON body when there is one. The raw body is retained either way — an
 *  unparseable error body is still the most useful thing to show. */
export async function errorFromResponse(response: Response): Promise<GoatTownError> {
  const body = await response.text().catch(() => '');
  let code: string | null = null;
  let message = '';
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown; message?: unknown };
    if (typeof parsed.code === 'string') code = parsed.code;
    if (typeof parsed.error === 'string') message = parsed.error;
    else if (typeof parsed.message === 'string') message = parsed.message;
  } catch {
    /* not JSON; the raw body below is the message */
  }
  return new GoatTownError(
    response.status,
    message || `GoatTown ${response.status}: ${body.slice(0, 500)}`,
    { code, retryAfterSeconds: retryAfterSeconds(response.headers), body },
  );
}
