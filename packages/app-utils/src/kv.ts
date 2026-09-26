/**
 * Strict app-KV access.
 *
 * The platform scopes an app's KV namespace at the proxy. App code calls
 * `${apiUrl()}/kvstore/<key>` and the host rewrites it to the scoped path
 * (`/api/v1/a/{appId}/kvstore/<key>`). **Never inject `/a/<appId>`
 * yourself** — that produces a double-scoped path that 404s, and the 404
 * looks exactly like a missing key.
 *
 * Which is the whole problem this module exists to solve. Two very
 * different things arrive as "404":
 *
 *  - a JSON body saying the key is not there — genuine absence, and
 *    falling back to a default is correct;
 *  - an HTML body — the request never reached the KV store at all. The
 *    route is wrong, the proxy is misconfigured, or the session is
 *    unauthenticated. Falling back to a default here silently invents
 *    state, and the app then writes those invented defaults back over
 *    whatever was really stored.
 *
 * So absence is a typed result and a routing failure is a typed error, and
 * no caller has to guess from a status code.
 *
 * Browser storage is never used. A value that is not in the KV store does
 * not exist.
 */
import { apiUrl } from './search.js';

/** KV read outcome. `found: false` means the store answered and the key is
 *  genuinely absent — not that the read failed. */
export type KvResult<T> =
  | { found: true; value: T }
  | { found: false };

/**
 * A KV operation that did not reach, or was rejected by, the store.
 *
 * Distinct from absence on purpose: a caller may substitute defaults for
 * absence, and must not for this.
 */
export class KvError extends Error {
  readonly status: number | null;
  readonly contentType: string | null;
  /** Bounded, shape-only description of the body. Never the body itself —
   *  a KV value can hold anything, including a credential. */
  readonly bodyKind: string;
  readonly key: string;

  constructor(
    message: string,
    opts: { key: string; status?: number | null; contentType?: string | null; bodyKind?: string },
  ) {
    super(message);
    this.name = 'KvError';
    this.key = opts.key;
    this.status = opts.status ?? null;
    this.contentType = opts.contentType ?? null;
    this.bodyKind = opts.bodyKind ?? 'unknown';
  }

  /** The response was HTML, so the request fell through to the web shell
   *  instead of reaching the KV store. A routing or auth problem. */
  get isRoutingFailure(): boolean {
    return this.bodyKind === 'html';
  }
}

/** Classify a body without retaining it. */
function bodyKind(text: string, contentType: string | null): string {
  if (contentType?.includes('html')) return 'html';
  const head = text.trimStart().slice(0, 64).toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  if (contentType?.includes('json')) return 'json';
  try {
    JSON.parse(text);
    return 'json';
  } catch {
    return text.length === 0 ? 'empty' : 'text';
  }
}

/**
 * Is this response the KV store's actual missing-key answer?
 *
 * Narrow on purpose. The previous test matched /not\s*found/i against ANY
 * non-OK body, which reported a 403 `{"message":"User not found"}` as
 * absent data — an authorization failure laundered into "no value yet",
 * after which the app writes defaults over a store it was never allowed to
 * read. A 500 mentioning "upstream not found" fell into the same hole.
 *
 * Absence now requires all three: status 404, a JSON body, and the
 * store's explicit key-missing discriminator. Anything else is a KvError.
 */
function isKeyMissing(status: number, kind: string, text: string): boolean {
  if (status !== 404 || kind !== 'json') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const message = (parsed as { message?: unknown }).message;
  return typeof message === 'string' && /^key not found$/i.test(message.trim());
}

function kvUrl(key: string): string {
  return `${apiUrl()}/kvstore/${key}`;
}

/**
 * Read a JSON value.
 *
 * Absence yields `{found: false}`. Anything else — a misroute, a rejected
 * credential, an unparseable body — throws `KvError`.
 */
export async function kvGetJson<T>(key: string, signal?: AbortSignal): Promise<KvResult<T>> {
  let response: Response;
  try {
    response = await fetch(kvUrl(key), { signal, headers: { accept: 'application/json' } });
  } catch (error) {
    throw new KvError(`KV read of ${key} failed before reaching the store: ${
      error instanceof Error ? error.message : String(error)}`, { key });
  }
  const contentType = response.headers.get('content-type');
  const text = await response.text().catch(() => '');
  const kind = bodyKind(text, contentType);

  if (kind === 'html') {
    throw new KvError(
      `KV read of ${key} returned HTML (${response.status}), so it never reached the KV store. ` +
      'Check that the app calls `${apiUrl()}/kvstore/<key>` and does not inject its own ' +
      '/a/<appId> segment, which double-scopes the path.',
      { key, status: response.status, contentType, bodyKind: kind },
    );
  }
  if (!response.ok) {
    if (isKeyMissing(response.status, kind, text)) return { found: false };
    throw new KvError(
      `KV read of ${key} failed with ${response.status}`,
      { key, status: response.status, contentType, bodyKind: kind },
    );
  }
  if (kind === 'empty') return { found: false };
  try {
    return { found: true, value: JSON.parse(text) as T };
  } catch {
    throw new KvError(
      `KV read of ${key} returned a ${kind} body that is not JSON`,
      { key, status: response.status, contentType, bodyKind: kind },
    );
  }
}

/**
 * Write a JSON value.
 *
 * Checks `response.ok`. The previous settings writer did not, so a rejected
 * save reported success and the user's change silently vanished on the next
 * load.
 */
export async function kvPutJson(key: string, value: unknown, signal?: AbortSignal): Promise<void> {
  await kvPutText(key, JSON.stringify(value), signal);
}

/**
 * Write raw text.
 *
 * The credential path uses this. It is write-only by design: nothing here
 * reads a stored credential back, and no value — credential or not — is
 * ever put in a message, since a KV write failure is reported from the
 * status and content type alone.
 */
export async function kvPutText(key: string, body: string, signal?: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch(kvUrl(key), {
      method: 'PUT',
      signal,
      headers: { 'content-type': 'text/plain' },
      body,
    });
  } catch (error) {
    throw new KvError(`KV write of ${key} failed before reaching the store: ${
      error instanceof Error ? error.message : String(error)}`, { key });
  }
  if (response.ok) return;
  const contentType = response.headers.get('content-type');
  const text = await response.text().catch(() => '');
  const kind = bodyKind(text, contentType);
  throw new KvError(
    kind === 'html'
      ? `KV write of ${key} returned HTML (${response.status}), so it never reached the KV store.`
      : `KV write of ${key} failed with ${response.status}`,
    { key, status: response.status, contentType, bodyKind: kind },
  );
}

// ─────────────────────────────────────────────────────────────────
// Member-scoped keys
// ─────────────────────────────────────────────────────────────────

/**
 * Key format version. Present so the shape can change again without
 * silently reinterpreting anything already stored.
 */
const KEY_VERSION = 'k1';

/** Separator between encoded parts. Outside the hex alphabet, so the split
 *  is exact and needs no escaping rules of its own. */
const KEY_SEPARATOR = '-';

/**
 * Build a stable, route-safe key for per-member state.
 *
 * **Output uses only `[0-9a-f-]` after a `k1` prefix** — a strict subset of
 * the unreserved path characters every router accepts. That is the whole
 * requirement, and two earlier attempts got it wrong by reasoning about
 * the wrong layer:
 *
 *  - `~` as separator: chosen because `encodeURIComponent` supposedly
 *    escapes it. It does not (`~` is unreserved), so an id containing one
 *    split into two parts.
 *  - `:` as separator: chosen because `encodeURIComponent` DOES escape it,
 *    which made the split unambiguous — but the separator itself is
 *    written raw, and the Cribl KV router does not match a path segment
 *    containing a raw `:`. Measured against live staging: a key with `:`
 *    returns an HTML 404 (unmatched route), not the JSON
 *    `{"message":"Key not found"}` a real missing key returns. Percent
 *    escapes fare no better — `%7C` and `%2F` also produce the HTML 404.
 *
 * So no character is trusted to survive. Each part is hex-encoded from its
 * UTF-8 bytes, which cannot emit anything but `0-9a-f`, and parts are
 * joined with `-`, which hex cannot contain. Hex doubles the length; at
 * member-id sizes that is worth the certainty, and it stays readable in a
 * log with a single `xxd`-style decode.
 *
 * Every input round-trips exactly: `|`, `/`, `~`, `%`, `:`, spaces, and
 * non-ASCII alike.
 */
export function memberKey(namespace: string, memberId: string, ...rest: string[]): string {
  if (!namespace) throw new Error('memberKey requires a namespace');
  if (!memberId) throw new Error('memberKey requires a member id');
  return [KEY_VERSION, ...[namespace, memberId, ...rest].map(hexEncode)].join(KEY_SEPARATOR);
}

/**
 * Reverse {@link memberKey}.
 *
 * Throws on anything it did not produce. A key from app-utils 0.9.0 —
 * percent-encoded parts joined with `:` — is rejected here rather than
 * re-split, because misreading a stored key is worse than refusing it.
 * In practice no 0.9.0 key can hold data: the router never matched one, so
 * every read and write against it failed. See {@link isLegacyMemberKey}.
 */
export function parseMemberKey(key: string): string[] {
  const parts = key.split(KEY_SEPARATOR);
  if (parts[0] !== KEY_VERSION) {
    throw new Error(
      `Not a ${KEY_VERSION} member key: ${JSON.stringify(key.slice(0, 40))}. `
      + 'Keys built by app-utils 0.9.0 used a different, non-routable shape and cannot be parsed here.',
    );
  }
  return parts.slice(1).map(hexDecode);
}

/**
 * Does this look like a key built by app-utils 0.9.0?
 *
 * Offered so a caller can detect and report one rather than have it
 * silently reinterpreted. Those keys contain a raw `:`, which the Cribl KV
 * router never matched, so they cannot have stored anything — but a caller
 * that recorded a key somewhere else deserves to be told rather than
 * guessed at.
 */
export function isLegacyMemberKey(key: string): boolean {
  return !key.startsWith(`${KEY_VERSION}${KEY_SEPARATOR}`) && key.includes(':');
}

const HEX = '0123456789abcdef';

/** UTF-8 bytes as lowercase hex. Cannot emit a character outside `0-9a-f`. */
function hexEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = '';
  for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 0x0f];
  return out;
}

function hexDecode(value: string): string {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) {
    throw new Error(`Malformed member key part: ${JSON.stringify(value.slice(0, 40))}`);
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}
