/**
 * Copilot Investigator chat shell — public surface.
 *
 * Import via the `@cribl/app-utils/investigator` subpath. The shell
 * pairs with the `./agent`, `./agent-loop`, and `./agent-tools`
 * modules: apps supply tool definitions, context, and executors;
 * the shell owns the transcript, approvals, markdown rendering, and
 * PNG export.
 */
export {
  InvestigatorChat,
  applyLoopEvent,
  type InvestigatorChatProps,
  type InvestigatorSeed,
  type InvestigatorSeedBase,
  type InvestigatorTranscriptEntry,
  type InvestigatorUserEntry,
  type InvestigatorAssistantEntry,
  type InvestigatorToolCallEntry,
  type InvestigatorErrorEntry,
} from './InvestigatorChat.js';
export { exportAsPng } from './exportInvestigation.js';
