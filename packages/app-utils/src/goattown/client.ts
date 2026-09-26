/**
 * HTTP client for a GoatTown session service.
 *
 * Transport is short-poll over the platform fetch proxy. The sandboxed
 * iframe's CSP (`connect-src 'self' …`) blocks raw WebSockets, but a proxied
 * fetch is rewritten same-origin and is therefore CSP-clean. The service's
 * WebSocket surface exists for non-iframe clients; an app never uses it.
 *
 * **No credential is set here, and none belongs in the browser.** The
 * platform proxy injects the service bearer for the domain declared in
 * `config/proxies.yml`, and strips any `authorization` the page sets — so an
 * app that ships its own token gains nothing and leaks something. This is
 * the whole reason the `kv.sharedCellToken` pattern is called out as a
 * mistake in the provisioning module.
 */
import type {
  AgentCatalogRow,
  AlertTrigger,
  FireAlertsResult,
  CreateSessionReceipt,
  ImageInputContract,
  ProtocolResponse,
  SendMessageReceipt,
  SessionLlmSettings,
  SessionStatus,
  SessionStatusResponse,
  SessionSummaryRow,
  SourceRepo,
  WithExecution,
} from '@criblio/agent-protocol';
import { DEFAULT_IMAGE_INPUT } from '@criblio/agent-protocol';
import { errorFromResponse, ImageInputError } from './errors.js';
import { errorKindOf, operationOf, redactUrl, type DiagnosticSink } from './diagnostics.js';
import { readEventCollection, type SessionFrame } from './wire.js';

/** An image attached to a message. `data` is raw base64 — no `data:` URL
 *  prefix, which the service rejects. */
export interface MessageImage {
  data: string;
  mimeType: string;
}

export interface GoatTownClientOptions {
  /** Service base URL. Must match a domain declared in `config/proxies.yml`
   *  or the platform proxy will not forward the request. */
  baseUrl: string;
  /**
   * Resolve the acting Cribl user id, sent as `x-goattown-user`.
   *
   * Required rather than optional: sessions are owned per user, and a client
   * that quietly omits the header reads someone else's session list or none
   * at all, depending on the service's mood about anonymous callers.
   */
  userId: () => Promise<string>;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Called for every request with a redacted record of what happened.
   *
   * Exists so an app never has to wrap `fetch` to find out why a session
   * looked empty — the decisive facts (status, content type, which event
   * collection came back) are captured here, and nothing that could carry
   * a credential is.
   */
  onDiagnostic?: DiagnosticSink;
}

/** Observation response, whichever route produced it. */
export interface SessionSnapshot {
  status: SessionStatus;
  latestSeq: number;
  frames: SessionFrame[];
  /** `null`/absent means legacy or untracked — never proof of success. */
  execution: WithExecution['execution'];
  /** False when this route carried no event collection at all, which is the
   *  signal to stop asking it for events. */
  carriedEvents: boolean;
}

export class GoatTownClient {
  readonly baseUrl: string;
  private readonly userId: () => Promise<string>;
  private readonly doFetch: typeof fetch;
  private readonly onDiagnostic?: DiagnosticSink;
  private protocolCache: ProtocolResponse | null = null;

  constructor(options: GoatTownClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.userId = options.userId;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.onDiagnostic = options.onDiagnostic;
  }

  // ── transport ────────────────────────────────────────────────

  /** The acting Cribl user id sent as `x-goattown-user`. Public because the
   *  provisioning module talks to /configurations directly — that route
   *  takes application/yaml, so it cannot go through the JSON helper. */
  actingUser(): Promise<string> {
    return this.userId();
  }

  /**
   * Request headers.
   *
   * `x-goattown-user` identifies the acting member and is required for
   * discovery and every session read — sessions are owned per user. Alert
   * firing is the one route where it does not belong: the sender is a
   * machine, not a member, and the service deletes the header on that
   * route anyway. Passing `member: false` keeps the client honest about
   * which calls carry a member claim rather than sending one everywhere
   * and relying on the server to ignore it.
   */
  private async headers(
    extra?: Record<string, string>,
    opts: { member?: boolean } = {},
  ): Promise<Headers> {
    const headers = new Headers({ accept: 'application/json', ...extra });
    if (opts.member !== false) headers.set('x-goattown-user', await this.userId());
    return headers;
  }

  /**
   * One request with a non-JSON body, through the same transport,
   * headers and diagnostics as everything else.
   *
   * Returns the raw `Response` because the callers that need it —
   * `/configurations` takes `application/yaml` — also need to read the
   * body themselves. Exists so those calls cannot quietly bypass an
   * injected transport or the diagnostic sink, which is what happened
   * when provisioning called the global `fetch` directly.
   */
  async rawRequest(
    path: string,
    init: { method?: string; body?: string; contentType?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const method = init.method ?? 'GET';
    const note = (extra: Record<string, unknown>) => this.onDiagnostic?.({
      at: Date.now(), op: operationOf(path), method, path: redactUrl(path), ...extra,
    });
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        signal: init.signal,
        headers: await this.headers(
          init.body !== undefined && init.contentType ? { 'content-type': init.contentType } : undefined,
        ),
        body: init.body,
      });
    } catch (error) {
      note({ errorKind: errorKindOf(error) });
      throw error;
    }
    note({ status: response.status, contentType: response.headers.get('content-type') });
    return response;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; signal?: AbortSignal; member?: boolean } = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const hasBody = init.body !== undefined;
    const note = (extra: Record<string, unknown>) => this.onDiagnostic?.({
      at: Date.now(), op: operationOf(path), method, path: redactUrl(path), ...extra,
    });
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        signal: init.signal,
        headers: await this.headers(
          hasBody ? { 'content-type': 'application/json' } : undefined,
          { member: init.member },
        ),
        body: hasBody ? JSON.stringify(init.body) : undefined,
      });
    } catch (error) {
      // A network/CORS failure never reaches the status branch below, and is
      // exactly the shape a proxy misconfiguration takes. Only the CATEGORY
      // is recorded: a thrown fetch error carries the request URL, and the
      // URL can carry a token.
      note({ errorKind: errorKindOf(error) });
      throw error;
    }
    const contentType = response.headers.get('content-type');
    note({ status: response.status, contentType });
    if (!response.ok) throw await errorFromResponse(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  // ── discovery ────────────────────────────────────────────────

  /**
   * GET /protocol, cached for the life of the client.
   *
   * The cache is right for the hot paths that read this on every call —
   * but it is a CACHE, not a constant. Capabilities absolutely do change
   * under a running page: an administrator enabling "Allow alert firing"
   * on a connection adds `alerts-fire`, and revoking it removes the grant,
   * both without the page reloading. A long-lived client keeps answering
   * from the first read and a Re-check button silently re-reports the
   * stale answer.
   *
   * So call {@link refreshProtocol} whenever the user is explicitly asking
   * the question again. Constructing a new client also works, and is what
   * `useSetup` does by default — but a caller that injects `createClient`
   * may hand back a shared instance, which is exactly the case the cache
   * outlives.
   */
  async protocol(signal?: AbortSignal): Promise<ProtocolResponse> {
    if (this.protocolCache) return this.protocolCache;
    const response = await this.request<ProtocolResponse>('/protocol', { signal });
    this.protocolCache = response;
    return response;
  }

  /**
   * Discard the cached protocol response and read it again.
   *
   * The explicit re-check. Every capability answer derived from
   * `protocol()` — `hasCapability`, `canFireAlerts`, `imageLimits` —
   * reflects the refreshed response afterwards.
   *
   * The cache is cleared BEFORE the request rather than replaced after it,
   * so a failed refresh leaves no stale answer behind. A caller that gets
   * an error here has learned something real; one that silently kept the
   * previous capabilities would not.
   */
  async refreshProtocol(signal?: AbortSignal): Promise<ProtocolResponse> {
    this.protocolCache = null;
    return this.protocol(signal);
  }

  /** Does the service advertise a capability? Unknown names are false, never
   *  an error — a consumer must tolerate a service older than itself.
   *  Answers from the cached protocol; see {@link refreshProtocol}. */
  async hasCapability(name: string, signal?: AbortSignal): Promise<boolean> {
    const protocol = await this.protocol(signal).catch(() => null);
    return protocol?.capabilities?.includes(name) ?? false;
  }

  /** Advertised image ceilings, falling back to the documented defaults so
   *  local validation still works against a service that predates the
   *  `session-images` capability. */
  async imageLimits(signal?: AbortSignal): Promise<ImageInputContract> {
    const protocol = await this.protocol(signal).catch(() => null);
    return protocol?.imageInput ?? DEFAULT_IMAGE_INPUT;
  }

  async listAgents(signal?: AbortSignal): Promise<AgentCatalogRow[]> {
    const data = await this.request<{ agents?: AgentCatalogRow[] }>('/agents', { signal });
    return data.agents ?? [];
  }

  // ── alerts ───────────────────────────────────────────────────

  /**
   * Fire alert-triggered investigations.
   *
   * Requires the `alerts-fire` capability, which appears in `/protocol`
   * only after an administrator enables **Allow alert firing** on the
   * connection. The grant is off by default, including for existing
   * connections, because an external event can start billable work.
   * Preflight with {@link canFireAlerts}; never infer permission from a
   * token's shape, and never fall back to asking for an
   * installation-wide token.
   *
   * Sent WITHOUT the member header: the sender is a machine, not a member.
   * Discovery and session reads keep theirs.
   *
   * **A 202 does not mean work started.** An empty array answers 202 with
   * `accepted: 0` and starts nothing — which makes it a safe connection
   * probe — and a retry can correctly accept zero because the events
   * deduplicated. Read `accepted`, and read `rejected` when present: a row
   * the service declines is otherwise a silent skip.
   */
  async fireAlerts(
    triggers: AlertTrigger[],
    signal?: AbortSignal,
  ): Promise<FireAlertsResult> {
    const result = await this.request<FireAlertsResult>('/alerts/fire', {
      method: 'POST',
      body: triggers,
      member: false,
      signal,
    });
    // Normalize the count so a caller can compare it without a guard; the
    // service always sends it, but a missing one must not read as success.
    return { ...result, accepted: typeof result?.accepted === 'number' ? result.accepted : 0 };
  }

  /**
   * Is this credential permitted to fire alerts?
   *
   * The capability is the ONLY correct check. It is absent unless the
   * connection is active and the grant is enabled.
   *
   * Answers from the cached protocol response. The grant is the thing an
   * administrator toggles WHILE a page is open, so a long-lived client
   * must call {@link refreshProtocol} before asking again — otherwise a
   * Re-check re-reports the answer from before the change.
   */
  canFireAlerts(signal?: AbortSignal): Promise<boolean> {
    return this.hasCapability('alerts-fire', signal);
  }

  // ── sessions ─────────────────────────────────────────────────

  async createSession(
    input: {
      prompt: string;
      agent?: string;
      title?: string;
      context?: { service?: string; earliest?: string; latest?: string } | null;
      repos?: SourceRepo[];
      payload?: unknown;
    },
    signal?: AbortSignal,
  ): Promise<CreateSessionReceipt> {
    const receipt = await this.request<CreateSessionReceipt>('/investigations', {
      method: 'POST',
      body: input,
      signal,
    });
    // A service without `session-execution` returns no requestId. Name it
    // `initial` to match what the capability would have sent, so callers
    // have one shape; `execution` staying null is what tells them tracking
    // is unavailable.
    return { ...receipt, requestId: receipt.requestId ?? 'initial' };
  }

  async sendMessage(
    id: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<SendMessageReceipt> {
    return this.request<SendMessageReceipt>(`/investigations/${enc(id)}/messages`, {
      method: 'POST',
      body: { content },
      signal,
    });
  }

  /**
   * Send a message with images.
   *
   * Validated locally first against the advertised ceilings — a 4 MiB
   * payload rejected after upload costs the user the upload. A 422
   * `image_input_unavailable` from the service is surfaced as-is and is
   * never retried as text: resending without the attachments produces a
   * confident answer about an image the model never saw.
   */
  async sendImageMessage(
    id: string,
    content: string,
    images: MessageImage[],
    signal?: AbortSignal,
  ): Promise<SendMessageReceipt> {
    const limits = await this.imageLimits(signal);
    assertImagesWithin(images, limits);
    return this.request<SendMessageReceipt>(`/investigations/${enc(id)}/messages`, {
      method: 'POST',
      body: { content, [limits.field]: images },
      signal,
    });
  }

  /** GET the session's LLM settings. `effective.vision` is the send
   *  preflight for images. */
  async readSessionLlm(id: string, signal?: AbortSignal): Promise<SessionLlmSettings> {
    return this.request<SessionLlmSettings>(`/investigations/${enc(id)}/workspace/llm`, { signal });
  }

  async status(
    id: string,
    opts: { eventsSince?: number; requestId?: string; signal?: AbortSignal } = {},
  ): Promise<SessionSnapshot> {
    const params = new URLSearchParams();
    if (opts.eventsSince != null) params.set('eventsSince', String(opts.eventsSince));
    if (opts.requestId) params.set('requestId', opts.requestId);
    const query = params.toString();
    const body = await this.request<SessionStatusResponse & WithExecution>(
      `/investigations/${enc(id)}/status${query ? `?${query}` : ''}`,
      { signal: opts.signal },
    );
    const frames = readEventCollection(body);
    this.noteCollection(path0('status'), body, frames, opts.requestId);
    return {
      status: body.status,
      latestSeq: body.latestSeq,
      frames: frames ?? [],
      execution: body.execution,
      // Only meaningful when we actually asked for events.
      carriedEvents: opts.eventsSince == null ? false : frames !== null,
    };
  }

  /** The authoritative event log. `since` is the last consumed seq and is
   *  exclusive. */
  async events(
    id: string,
    since: number,
    opts: { requestId?: string; signal?: AbortSignal } = {},
  ): Promise<SessionSnapshot> {
    const params = new URLSearchParams({ since: String(since) });
    if (opts.requestId) params.set('requestId', opts.requestId);
    const body = await this.request<{
      status: SessionStatus;
      latestSeq: number;
    } & WithExecution>(
      `/investigations/${enc(id)}/events?${params.toString()}`,
      { signal: opts.signal },
    );
    const frames = readEventCollection(body);
    this.noteCollection(path0('events'), body, frames, opts.requestId);
    return {
      status: body.status,
      latestSeq: body.latestSeq,
      frames: frames ?? [],
      execution: body.execution,
      carriedEvents: frames !== null,
    };
  }

  /** Record which event collection an observation carried — the fact that
   *  separates "this route serves no events" from "nothing is new". */
  private noteCollection(
    op: string,
    body: Record<string, unknown> | unknown,
    frames: SessionFrame[] | null,
    requestId?: string,
  ): void {
    if (!this.onDiagnostic) return;
    const record = (body ?? {}) as Record<string, unknown>;
    const collection = frames === null
      ? 'absent'
      : record.eventWindow !== undefined
        ? 'eventWindow.frames'
        : record.frames !== undefined
          ? 'frames'
          : 'events';
    const execution = record.execution as { state?: unknown; finalSeq?: unknown } | null | undefined;
    this.onDiagnostic({
      at: Date.now(),
      op,
      method: 'GET',
      path: `/investigations/:id/${op}`,
      collection,
      requestId,
      finalSeq: typeof execution?.finalSeq === 'number' ? execution.finalSeq : null,
      executionState: execution?.state as never,
    });
  }

  // ── lifecycle ────────────────────────────────────────────────
  //
  // Each is a distinct service route rather than one parameterised call:
  // they have different effects and different idempotency, and collapsing
  // them invites "retry the lifecycle action" on the one that is a mutation.

  /** Abort the running turn. The session stays resumable. */
  stop(id: string, signal?: AbortSignal): Promise<{ status: SessionStatus }> {
    return this.request(`/investigations/${enc(id)}/stop`, { method: 'POST', body: {}, signal });
  }

  /** Cancel the session outright (terminal). */
  cancel(id: string, signal?: AbortSignal): Promise<{ status: SessionStatus }> {
    return this.request(`/investigations/${enc(id)}/cancel`, { method: 'POST', body: {}, signal });
  }

  close(id: string, signal?: AbortSignal): Promise<{ status: SessionStatus }> {
    return this.request(`/investigations/${enc(id)}/close`, { method: 'POST', body: {}, signal });
  }

  reopen(id: string, signal?: AbortSignal): Promise<{ status: SessionStatus }> {
    return this.request(`/investigations/${enc(id)}/reopen`, { method: 'POST', body: {}, signal });
  }

  recover(id: string, signal?: AbortSignal): Promise<{ status: SessionStatus }> {
    return this.request(`/investigations/${enc(id)}/recover`, { method: 'POST', body: {}, signal });
  }

  archive(id: string, signal?: AbortSignal): Promise<{ ok?: boolean }> {
    return this.request(`/investigations/${enc(id)}/archive`, { method: 'POST', body: {}, signal });
  }

  // ── index ────────────────────────────────────────────────────

  async listSessions(
    query: { q?: string; limit?: number; before?: number; agent?: string } = {},
    signal?: AbortSignal,
  ): Promise<SessionSummaryRow[]> {
    const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, query.limit ?? 30))) });
    if (query.q) params.set('q', query.q);
    if (query.before != null) params.set('before', String(query.before));
    if (query.agent) params.set('agent', query.agent);
    const data = await this.request<{ investigations?: SessionSummaryRow[] }>(
      `/investigations?${params.toString()}`,
      { signal },
    );
    return data.investigations ?? [];
  }
}

const enc = encodeURIComponent;
/** Route family label for a collection note. */
const path0 = (op: string) => op;

/**
 * Reject images that the service will reject, before sending them.
 *
 * Limits count BASE64 CHARACTERS, not decoded bytes. Validating a decoded
 * byte count passes payloads ~33% over the real ceiling, which then fail
 * server-side after the whole upload.
 */
export function assertImagesWithin(
  images: MessageImage[],
  limits: ImageInputContract,
): void {
  if (images.length === 0) throw new ImageInputError('No images supplied.');
  if (images.length > limits.maxImages) {
    throw new ImageInputError(`Up to ${limits.maxImages} images per message.`);
  }
  let total = 0;
  for (const [i, image] of images.entries()) {
    const label = `Image #${i + 1}`;
    if (!image || !limits.mimeTypes.includes(image.mimeType)) {
      throw new ImageInputError(
        `${label}: unsupported type. Use ${limits.mimeTypes.join(', ')}.`,
      );
    }
    const data = image.data;
    if (typeof data !== 'string' || data.length === 0) {
      throw new ImageInputError(`${label}: base64 data required.`);
    }
    if (data.startsWith('data:')) {
      // Named separately from the character-class check below: this is the
      // mistake callers actually make, and "use raw base64" is a fix the
      // message can state outright.
      throw new ImageInputError(`${label}: strip the data: URL prefix and send raw base64.`);
    }
    if (data.length > limits.maxBase64CharsPerImage) {
      throw new ImageInputError(
        `${label}: too large (max ${limits.maxBase64CharsPerImage} base64 characters).`,
      );
    }
    // A flat character class, not a repeated group: a repeated-group regexp
    // over a multi-megabyte string can overflow the engine's stack.
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new ImageInputError(`${label}: not valid base64.`);
    }
    total += data.length;
  }
  if (total > limits.maxInlineBase64Chars) {
    throw new ImageInputError(
      `Images exceed the ${limits.maxInlineBase64Chars}-character combined base64 limit.`,
    );
  }
}
