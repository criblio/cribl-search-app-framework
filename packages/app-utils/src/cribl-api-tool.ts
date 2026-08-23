/**
 * cribl_api — let an agent discover and call Cribl's REST API, so it
 * can validate an interaction against the live workspace BEFORE
 * writing app code that depends on it.
 *
 * Three actions on one tool rather than three tools, because they're
 * one workflow ("what exists? → what does it take? → do it") and a
 * model picks a mode far more reliably than it picks between three
 * similarly-named tools:
 *
 *   search   — rank the OpenAPI digest by free text
 *   describe — one operation's params + request-body schema
 *   call     — execute a request
 *
 * ## Writes are gated on the user, per call
 *
 * Reads execute immediately. Every write (anything not GET/HEAD/
 * OPTIONS — see `isWriteMethod`) is refused on first call: the tool
 * records the pending request and returns an approval card. The user
 * approves out-of-band, the agent retries with the `approvalId`, and
 * only then does the request run.
 *
 * Three properties make that a real gate rather than a speed bump:
 *
 *   - The approval is recorded by the HOST, through a path only the UI
 *     can reach. Nothing the model emits can approve anything; the
 *     worst it can do is invent an id, and an unknown id is a refusal.
 *   - The approval is bound to a DIGEST of the exact request. Approving
 *     `DELETE /apps/foo` does not approve `DELETE /apps/bar`, and a
 *     retry whose body changed by one byte is refused.
 *   - It is single-use. `consume` is called before the fetch, so a
 *     replayed approvalId can't fire a second write, and a request that
 *     fails in flight needs fresh approval rather than silently
 *     re-running.
 *
 * What this is NOT: an authorization boundary. It gates the AGENT, not
 * the human — anyone who can drive the session can approve, and the
 * bearer token's own permissions are what actually bound the damage.
 * Its job is to guarantee no write happens without a human deciding.
 */
import { parseArgs, type ToolCallInvocation, type ToolExecutionResult } from './agent-tools.js';
import type { AgentToolDefinition } from './agent.js';
import {
  formatOpDetail,
  formatOpLine,
  isWriteMethod,
  matchOperation,
  searchOperations,
  type OpenApiDigest,
} from './openapi-digest.js';

/** A write awaiting the user, as the host stores it. */
export interface PendingWrite {
  /** Opaque id the host generates. The agent echoes it back; it is
   *  never a secret, only a lookup key — approval state lives in the
   *  host's store, not in this value. */
  id: string;
  method: string;
  path: string;
  /** Canonical digest of the request this approval is bound to. */
  digest: string;
  /** Human-readable body preview for the approval card. */
  bodyPreview?: string;
  /** Why the agent says it needs this write. */
  reason?: string;
}

/**
 * The host's approval store. Implemented over whatever durable state
 * the host has (a DO's SQLite, a table, a KV bucket) — this module
 * neither knows nor cares, it only requires that `approve` is
 * unreachable from the agent.
 */
export interface WriteApprovals {
  /** Record a write awaiting approval. Called by the tool. */
  put(pending: PendingWrite): Promise<void>;
  /**
   * Atomically check-and-burn an approval. Returns the pending record
   * only if it exists, was approved by the user, matches `digest`, and
   * has not been consumed — and marks it consumed in the same step.
   * Returning null covers every failure the same way on purpose: the
   * agent learns "not approved", not which check it missed.
   *
   * Must be atomic. Two concurrent calls with one approval may satisfy
   * at most one of them.
   */
  consume(id: string, digest: string): Promise<PendingWrite | null>;
}

/**
 * A stable digest of the exact request an approval covers.
 *
 * Not a hash: this string is compared, never published, and a readable
 * form makes a refused retry debuggable ("approved X, retried Y"). The
 * body is canonicalized with sorted keys so JSON key order — which the
 * model does not control between turns — can't invalidate an approval
 * the user genuinely gave.
 */
export function requestDigest(method: string, path: string, body: unknown): string {
  return `${method.trim().toUpperCase()} ${path.trim()} ${canonicalJson(body)}`;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** One executed request, as the tool reports it. */
export interface CriblApiResponse {
  status: number;
  ok: boolean;
  text: string;
}

export interface CriblApiToolDeps {
  /** The build-time OpenAPI digest to search. */
  digest: OpenApiDigest;
  /** Execute a request against the workspace. Should NOT throw on a
   *  non-2xx — a 403 is information the agent should see. */
  request: (
    method: string,
    path: string,
    opts: { body?: unknown; signal?: AbortSignal },
  ) => Promise<CriblApiResponse>;
  /** Where pending writes live. Omit ONLY for a read-only host: with
   *  no store, writes are refused outright rather than run. */
  approvals?: WriteApprovals;
  /** Generate an approval id. Injected because a workerd isolate and a
   *  Node host differ, and tests want determinism. Defaults to
   *  `crypto.randomUUID()`. */
  newApprovalId?: () => string;
  /** Cap on response text handed back to the agent. Default 12 KB —
   *  a Cribl list endpoint can return megabytes, and the tool result
   *  goes into the model's context every subsequent turn. */
  maxResponseChars?: number;
}

/** UI payload for a cribl_api result. */
export type CriblApiUi = {
  kind: 'criblApi';
  action: string;
  method?: string;
  path?: string;
  status?: number;
  /** Set when a write is waiting: the UI renders Approve / Reject. */
  approval?: { id: string; method: string; path: string; bodyPreview?: string; reason?: string };
  body?: string;
  error?: string;
} & Record<string, unknown>;

interface CriblApiArgs {
  action?: string;
  query?: string;
  method?: string;
  path?: string;
  body?: unknown;
  reason?: string;
  approvalId?: string;
  writesOnly?: boolean;
  limit?: number;
}

const DEFAULT_MAX_RESPONSE = 12_000;

/** The tool definition. Pair with {@link createCriblApiTool}. */
export function criblApiDefinition(opts: { contextGuide?: string } = {}): AgentToolDefinition {
  const guide = opts.contextGuide ? `\n\n${opts.contextGuide}` : '';
  return {
    id: 'cribl_api',
    description:
      'Discover and call the Cribl REST API. Use it to check how an API really behaves before writing app code against it.\n' +
      "action='search': find endpoints by free text (e.g. \"create search job\", \"saved queries\", \"apps\"). Start here — do not guess paths.\n" +
      "action='describe': get one endpoint's parameters and request-body schema. method+path required.\n" +
      "action='call': execute a request. GET runs immediately. Any write (POST/PUT/PATCH/DELETE) is NOT executed on the first call: you get an approvalId, you must STOP and let the user approve it, and only then retry the identical call with that approvalId. Changing the method, path, or body invalidates an approval — ask again." +
      guide,
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'describe', 'call'],
          description: 'search | describe | call',
        },
        query: { type: 'string', description: "Free-text search (action='search')." },
        method: {
          type: 'string',
          description: "HTTP method (action='describe' or 'call'), e.g. GET, POST, PATCH.",
        },
        path: {
          type: 'string',
          description:
            "API path below the version prefix, e.g. /m/default_search/search/jobs. Note the spec lists /search/... paths, but Search endpoints are only reachable under the /m/default_search group context; non-Search endpoints (/apps, /system/...) are not.",
        },
        body: {
          type: 'object',
          description: "JSON request body (action='call' with a write method).",
        },
        reason: {
          type: 'string',
          description:
            'For a write: what this changes and why, in one sentence. The user reads this when deciding whether to approve.',
          maxLength: 300,
        },
        approvalId: {
          type: 'string',
          description:
            'The id returned by a previous refused write, once the user has approved it. Omit on the first attempt.',
        },
        writesOnly: {
          type: 'boolean',
          description: "action='search': restrict results to writing endpoints.",
        },
        limit: { type: 'number', description: "action='search': max results.", minimum: 1, maximum: 100 },
      },
      required: ['action'],
    },
  };
}

function fail(call: ToolCallInvocation, content: string, ui: CriblApiUi): ToolExecutionResult {
  return { id: call.id, name: call.name, content, ui };
}

/**
 * Build the cribl_api executor. Never throws: every failure comes back
 * as content the model can react to (an unreachable workspace, a
 * refused write, a bad path) — the loop keeps moving.
 */
export function createCriblApiTool(
  deps: CriblApiToolDeps,
): (call: ToolCallInvocation, signal?: AbortSignal) => Promise<ToolExecutionResult> {
  const maxChars = deps.maxResponseChars ?? DEFAULT_MAX_RESPONSE;
  const newId = deps.newApprovalId ?? (() => crypto.randomUUID());

  return async (call, signal) => {
    const args = parseArgs<CriblApiArgs>(call.arguments);
    const action = (args.action ?? '').trim().toLowerCase();

    if (action === 'search') {
      const query = (args.query ?? '').trim();
      if (!query) {
        return fail(call, "cribl_api search needs a non-empty `query`.", {
          kind: 'criblApi',
          action,
          error: 'missing query',
        });
      }
      const hits = searchOperations(deps.digest, query, {
        method: args.method,
        writes: args.writesOnly === true ? true : undefined,
        limit: args.limit,
      });
      if (hits.length === 0) {
        return fail(
          call,
          `No Cribl API endpoints matched ${JSON.stringify(query)}. Every search term has to appear somewhere in the endpoint — try fewer or broader words (a resource name like "dataset", "app", "pipeline" works best).`,
          { kind: 'criblApi', action, error: 'no matches' },
        );
      }
      const lines = hits.map((h) => formatOpLine(h.op));
      const content = [
        `${hits.length} endpoint${hits.length === 1 ? '' : 's'} matching ${JSON.stringify(query)} (Cribl ${deps.digest.specVersion}):`,
        ...lines,
        '',
        "Use action='describe' with a method+path for parameters and the request-body schema.",
      ].join('\n');
      return { id: call.id, name: call.name, content, ui: { kind: 'criblApi', action, body: lines.join('\n') } };
    }

    if (action === 'describe') {
      const method = (args.method ?? '').trim().toUpperCase();
      const path = (args.path ?? '').trim();
      if (!method || !path) {
        return fail(call, "cribl_api describe needs both `method` and `path`.", {
          kind: 'criblApi',
          action,
          error: 'missing method or path',
        });
      }
      const op = matchOperation(deps.digest, method, stripContext(path));
      if (!op) {
        return fail(
          call,
          `No spec entry for ${method} ${path}. Find the right one with action='search' — the spec's own paths are templated (e.g. /search/jobs/{id}), and it may simply not exist.`,
          { kind: 'criblApi', action, method, path, error: 'not in spec' },
        );
      }
      const detail = formatOpDetail(op);
      return {
        id: call.id,
        name: call.name,
        content: detail,
        ui: { kind: 'criblApi', action, method, path: op.path, body: detail },
      };
    }

    if (action !== 'call') {
      return fail(
        call,
        `Unknown cribl_api action ${JSON.stringify(args.action ?? '')}. Use 'search', 'describe', or 'call'.`,
        { kind: 'criblApi', action, error: 'unknown action' },
      );
    }

    // ── action === 'call' ────────────────────────────────────────────
    const method = (args.method ?? 'GET').trim().toUpperCase();
    const path = (args.path ?? '').trim();
    if (!path.startsWith('/')) {
      return fail(
        call,
        "cribl_api call needs a `path` starting with '/', below the API version prefix (e.g. /m/default_search/search/datasets).",
        { kind: 'criblApi', action, method, path, error: 'bad path' },
      );
    }

    if (isWriteMethod(method)) {
      const digest = requestDigest(method, path, args.body);

      if (!deps.approvals) {
        return fail(
          call,
          `${method} ${path} was NOT executed: this host has no approval store, so writes are disabled. Do the read-only equivalent, or tell the user what they'd need to change by hand.`,
          { kind: 'criblApi', action, method, path, error: 'writes disabled' },
        );
      }

      const approvalId = (args.approvalId ?? '').trim();
      if (!approvalId) {
        const id = newId();
        const bodyPreview =
          args.body === undefined ? undefined : truncate(JSON.stringify(args.body, null, 1), 2_000);
        await deps.approvals.put({
          id,
          method,
          path,
          digest,
          bodyPreview,
          reason: args.reason,
        });
        return {
          id: call.id,
          name: call.name,
          content:
            `${method} ${path} was NOT executed — it changes state, so it needs the user's approval.\n` +
            `Approval id: ${id}\n` +
            'STOP now and let the user decide. If they approve, retry this exact call (same method, path, and body) with approvalId set. Any change to the request voids the approval.',
          ui: {
            kind: 'criblApi',
            action,
            method,
            path,
            approval: { id, method, path, bodyPreview, reason: args.reason },
          },
        };
      }

      // Burn the approval BEFORE the request: single-use has to mean
      // "one attempt", not "one success", or a write that times out
      // mid-flight could be retried against the same approval while
      // the first one is still landing.
      const approved = await deps.approvals.consume(approvalId, digest);
      if (!approved) {
        return fail(
          call,
          `${method} ${path} was NOT executed: approval ${approvalId} is not usable. It was never approved, has already been used, or does not match this exact request (method, path, and body must be byte-identical to what the user saw). Ask again with no approvalId to raise a fresh request.`,
          { kind: 'criblApi', action, method, path, error: 'approval not usable' },
        );
      }
    }

    try {
      const resp = await deps.request(method, path, { body: args.body, signal });
      const text = truncate(resp.text, maxChars);
      const content = `${method} ${path} → ${resp.status}\n${text || '(empty response)'}`;
      return {
        id: call.id,
        name: call.name,
        content,
        ui: { kind: 'criblApi', action, method, path, status: resp.status, body: text },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(call, `${method} ${path} failed: ${msg}`, {
        kind: 'criblApi',
        action,
        method,
        path,
        error: msg,
      });
    }
  };
}

/**
 * Drop a leading group/node context so a concrete path can be matched
 * against the spec, which templates them: `/m/default_search/search/
 * jobs` → `/search/jobs`. Both `/m/{group}` and `/w/{node}` are
 * stripped, matching the base-URL contexts the spec's own `info`
 * describes.
 */
function stripContext(path: string): string {
  return path.replace(/^\/(?:m|w)\/[^/]+/, '') || '/';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… truncated (${text.length} chars total)`;
}
