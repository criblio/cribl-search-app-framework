/**
 * @criblio/cell-harness — the generic server-side agent harness for
 * cells (Worker + Durable Objects on celld, portable to Cloudflare).
 *
 * An app supplies a CellPayload (trigger parsing, seeding, domain
 * tools, lifecycle recording) and wires its cell entry as:
 *
 *   import { makeCoordinatorDO, makeSessionDO, cellRouter } from '@criblio/cell-harness';
 *   import { myPayload } from './payloads/mine';
 *   export const CoordinatorDO = makeCoordinatorDO(myPayload);
 *   export const InvestigationDO = makeSessionDO(myPayload);
 *   export default cellRouter;
 *
 * The exported class names must match the wrangler.jsonc
 * durable_objects class_name bindings, and the binding NAMES must be
 * COORDINATOR / INVESTIGATION (see CellEnv). Extracted from the APM
 * investigator cell (criblio/apm) — design:
 * docs/research/cell-harness-extraction/design.md there.
 */
export { cellRouter } from './router';
export { makeCoordinatorDO } from './coordinatorDO';
export { makeSessionDO, capEvent } from './sessionDO';
export { mintTicket, verifyTicket } from './tickets';
export { runRealTurn, type LlmConfig, type RealTurnResult } from './realTurn';
export { mapPiEvent, toolCallsOf } from './loopEventMap';
export type { CellDOClass, CellEnv } from './env';
export type {
  CellPayload,
  InteractiveInput,
  LifecycleEvent,
  PayloadSqlHandle,
  SeedResult,
  StubTurn,
  ToolExecutors,
  TriggerFacts,
} from './payload';
