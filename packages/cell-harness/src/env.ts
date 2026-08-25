/**
 * The environment contract the harness needs from a cell. Apps extend
 * this with their payload's own vars (e.g. APM's CRIBL_*) and pass
 * the extended type as the factories' TEnv parameter.
 *
 * The two Durable Object binding NAMES (COORDINATOR / INVESTIGATION)
 * are part of the contract: the router and the DOs reach each other
 * through them, so a cell's wrangler.jsonc must bind its coordinator
 * and session classes under exactly these names. (INVESTIGATION is a
 * wire-frozen v1 name — see @criblio/agent-protocol's naming note.)
 */
export interface CellEnv {
  COORDINATOR: DurableObjectNamespace;
  INVESTIGATION: DurableObjectNamespace;
  /** Bearer for POST /alerts/fire (the trigger webhook). */
  WEBHOOK_BEARER?: string;
  /** Bearer for the UI's proxied calls (proxies.yml kv.cellToken). */
  UI_BEARER?: string;
  /** HMAC key for WS tickets. */
  TICKET_SECRET?: string;
  /** "true" drops all new triggers — a per-node operator kill switch.
   *  Feature-level on/off belongs app-side (e.g. whether the notify
   *  search exists at all). */
  DISABLED?: string;
  /** Per-message turn budget for interactive sessions (default 12).
   *  Coding payloads set this high — their sessions run long. */
  TURN_BUDGET?: string;

  // ── Real agent mode (LLM_BASE_URL present ⇒ real loop; absent ⇒
  //    the payload's stub agent, so configless smokes keep passing) ──
  /** OpenAI-compatible endpoint base, e.g. https://api.openai.com/v1 */
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  /** Model id sent to the endpoint. */
  LLM_MODEL?: string;
  /** "true" ⇒ the model accepts image input, so attached images are
   *  forwarded. Off by default: an arbitrary OpenAI-compatible
   *  endpoint is not assumed multi-modal, and most providers hard-fail
   *  a request that carries image parts to a text-only model. */
  LLM_VISION?: string;

  // ── Context management (see compaction.ts and CONTEXT.md) ──
  /**
   * Declared input window (default 200,000). pi-agent-core never reads
   * it, so it clamps nothing on its own — its real job here is to be
   * the number the whole compaction policy is derived from. Raising it
   * for a model with a bigger window raises the compaction point with
   * it, which is what makes that a config change rather than a code
   * change.
   */
  LLM_CONTEXT_WINDOW?: string;
  /**
   * Output budget for one turn (default 16,384). Shared between
   * reasoning and the answer on an OpenAI-completions endpoint.
   * Raising it raises turn latency directly — latency tracks output
   * tokens, not input size — so it trades against the 180s turn
   * timeout and, beyond that, celld's ~300s handler budget.
   */
  LLM_MAX_TOKENS?: string;
  /** "off" disables summarizing compaction. Tool-result bounding stays
   *  on regardless: it needs no LLM call and cannot fail. An escape
   *  hatch for a summarizer problem in production, not a default. */
  CONTEXT_COMPACTION?: string;
  /** Compact when the prompt estimate crosses this many tokens
   *  (default: half the declared window). */
  CONTEXT_COMPACT_AT?: string;
  /** Compact until the estimate is at or under this many tokens
   *  (default: 30% of the declared window). */
  CONTEXT_COMPACT_TARGET?: string;
  /** Verbatim budget for older tool results, in characters
   *  (default: 15% of the window, converted at 4 chars/token). */
  CONTEXT_TOOL_RESULT_BUDGET?: string;

  // ── Source-code workspace (optional) ──
  /** JSON array of source repos the agent may check out, e.g.
   *  `[{"url":"github.com/org/repo","service":"*"}]`. Absent ⇒ code
   *  tools are not offered (unless the session carries its own repos
   *  from app settings). */
  REPOS_JSON?: string;
  /** GitHub token for checking out private repos (optional). */
  GITHUB_TOKEN?: string;
}

/**
 * The class shape the DO factories return. Declared explicitly so
 * declaration emit doesn't have to name the factory's anonymous class
 * (TS4094: private members can't appear on an exported anonymous
 * class type) — and consumers only ever need "a DO class" anyway.
 */
export type CellDOClass<TEnv extends CellEnv = CellEnv> = new (
  state: DurableObjectState,
  env: TEnv,
) => {
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
  webSocketMessage?(ws: WebSocket): Promise<void>;
};
