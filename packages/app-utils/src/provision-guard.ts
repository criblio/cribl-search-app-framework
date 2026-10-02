/**
 * Pre-apply tripwires for a scheduled-search provisioning plan.
 *
 * A provisioner that reports success at every step can still ship a plan
 * that silently corrupts what the app's pages read: one app's outage chain
 * baked `dataset=""` into 17 saved searches, wiped lookups with
 * `mode=overwrite` exports of zero rows, and wrote an unjoinable CSV from
 * a `(?i)` regex upstream of `export to lookup` — while every layer said
 * "ok". Each rule below is a failure that was observed in production; none
 * of them is visible to the saved-search API, which accepts all of them.
 *
 * Pure string validation — no I/O — so it runs identically in a CLI, in CI
 * against the app's real plan, and inside `reconcile()` / `planOnly()` /
 * `<ProvisioningPanel>` before anything is written.
 */
import type { ProvisionedSearch, SeedLookup } from './provisioner.js';

/** Identifier of one guard rule, for filtering and `disableRules`. */
export type ProvisionRule =
  | 'dataset-missing'
  | 'dataset-empty'
  | 'case-insensitive-regex-before-export'
  | 'mv-expand-before-export'
  | 'overwrite-without-sentinel'
  | 'empty-lookup-name'
  | 'invalid-name'
  | 'duplicate-id'
  | 'id-prefix';

/** One rule violation. `searchId` is the saved-search id, or
 * `seed:<lookup>` for a seed-lookup query. */
export interface ProvisionProblem {
  searchId: string;
  rule: ProvisionRule;
  message: string;
}

export interface ProvisionValidation {
  ok: boolean;
  problems: ProvisionProblem[];
}

export interface ValidateProvisionPlanOptions {
  /** The provisioner prefix. When given, every search id must start
   * with it: an unprefixed id is created once and then invisible to
   * `listProvisioned`, so every later reconcile re-creates it (409) and
   * nothing ever deletes it. */
  prefix?: string;
  /** Seed-lookup queries to validate alongside the searches. */
  seedLookups?: SeedLookup[];
  /** Rules to skip — an escape hatch for a heuristic false positive,
   * narrower than turning the whole guard off. */
  disableRules?: ProvisionRule[];
}

/** Error thrown by `reconcile`, `planOnly` and `applyProvisioningActions`
 * when a plan fails validation. Nothing has been written when it throws. */
export class ProvisionPlanError extends Error {
  readonly problems: ProvisionProblem[];

  constructor(problems: ProvisionProblem[]) {
    super(
      `Provisioning plan refused: ${problems.length} problem(s)\n` +
        problems.map((p) => `  ${p.searchId} [${p.rule}]: ${p.message}`).join('\n'),
    );
    this.name = 'ProvisionPlanError';
    this.problems = problems;
  }
}

/** Cribl's saved-search API answers any `name` outside this pattern with
 * HTTP 400 at create time — in the user's browser, long after CI passed. */
export const SAVED_SEARCH_NAME_PATTERN = /^[a-zA-Z0-9 _-]+$/;

const EXPORT_TO_LOOKUP = /\bexport\b[^|]*\bto\s+lookup\b/;
const DATASET_EMPTY = /\bdataset\s*=\s*(?:""|'')/;
const DATASET_PRESENT = /\bdataset\s*=\s*(?:"[^"]+"|'[^']+'|[A-Za-z0-9_$*-]+)/;
const STARTS_WITH_PRINT = /^\s*print\s/;

/** Drop `//` comment lines so prose that mentions `(?i)` or `mv-expand`
 * does not trip the checks aimed at real pipeline stages. */
function stripCommentLines(query: string): string {
  return query
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/** Validate one query. Exported for apps that build ad-hoc queries
 * outside a plan (e.g. a one-off export they run from a script). */
export function validateProvisionQuery(searchId: string, rawQuery: string): ProvisionProblem[] {
  const problems: ProvisionProblem[] = [];
  const add = (rule: ProvisionRule, message: string) => problems.push({ searchId, rule, message });
  const query = stripCommentLines(rawQuery);
  // A query that starts with `print` emits its own row and reads no
  // dataset, so it is exempt from the dataset rules (but not from the
  // empty-dataset rule, which also catches a `union (dataset="")`).
  const startsWithPrint = STARTS_WITH_PRINT.test(query);

  // An empty dataset reads zero rows forever while every layer above
  // reports success: a total outage of whatever the search feeds.
  if (DATASET_EMPTY.test(query)) {
    add('dataset-empty', 'empty dataset clause (dataset="") — this search reads nothing, forever');
  } else if (!startsWithPrint && !DATASET_PRESENT.test(query)) {
    add('dataset-missing', 'no dataset="…" clause found');
  }

  const exportMatch = EXPORT_TO_LOOKUP.exec(query);
  if (exportMatch) {
    // `(?i)` upstream of the export reported success and wrote a CSV
    // nothing could join against.
    const ci = query.indexOf('(?i)');
    if (ci !== -1 && ci < exportMatch.index) {
      add(
        'case-insensitive-regex-before-export',
        '(?i) inline regex flag upstream of export-to-lookup writes an unjoinable CSV; use character-class alternation ([Cc]onsume)',
      );
    }
    // Cribl planner bug: mv-expand upstream of the export fails the
    // lookup write stage.
    const mv = query.search(/\bmv-expand\b/);
    if (mv !== -1 && mv < exportMatch.index) {
      add(
        'mv-expand-before-export',
        'mv-expand upstream of export-to-lookup fails the lookup write (Cribl planner bug); split into a compute search and an export search',
      );
    }
    // An overwrite of zero rows deletes the lookup file on some Cribl
    // versions, and every `| lookup <name>` downstream then fails with
    // "Unknown lookup table name". The export only reliably fires when
    // the pipeline BASE emits a row, so the sentinel must come first:
    // `<real> | union (print …) | export` was verified to skip the export
    // when <real> is empty. A missing `mode=` is treated as overwrite.
    const isAppend = /\bmode\s*=\s*["']?append\b/.test(exportMatch[0]);
    if (!isAppend && !startsWithPrint) {
      add(
        'overwrite-without-sentinel',
        'overwrite export-to-lookup without a leading sentinel row; start the query with `print <sentinel columns> | union (<real query>) | export …` so an empty result cannot delete the lookup',
      );
    }
  }

  // An interpolated empty constant leaves `to lookup` dangling.
  if (/\bto\s+lookup\s*(?:\||$)/.test(query.trim())) {
    add('empty-lookup-name', 'export-to-lookup with an empty lookup name');
  }

  return problems;
}

/** Validate a saved-search display name against the pattern Cribl enforces. */
export function validateSavedSearchName(searchId: string, name: string): ProvisionProblem[] {
  if (SAVED_SEARCH_NAME_PATTERN.test(name)) return [];
  const bad = [...new Set([...name].filter((c) => !/[a-zA-Z0-9 _-]/.test(c)))];
  const detail = name ? `contains ${bad.map((c) => JSON.stringify(c)).join(', ')}` : 'is empty';
  return [
    {
      searchId,
      rule: 'invalid-name',
      message: `saved-search name ${JSON.stringify(name)} ${detail}; Cribl answers HTTP 400 for names outside ${SAVED_SEARCH_NAME_PATTERN.source}`,
    },
  ];
}

/**
 * Validate a whole plan: every search's query and name, id uniqueness,
 * the prefix (when given), and every seed-lookup query.
 *
 * ```ts
 * const { ok, problems } = validateProvisionPlan(getPlan(), { prefix: 'myapp__', seedLookups: SEEDS });
 * if (!ok) throw new ProvisionPlanError(problems);
 * ```
 */
export function validateProvisionPlan(
  targets: ProvisionedSearch[],
  opts: ValidateProvisionPlanOptions = {},
): ProvisionValidation {
  const problems: ProvisionProblem[] = [];
  const seen = new Set<string>();
  for (const search of targets) {
    problems.push(...validateProvisionQuery(search.id, search.query));
    problems.push(...validateSavedSearchName(search.id, search.name));
    if (seen.has(search.id)) {
      problems.push({ searchId: search.id, rule: 'duplicate-id', message: 'id appears more than once in the plan' });
    }
    seen.add(search.id);
    if (opts.prefix !== undefined && !search.id.startsWith(opts.prefix)) {
      problems.push({
        searchId: search.id,
        rule: 'id-prefix',
        message: `id does not start with the provisioner prefix ${JSON.stringify(opts.prefix)}; it would be created once and never seen, updated or deleted again`,
      });
    }
  }
  for (const seed of opts.seedLookups ?? []) {
    const id = `seed:${seed.name}`;
    if (!seed.name.trim()) {
      problems.push({ searchId: id, rule: 'empty-lookup-name', message: 'seed lookup has an empty name' });
    }
    problems.push(...validateProvisionQuery(id, seed.seedQuery));
  }
  const disabled = new Set(opts.disableRules ?? []);
  const kept = problems.filter((p) => !disabled.has(p.rule));
  return { ok: kept.length === 0, problems: kept };
}
