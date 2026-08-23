/**
 * The `AgentToolDefinition`s for the data tools whose executors this
 * package already provides — run_search (`createRunSearchTool`) and
 * run_metrics_query (`createRunMetricsQueryTool`).
 *
 * Definitions and executors belong together: the schema here is what
 * the executor over in agent-tools.ts parses, so a field renamed on
 * one side and not the other is a silent argument that never arrives.
 * They were separate only because APM grew the definitions in its own
 * app before the executors moved up.
 *
 * The run_search schema descends from the native /search/agent UI's
 * captured request, which the Cribl agent endpoint validates against
 * — so the shape is a contract with the platform, not a local choice.
 *
 * `describe*` builders exist because the description is the only part
 * that is genuinely per-app: which datasets exist, which metric names
 * matter, what the agent should reach for first. Everything a model
 * needs to call the tool CORRECTLY is fixed; everything about what to
 * call it FOR is the caller's.
 */
import type { AgentToolDefinition } from './agent.js';

/** Time-range + limit properties shared by both data tools. */
const TIME_PROPS = {
  earliest: {
    type: ['string', 'number'],
    description:
      'Earliest time for the search. Relative (e.g. "-1h", "-1d") or an absolute Unix timestamp in seconds (e.g. 1700511360).',
    default: '-1h',
  },
  latest: {
    type: ['string', 'number'],
    description:
      'Latest time for the search. Relative (e.g. "now", "-5m") or an absolute Unix timestamp in seconds.',
    default: 'now',
  },
} as const;

export interface RunSearchDefinitionOptions {
  /**
   * Replaces the default tool description. Say what the datasets are
   * and which fields matter — that context is what stops a model
   * guessing at schema, and it's the one part no shared default can
   * supply.
   */
  description?: string;
}

/**
 * The run_search definition. Pair with `createRunSearchTool`.
 *
 * `confirmBeforeRunning` is in the schema because the platform's
 * validator requires it, and it is a HINT ONLY: whether a query runs
 * is decided by the injected `assertSafe` gate, never by a field the
 * model fills in. A model that sets it to false does not thereby get
 * to skip a check, and one that sets it to true does not get to
 * request a pause that the host hasn't implemented.
 */
export function runSearchDefinition(
  opts: RunSearchDefinitionOptions = {},
): AgentToolDefinition {
  return {
    id: 'run_search',
    description:
      opts.description ??
      'Run a read-only Cribl Search (KQL) query and get the result rows back. Every query must name its scope explicitly with dataset="…". Use this to inspect real data: what datasets hold, which fields exist, what values look like.',
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The KQL query to execute. Must be a valid, read-only Cribl search query.',
          minLength: 1,
        },
        ...TIME_PROPS,
        limit: {
          type: 'number',
          description: 'Maximum number of events to return.',
          minimum: 1,
          maximum: 1000,
          default: 10,
        },
        description: {
          type: 'string',
          description: 'A short description of the search that is about to be run.',
          maxLength: 100,
        },
        confirmBeforeRunning: {
          type: 'boolean',
          description:
            'Compatibility hint only — it does not control execution. Read-only queries run immediately; the read-only guard is enforced independently of this field.',
          default: false,
        },
      },
      required: ['query', 'description', 'confirmBeforeRunning'],
    },
  };
}

export interface RunMetricsQueryDefinitionOptions {
  /**
   * Appended to the base description. This is where a host documents
   * its own metric names, label sets, and counter semantics — a PromQL
   * tool with no metric catalog is a tool the model has to guess at.
   */
  metricsGuide?: string;
  /** Replaces the description outright, ignoring `metricsGuide`. */
  description?: string;
}

/**
 * The run_metrics_query definition. Pair with
 * `createRunMetricsQueryTool`.
 *
 * PromQL has no mutating forms, so this tool is read-only by
 * construction rather than by a gate.
 */
export function runMetricsQueryDefinition(
  opts: RunMetricsQueryDefinitionOptions = {},
): AgentToolDefinition {
  const base =
    'Run a PromQL query against the fast Cribl metrics store. MUCH faster than run_search for numeric time series — prefer it whenever a metric answers the question. Omit step for an instant snapshot; provide step (seconds) for a range/time-series. Only core PromQL is supported (no label_replace, no vector `or`).' +
    ' DISCOVERY: instead of PromQL, pass a dot-command to find out what exists before you query it — `.catalog [substring]` (metric names with their type, series count and whether anything queries them; start here), `.metadata [substring]` (name/type/help/unit), `.labels` (label names in the dataset), `.labels <metric>` (that metric\'s label dimensions, so you know what to group by), `.values <label>` (a label\'s values), `.series <metric>` (its label sets). Discovery returns a table, not a chart.';
  return {
    id: 'run_metrics_query',
    description:
      opts.description ?? (opts.metricsGuide ? `${base} ${opts.metricsGuide}` : base),
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'PromQL expression, e.g. sum(sum_over_time(some_counter[15m])) by (svc)',
          minLength: 1,
        },
        ...TIME_PROPS,
        step: {
          type: 'number',
          description:
            'Range-query step in seconds. Omit for an instant query (one sample per series at latest).',
          minimum: 15,
        },
        description: {
          type: 'string',
          description: 'A short description of the metrics query about to run.',
          maxLength: 100,
        },
      },
      required: ['query', 'description'],
    },
  };
}
