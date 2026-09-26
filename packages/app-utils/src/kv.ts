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

/** Bodies the store uses to say "no such key". Matched case-insensitively
 *  on the message rather than the status, because the status alone cannot
 *  separate absence from a misroute. */
const NOT_FOUND = /key not found|not\s*found/i;

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
    if (NOT_FOUND.test(text)) return { found: false };
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
 * Separator for key parts.
 *
 * `:` is chosen for one property that decides the whole design:
 * `encodeURIComponent(':')` is `%3A`, so an encoded part can NEVER contain
 * a raw `:`, which makes the join unambiguous and the split exact. It is
 * also a legal path character, so the key stays readable in a URL.
 *
 * `~` looks like the natural choice and is the wrong one —
 * `encodeURIComponent` leaves it alone (it is unreserved in RFC 3986), so
 * a member id containing `~` would split into two parts. That is not
 * hypothetical: it is one of the ids this module is required to survive.
 */
const KEY_SEPARATOR = ':';

/**
 * Build a stable, route-safe key for per-member state.
 *
 * KV keys travel in a URL path, so a member id containing `/` would invent
 * a path segment and one containing `%` would be double-decoded. Both are
 * real — ids are often emails or external subjects.
 *
 * Each part is `encodeURIComponent`-encoded and joined with `:`. `|` is NOT
 * escaped by `encodeURIComponent` and is legal in a path segment, so it
 * survives as itself; `/`, `%`, `~` and `:` are all escaped and cannot
 * confuse either the router or the split.
 */
export function memberKey(namespace: string, memberId: string, ...rest: string[]): string {
  if (!namespace) throw new Error('memberKey requires a namespace');
  if (!memberId) throw new Error('memberKey requires a member id');
  return [namespace, memberId, ...rest].map(encodeURIComponent).join(KEY_SEPARATOR);
}

/** Reverse {@link memberKey}. Exact for every input it produced. */
export function parseMemberKey(key: string): string[] {
  return key.split(KEY_SEPARATOR).map(decodeURIComponent);
}
