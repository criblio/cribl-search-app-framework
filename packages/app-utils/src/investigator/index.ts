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
  applyLoopEvent,
  type InvestigatorTranscriptEntry,
  type InvestigatorUserEntry,
  type InvestigatorAssistantEntry,
  type InvestigatorToolCallEntry,
  type InvestigatorErrorEntry,
} from './transcript.js';
export {
  InvestigatorTranscript,
  type InvestigatorTranscriptProps,
} from './InvestigatorTranscript.js';
export { ResultTable, type ResultTableProps } from './ResultTable.js';
export {
  inferColumns,
  formatCell,
  DEFAULT_MAX_ROWS,
  DEFAULT_MAX_COLS,
} from './resultRows.js';
export {
  reportToSummary,
  reportSections,
  type ReportResultUi,
} from './reportResult.js';
export { splitBlocks, type MarkdownBlock, type MarkdownListItem } from './markdownBlocks.js';
export {
  decodeCodeBody,
  parseCodeLines,
  codeResultTitle,
  type CodeResultUi,
  type CodeLine,
} from './codeResult.js';
/**
 * Read the agent's final answer out of a transcript.
 *
 * Here rather than only in the GoatTown client because the mistake it
 * prevents is not transport-specific: when an agent concludes by calling a
 * report or summary tool, the verdict is in the tool RESULT, so scanning
 * assistant entries returns empty exactly when the agent behaved correctly.
 */
export {
  conclusionFromEntries,
  type Conclusion,
  type ConclusionSource,
} from './conclusion.js';
export { exportAsPng } from './exportInvestigation.js';
