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
