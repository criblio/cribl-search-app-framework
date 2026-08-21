/**
 * Copilot Investigator chat shell — public surface.
 *
 * Import via the `@criblio/app-utils/investigator` subpath. The shell
 * pairs with the `./agent`, `./agent-loop`, and `./agent-tools`
 * modules: apps supply tool definitions, context, and executors;
 * the shell owns the transcript, approvals, markdown rendering, and
 * PNG export.
 *
 * The transcript view is exported on its own as
 * InvestigatorTranscript: feed any source of LoopEvents through
 * `applyLoopEvent` and render the resulting entries without running
 * the client agent loop (e.g. replaying a server-side
 * investigation). InvestigatorChat renders through the same
 * component, so both drivers stay pixel-identical.
 */
export {
  InvestigatorChat,
  type InvestigatorChatProps,
  type InvestigatorSeed,
  type InvestigatorSeedBase,
} from './InvestigatorChat.js';
export {
  InvestigatorTranscript,
  applyLoopEvent,
  type InvestigatorTranscriptProps,
  type InvestigatorTranscriptEntry,
  type InvestigatorUserEntry,
  type InvestigatorAssistantEntry,
  type InvestigatorToolCallEntry,
  type InvestigatorErrorEntry,
} from './InvestigatorTranscript.js';
export { exportAsPng } from './exportInvestigation.js';
