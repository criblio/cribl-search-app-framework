/**
 * Shared client for a GoatTown session service.
 *
 * Import via the `@criblio/app-utils/goattown` subpath. Pairs with
 * `@criblio/app-utils/investigator`: fold the LoopEvents this module yields
 * through `applyLoopEvent` and the transcript renders identically to a
 * client-run one.
 *
 * Three rules are worth knowing before writing against it, because each one
 * has already cost a consumer a debugging session:
 *
 *  1. **`idle` is not completion.** It means "between turns" and is reached
 *     before the first answer as well as after the last. Use the execution
 *     receipt, and drain events through its `finalSeq`.
 *  2. **The conclusion may not be in an assistant message.** An agent that
 *     concludes with a report tool puts the verdict in the tool RESULT.
 *     `conclusionFromEntries` reads both; a hand-rolled scan of assistant
 *     entries returns empty exactly when the agent behaved correctly.
 *  3. **No credential belongs in the browser.** The platform proxy injects
 *     the app credential for domains declared in `config/proxies.yml` and
 *     strips any `authorization` the page sets.
 *
 * The React pieces live on their own subpaths — `useProposal` /
 * `ProposalPanel` on `/goattown/proposal-panel`, `useSetup` / `SetupPanel`
 * on `/goattown/setup-panel` — so a non-React consumer (a Node script, a
 * cell) can import this module without pulling React in. Re-exporting a
 * hook from here undoes that even when the built index carries no literal
 * `react` string, because the module GRAPH is what a bundler follows.
 */
export {
  GoatTownClient,
  assertImagesWithin,
  type GoatTownClientOptions,
  type MessageImage,
  type SessionSnapshot,
} from './client.js';
export {
  GoatTownError,
  ImageInputError,
  MalformedResponseError,
  errorFromResponse,
  retryAfterSeconds,
} from './errors.js';
export {
  isUserMessageFrame,
  readEventCollection,
  wireEventToLoopEvent,
  type SessionFrame,
} from './wire.js';
export {
  observeSession,
  type ObserveOptions,
  type ObserveResult,
} from './observe.js';
export {
  runRequest,
  sendAndRun,
  type RequestOutcome,
  type RequestResult,
  type RunRequestOptions,
  type SendRequestInput,
} from './request.js';
/** Lives in `investigator/` — it reads transcript entries and has nothing
 *  to do with the session transport — and is re-exported here so a consumer
 *  of this module needs one import. */
export {
  conclusionFromEntries,
  type Conclusion,
  type ConclusionSource,
} from '../investigator/conclusion.js';
export {
  SessionDiagnostics,
  operationOf,
  redact,
  redactUrl,
  type DiagnosticEvent,
  type DiagnosticSink,
  type DiagnosticSnapshot,
} from './diagnostics.js';
export {
  assertNoBrowserCredential,
  assertProposalOmitsProducer,
  openReviewPage,
  readProposalScope,
  readProposalStatus,
  stageProposal,
  type ProposalStatus,
  type StagedProposal,
} from './provisioning.js';

/** Re-exported so a consumer needs one import for the whole contract. The
 *  real definitions live in @criblio/agent-protocol, which the service also
 *  imports — that shared dependency is what keeps the two sides from
 *  drifting. */
export type {
  AgentCatalogRow,
  AgentImageReadiness,
  AppConfigurationScope,
  CreateSessionReceipt,
  ImageInputContract,
  ProtocolResponse,
  SendMessageReceipt,
  SessionExecution,
  SessionLlmSettings,
  SessionStatus,
  SessionSummaryRow,
  WireLoopEvent,
} from '@criblio/agent-protocol';
export {
  isExecutionDrained,
  isTerminalExecution,
  isTerminalStatus,
} from '@criblio/agent-protocol';

/** The framework event type a transcript is folded from. Re-exported here
 *  so a consumer of this module never has to guess which `LoopEvent` the
 *  observer emits. */
export type { LoopEvent } from '../agent-loop.js';
