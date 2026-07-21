/**
 * Generic client-side tool plumbing for the Copilot Investigator
 * agent loop. When the agent emits a tool_call, the app's dispatcher
 * routes it to a matching executor, collects the result, and the
 * loop appends a {role: 'tool'} message to the conversation before
 * sending the next POST.
 *
 * This module owns the app-agnostic pieces:
 *
 *   - the ToolCallInvocation / ToolExecutionResult types the loop
 *     (agent-loop.ts) and chat shell (investigator/) exchange,
 *   - argument parsing and result-row formatting helpers,
 *   - `createRunSearchTool()` — the run_search executor, with the
 *     query runner, safety gate, and dataset scope injected by the
 *     app,
 *   - `executeCommonToolCall()` — acknowledgements for the native
 *     UI's tool surface (update_context, get_dataset_context,
 *     sample_events, edit_notebook, …) plus the structured
 *     present_investigation_summary normalization, so loops never
 *     stall waiting on a tool result.
 *
 * App-specific tools (e.g. APM's render_trace) stay in the app; its
 * dispatcher handles them first and falls back to the helpers here.
 */

import { kqlInteger, kqlTime } from './kql.js';

export interface ToolCallInvocation {
  id: string;
  name: string;
  arguments: string;
}

/**
 * UI metadata attached to a tool result. `kind` discriminates the
 * card type; the built-in chat shell renders 'search' and 'summary'
 * itself and hands anything else to the app's renderToolCard. Typed
 * as an open shape (rather than a closed union) so apps can add
 * their own card kinds — e.g. APM's 'trace'.
 */
export type ToolResultUi = { kind: string } & Record<string, unknown>;

export interface ToolExecutionResult {
  id: string;
  name: string;
  /** The tool result content sent back to the agent as a
   *  {role:'tool', tool_call_id, content} message. Freeform string
   *  (JSON-stringified for structured tools, markdown for summaries). */
  content: string;
  /** Optional UI metadata — query results table, rendered summary,
   *  app-specific cards — that the chat UI displays inline beside
   *  the tool call card. Not sent back to the agent. */
  ui?: ToolResultUi;
}

/** UI payload for a run_search tool execution. */
export type RunSearchUi = {
  kind: 'search';
  query: string;
  description?: string;
  earliest: string;
  latest: string;
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  error?: string;
};

/** UI payload for a present_investigation_summary tool execution. */
export type SummaryUi = {
  kind: 'summary';
  findings: Array<{ category: string; details: string }>;
  conclusion: string;
};

/** Arguments parsed out of a tool_call.function.arguments JSON string. */
interface RunSearchArgs {
  query: string;
  earliest?: string | number;
  latest?: string | number;
  limit?: number;
  description?: string;
  confirmBeforeRunning?: boolean;
}

interface UpdateContextArgs {
  key: string;
  value: unknown;
}

interface PresentInvestigationSummaryArgs {
  findings?: Array<{ category?: string; details?: string | string[] }>;
  conclusion?: string;
}

interface EditNotebookArgs {
  title?: string;
  preamble?: string;
  searchNarratives?: Array<{ jobId?: string; narrative?: string }>;
  conclusion?: string;
}

/**
 * Parse a tool_calls[i].function.arguments JSON string into a typed
 * object. Tool call arguments arrive as a stringified JSON blob in
 * the OpenAI function-calling convention.
 */
export function parseArgs<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // Malformed tool_call.function.arguments — most likely a model
    // hallucination of valid JSON. Returning {} keeps the call
    // moving (the tool itself will reject required-field misses),
    // but logging makes the model's mistake visible instead of
    // silently lossy.
    console.error('[agent-tools] parseArgs failed; raw:', raw, 'err:', err);
    return {} as T;
  }
}

/**
 * The agent gets a capped number of rows — enough to reason about
 * the result, not so many it blows the context window. Match the
 * native UI's behavior: top ~50 rows for aggregate queries.
 */
function rowCap(limit: number): number {
  return Math.min(50, limit);
}

/**
 * Format query result rows for feeding back to the agent. This is
 * the only data the LLM sees from the search — it needs to be
 * compact, readable, and preserve the important structure.
 */
export function formatRowsForAgent(
  rows: Record<string, unknown>[],
  cap: number,
): string {
  if (rows.length === 0) return 'Search returned no results.';
  const shown = rows.slice(0, cap);

  // Discover the union of keys to pick a consistent column order —
  // stable across rows, sorted by frequency then name.
  const keyCounts = new Map<string, number>();
  for (const r of shown) {
    for (const k of Object.keys(r)) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
  }
  const keys = Array.from(keyCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);

  const header = `Result: ${rows.length} row${rows.length === 1 ? '' : 's'}${
    rows.length > cap ? ` (showing first ${cap})` : ''
  }`;

  // JSON-per-row keeps numbers as numbers and nested objects intact.
  // The LLM parses JSON far better than an ASCII table.
  const lines = shown.map((r) => {
    const ordered: Record<string, unknown> = {};
    for (const k of keys) {
      if (k in r) ordered[k] = r[k];
    }
    return JSON.stringify(ordered);
  });

  return [header, ...lines].join('\n');
}

/** Dependencies the app injects into the run_search executor. */
export interface RunSearchDeps {
  /** Kick off a search job and return its result rows. */
  runQuery: (
    kql: string,
    earliest: string,
    latest: string,
    limit: number,
  ) => Promise<Record<string, unknown>[]>;
  /** Safety gate for agent-authored queries. Throw to block the
   *  query (the message is fed back to the agent so it can
   *  self-correct). May return a normalized form of the query —
   *  e.g. assertReadOnlyKql() returns the trimmed input — which is
   *  then what gets executed and displayed. */
  assertSafe: (query: string, allowedDatasets: string[]) => string | void;
  /** The dataset id the investigation is scoped to. */
  datasetId: () => string | Promise<string>;
}

/**
 * Build the run_search executor: kick off a search job via the
 * injected runner, wait for it, return both the textual summary
 * (for the agent) and the raw rows (for the UI). Errors are caught
 * and reported back to the agent so it can self-correct rather than
 * stalling the loop.
 */
export function createRunSearchTool(
  deps: RunSearchDeps,
): (call: ToolCallInvocation, signal?: AbortSignal) => Promise<ToolExecutionResult> {
  return async (call, signal) => {
    const args = parseArgs<RunSearchArgs>(call.arguments);

    let earliest = '-15m';
    let latest = 'now';
    let limit = 100;
    let description = '';
    let query = '';

    const started = Date.now();
    try {
      if (signal?.aborted) throw new Error('aborted');
      if (typeof args.query !== 'string') throw new Error('run_search.query must be a string');
      if (args.description != null && typeof args.description !== 'string') {
        throw new Error('run_search.description must be a string');
      }
      const dataset = await deps.datasetId();
      const normalized = deps.assertSafe(args.query, [dataset]);
      query = typeof normalized === 'string' ? normalized : args.query;
      earliest = kqlTime(args.earliest ?? '-15m');
      latest = kqlTime(args.latest ?? 'now');
      limit = Number(kqlInteger(args.limit ?? 100, { min: 1, max: 1_000 }));
      description = args.description ?? '';
      const rows = await deps.runQuery(query, earliest, latest, limit);
      const durationMs = Date.now() - started;

      const ui: RunSearchUi = {
        kind: 'search',
        query,
        description,
        earliest,
        latest,
        rows,
        rowCount: rows.length,
        durationMs,
      };

      // Feed a compact textual representation back to the agent. It
      // doesn't need every row — the summary + first N rows is enough
      // to reason about. Full rows stay in the UI for the human.
      const content = formatRowsForAgent(rows, rowCap(limit));
      return { id: call.id, name: call.name, content, ui };
    } catch (err) {
      const durationMs = Date.now() - started;
      const msg = err instanceof Error ? err.message : String(err);
      const ui: RunSearchUi = {
        kind: 'search',
        query: query || (typeof args.query === 'string' ? args.query : ''),
        description,
        earliest,
        latest,
        rows: [],
        rowCount: 0,
        durationMs,
        error: msg,
      };
      return {
        id: call.id,
        name: call.name,
        content: `Search blocked or failed: ${msg}. Please revise the read-only query and retry.`,
        ui,
      };
    }
  };
}

/**
 * Acknowledge update_context calls — the native UI stores these in
 * a session-scoped key/value bag. We don't need the state to drive
 * anything in an embedded UI, but we must reply with a tool result
 * so the agent loop advances.
 */
function updateContextTool(args: UpdateContextArgs): string {
  const keyStr = args.key ?? '(missing)';
  const valStr =
    typeof args.value === 'string'
      ? args.value
      : JSON.stringify(args.value ?? null);
  return `The context was updated with the key: ${keyStr} and value: ${valStr}`;
}

/**
 * Normalize a present_investigation_summary tool call into a structured
 * UI payload (for the Final Report card) plus a compact markdown
 * representation fed back to the agent. The agent schema requires
 * findings to be an array of {category, details} but we also accept
 * older variants where details is a string[] — normalize everything to
 * a single markdown blob per finding.
 */
function normalizeInvestigationSummary(args: PresentInvestigationSummaryArgs): {
  ui: SummaryUi;
  content: string;
} {
  const findings: Array<{ category: string; details: string }> = [];
  if (args.findings && Array.isArray(args.findings)) {
    for (const f of args.findings) {
      const category = f.category ?? 'Finding';
      let details = '';
      if (Array.isArray(f.details)) {
        details = f.details.map((d) => `- ${d}`).join('\n');
      } else if (typeof f.details === 'string') {
        details = f.details;
      }
      findings.push({ category, details });
    }
  }
  const conclusion = args.conclusion ?? '';

  // Markdown version fed back to the agent as the tool result
  const parts: string[] = [];
  if (findings.length > 0) {
    parts.push('## Findings');
    for (const f of findings) {
      parts.push(`### ${f.category}`);
      parts.push(f.details);
    }
  }
  if (conclusion) {
    parts.push('## Conclusion');
    parts.push(conclusion);
  }

  return {
    ui: { kind: 'summary', findings, conclusion },
    content: parts.join('\n\n') || 'Investigation summary presented.',
  };
}

/** Options for executeCommonToolCall. */
export interface CommonToolCallOptions {
  /** How the "not available" acknowledgements name this app, e.g.
   *  "the embedded Cribl APM investigation". */
  embedLabel?: string;
}

/**
 * Handle the tool names shared with the native Copilot UI that
 * don't need app data access — update_context and
 * present_investigation_summary get real (client-side) handling,
 * while the rest (get_dataset_context, sample_events, notebook
 * editing, integrations, UI-only buttons) get acknowledgements so
 * the loop keeps moving instead of stalling on a missing tool
 * result. Unknown names get a generic "try something else" reply.
 *
 * Apps dispatch their own tools first (run_search via
 * createRunSearchTool, plus anything app-specific) and fall back to
 * this for everything else.
 */
export function executeCommonToolCall(
  call: ToolCallInvocation,
  options: CommonToolCallOptions = {},
): ToolExecutionResult {
  const embedLabel = options.embedLabel ?? 'this embedded investigation';
  switch (call.name) {
    case 'update_context': {
      const args = parseArgs<UpdateContextArgs>(call.arguments);
      return {
        id: call.id,
        name: call.name,
        content: updateContextTool(args),
      };
    }

    case 'get_dataset_context': {
      // We told the agent not to call this, but if it does anyway,
      // reply with a pointer back to the context in the first
      // message so it doesn't waste a round trip on the 5MB
      // fieldStats fetch.
      return {
        id: call.id,
        name: call.name,
        content:
          'Dataset context is already provided in the initial user message above. See the "Field access rules" and "Span field mappings" sections. Do not call this tool again — use the documented field expressions directly.',
      };
    }

    case 'sample_events': {
      // Same principle — we've already handed over the shape.
      return {
        id: call.id,
        name: call.name,
        content:
          'Sample events are not needed: the dataset shape is documented in the initial user message. Use the field mappings provided there instead of sampling.',
      };
    }

    case 'fetch_local_context': {
      // Server-side tool; we should never see this as a client-
      // dispatched call because the backend handles it. If we do,
      // acknowledge so the loop doesn't stall.
      return {
        id: call.id,
        name: call.name,
        content: 'Local context retrieval is handled server-side.',
      };
    }

    case 'get_lookup_content_sample': {
      return {
        id: call.id,
        name: call.name,
        content:
          'Lookup content sampling is not enabled in this embedded investigation. Query the lookup directly with `| lookup <id> on <key>` if you need the data.',
      };
    }

    case 'present_investigation_summary': {
      const args = parseArgs<PresentInvestigationSummaryArgs>(call.arguments);
      const { content, ui } = normalizeInvestigationSummary(args);
      return { id: call.id, name: call.name, content, ui };
    }

    case 'edit_notebook': {
      // Notebook creation is a future enhancement — acknowledge so
      // the agent can wrap up cleanly.
      const args = parseArgs<EditNotebookArgs>(call.arguments);
      const title = args.title ?? 'Untitled investigation';
      return {
        id: call.id,
        name: call.name,
        content: `Notebook "${title}" saved. (Note: embedded investigations don't yet write notebooks to Cribl Search; the chat transcript is the record.)`,
      };
    }

    case 'clickable_suggestion_button':
    case 'show_exit':
    case 'display_incident_overview':
    case 'select_alert':
    case 'selectFirehydrantIncident':
    case 'get_jira_context':
    case 'get_bitbucket_context':
      // UI-only or integration-only tools we don't support in the
      // embedded experience. Acknowledge and move on.
      return {
        id: call.id,
        name: call.name,
        content: `Tool ${call.name} is not available in ${embedLabel}.`,
      };

    default:
      return {
        id: call.id,
        name: call.name,
        content: `Unknown tool: ${call.name}. Please use a different approach.`,
      };
  }
}
