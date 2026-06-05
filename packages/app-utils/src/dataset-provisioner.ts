/**
 * Dataset-level reconciliation primitives.
 *
 * The framework already exports a *saved-search* provisioner
 * (./provisioner.ts) which reconciles `criblapp__*` scheduled
 * searches against a plan. Apps that need to ensure other dataset-
 * adjacent state — most commonly accelerated fields and a flatten-
 * extend rule in the default ruleset — duplicate the same shape
 * (read state → diff → patch) per app. This module factors that
 * shape out.
 *
 * Two pieces are supported, independently:
 *
 *   1. Accelerated fields — push a list of field ids onto the
 *      dataset's `acceleratedFields` array. Never removes fields
 *      the user added themselves. Used for indexed-field pushdown.
 *
 *   2. Ruleset rule — ensure a single rule with a given id exists
 *      in the default ruleset. Optionally re-checks the rule body
 *      via a `validate` callback, treating "present but stale" as
 *      an update. Inserts new rules before a configured anchor id
 *      (default `'default'`, the catch-all) so the new rule wins
 *      against generic matchers.
 *
 * Apps supply the API path and the expected values. The otel-
 * specific bits (rule body, exact field list) live in the consumer
 * repo, not here.
 */

import type { HttpClient } from './provisioner.js';

// ────────────────────────────────────────────────────────────────
// Path helpers
// ────────────────────────────────────────────────────────────────

/** Default Cribl Search worker group used by hosted Cribl Cloud. */
export const DEFAULT_SEARCH_GROUP = 'default_search';

/** API path for a dataset config object. */
export function datasetPath(
  datasetId: string,
  searchGroup: string = DEFAULT_SEARCH_GROUP,
): string {
  return `/m/${searchGroup}/search/datasets/${datasetId}`;
}

/** API path for the default dataset-rulesets object. */
export function rulesetPath(
  searchGroup: string = DEFAULT_SEARCH_GROUP,
): string {
  return `/m/${searchGroup}/search/local_search/dataset-rulesets/default`;
}

// ────────────────────────────────────────────────────────────────
// Wire types
// ────────────────────────────────────────────────────────────────

export interface AcceleratedField {
  id: string;
  createdAt?: number;
}

export interface DatasetRule {
  id: string;
  name?: string;
  description?: string;
  sendDataTo: string;
  dataset: string;
  kustoExpression: string;
  extendExpressionEnabled?: boolean;
  extendExpression?: string;
  disabled?: boolean;
}

interface DatasetObject {
  id: string;
  acceleratedFields?: AcceleratedField[];
  [key: string]: unknown;
}

interface DatasetResponse {
  items?: DatasetObject[];
}

interface RulesetObject {
  id: string;
  rules: DatasetRule[];
}

interface RulesetResponse {
  items?: RulesetObject[];
}

// ────────────────────────────────────────────────────────────────
// Accelerated fields
// ────────────────────────────────────────────────────────────────

export interface AcceleratedFieldsStatus {
  /** All expected fields are present. */
  ok: boolean;
  /** Field ids currently set on the dataset (subset of all known). */
  present: string[];
  /** Expected fields not currently set. */
  missing: string[];
  reason?: 'fetch-failed';
}

export interface AcceleratedFieldsResult {
  action: 'noop' | 'create' | 'update';
  /** Newly-added field ids. Empty when noop. */
  added: string[];
  reason?: string;
}

/** Read whether the expected field ids are set as accelerated on
 * the dataset. Never throws — fetch failure degrades to ok=false
 * with all expected fields marked missing. */
export async function getAcceleratedFieldsStatus(
  http: HttpClient,
  path: string,
  expected: readonly string[],
): Promise<AcceleratedFieldsStatus> {
  try {
    const resp = (await http.get(path)) as DatasetResponse;
    const dataset = resp?.items?.[0];
    const present = (dataset?.acceleratedFields ?? []).map((f) => f.id);
    const presentSet = new Set(present);
    const missing = expected.filter((f) => !presentSet.has(f));
    return { ok: missing.length === 0, present, missing };
  } catch {
    return {
      ok: false,
      present: [],
      missing: [...expected],
      reason: 'fetch-failed',
    };
  }
}

/** Push the expected field ids onto the dataset's
 * `acceleratedFields` array. Idempotent — if every expected id is
 * already present, returns noop. Never removes fields the user has
 * added themselves. */
export async function ensureAcceleratedFields(
  http: HttpClient,
  path: string,
  expected: readonly string[],
): Promise<AcceleratedFieldsResult> {
  let current: DatasetObject | undefined;
  try {
    const resp = (await http.get(path)) as DatasetResponse;
    current = resp?.items?.[0];
  } catch (err) {
    return {
      action: 'noop',
      added: [],
      reason: `fetch failed: ${(err as Error).message}`,
    };
  }
  if (!current) {
    return { action: 'noop', added: [], reason: 'dataset not found' };
  }

  const presentArr = current.acceleratedFields ?? [];
  const presentSet = new Set(presentArr.map((f) => f.id));
  const missing = expected.filter((f) => !presentSet.has(f));
  if (missing.length === 0) {
    return { action: 'noop', added: [] };
  }

  const nextFields: AcceleratedField[] = [
    ...presentArr,
    ...missing.map((id) => ({ id })),
  ];
  await http.patch(path, { acceleratedFields: nextFields });
  return {
    action: presentArr.length === 0 ? 'create' : 'update',
    added: missing,
  };
}

// ────────────────────────────────────────────────────────────────
// Ruleset rule
// ────────────────────────────────────────────────────────────────

export interface RulesetRuleStatus {
  ok: boolean;
  reason?: 'missing-rule' | 'invalid' | 'fetch-failed';
}

export interface RulesetRuleResult {
  action: 'noop' | 'create' | 'update';
  reason?: string;
}

/** True if the rule is considered correct. Default acceptance:
 * the rule exists. Pass `validate` to additionally check the body. */
export type RuleValidator = (rule: DatasetRule) => boolean;

interface EnsureRuleOptions {
  /** Custom acceptance check for the rule body. If supplied and
   * returns false against the existing rule, the reconcile updates
   * the rule. If not supplied, presence alone is sufficient. */
  validate?: RuleValidator;
  /** When inserting a new rule, place it before the rule with this
   * id (or at the end if not found). Defaults to `'default'` — the
   * catch-all rule in the default ruleset. */
  insertBefore?: string;
}

/** Read whether the rule is present + valid in the ruleset. */
export async function getRulesetRuleStatus(
  http: HttpClient,
  path: string,
  ruleId: string,
  validate?: RuleValidator,
): Promise<RulesetRuleStatus> {
  try {
    const resp = (await http.get(path)) as RulesetResponse;
    const ruleset = resp?.items?.[0];
    const rules = ruleset?.rules ?? [];
    const rule = rules.find((r) => r.id === ruleId);
    if (!rule) return { ok: false, reason: 'missing-rule' };
    if (validate && !validate(rule)) return { ok: false, reason: 'invalid' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'fetch-failed' };
  }
}

/** Ensure the expected rule exists in the ruleset. If missing,
 * inserts it before `insertBefore` (default `'default'`). If
 * present but invalid per the `validate` callback, merges the
 * expected rule's fields onto the existing one. */
export async function ensureRulesetRule(
  http: HttpClient,
  path: string,
  expected: DatasetRule,
  options?: EnsureRuleOptions,
): Promise<RulesetRuleResult> {
  const { validate, insertBefore = 'default' } = options ?? {};

  let current: RulesetObject | undefined;
  try {
    const resp = (await http.get(path)) as RulesetResponse;
    current = resp?.items?.[0];
  } catch (err) {
    return { action: 'noop', reason: `fetch failed: ${(err as Error).message}` };
  }
  if (!current) {
    return { action: 'noop', reason: 'ruleset not found' };
  }

  const rules = current.rules ?? [];
  const idx = rules.findIndex((r) => r.id === expected.id);
  let nextRules = rules;
  let action: 'noop' | 'create' | 'update' = 'noop';

  if (idx < 0) {
    const insertAt = rules.findIndex((r) => r.id === insertBefore);
    const at = insertAt < 0 ? rules.length : insertAt;
    nextRules = [...rules.slice(0, at), expected, ...rules.slice(at)];
    action = 'create';
  } else if (validate && !validate(rules[idx])) {
    nextRules = [
      ...rules.slice(0, idx),
      { ...rules[idx], ...expected },
      ...rules.slice(idx + 1),
    ];
    action = 'update';
  }

  if (action !== 'noop') {
    await http.patch(path, { id: current.id, rules: nextRules });
  }
  return { action };
}
