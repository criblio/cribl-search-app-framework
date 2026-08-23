/** Shared validation and serialization boundary for generated or untrusted KQL. */

export class KqlSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KqlSafetyError';
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_FIELD_KEY = /^[A-Za-z0-9_.:/@-]+$/;
const RELATIVE_TIME = /^-\d+(?:s|m|h|d|w)$/;

export function kqlDatasetId(value: string): string {
  const id = value.trim();
  if (!id || id.length > 128 || !SAFE_ID.test(id)) {
    throw new KqlSafetyError('dataset ID contains unsupported characters');
  }
  return id;
}

export function kqlStringLiteral(value: string): string {
  if (value.length > 16_384) throw new KqlSafetyError('KQL string literal is too long');
  const escaped = Array.from(value, (char) => {
    if (char === '\\') return '\\\\';
    if (char === '"') return '\\"';
    if (char === '\r') return '\\r';
    if (char === '\n') return '\\n';
    if (char === '\t') return '\\t';
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) {
      return `\\u${code.toString(16).padStart(4, '0')}`;
    }
    return char;
  }).join('');
  return `"${escaped}"`;
}

export function kqlFieldKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 256 || !SAFE_FIELD_KEY.test(key)) {
    throw new KqlSafetyError('field name contains unsupported characters');
  }
  return key;
}

export function kqlBracketField(value: string): string {
  return `['${kqlFieldKey(value)}']`;
}

export function kqlFiniteNumber(
  value: number,
  opts: { min?: number; max?: number } = {},
): string {
  if (!Number.isFinite(value)) throw new KqlSafetyError('KQL number must be finite');
  if (opts.min !== undefined && value < opts.min) {
    throw new KqlSafetyError(`KQL number must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new KqlSafetyError(`KQL number must be <= ${opts.max}`);
  }
  return String(value);
}

export function kqlInteger(
  value: number,
  opts: { min?: number; max?: number } = {},
): string {
  if (!Number.isSafeInteger(value)) throw new KqlSafetyError('KQL integer is invalid');
  return kqlFiniteNumber(value, opts);
}

export function kqlTime(value: string | number): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new KqlSafetyError('absolute search time must be a positive Unix timestamp');
    }
    return String(value);
  }
  const time = value.trim();
  if (time === 'now' || RELATIVE_TIME.test(time) || /^\d{10,13}$/.test(time)) {
    return time;
  }
  throw new KqlSafetyError('search time must be now, a relative duration, or a Unix timestamp');
}

function maskStrings(input: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let out = '';
  for (const ch of input) {
    if (quote) {
      out += ' ';
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ' ';
    } else {
      out += ch;
    }
  }
  if (quote) throw new KqlSafetyError('unterminated KQL string literal');
  return out;
}

function assertBalanced(masked: string): void {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (const ch of masked) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch in pairs && stack.pop() !== pairs[ch]) {
      throw new KqlSafetyError('unbalanced KQL delimiter');
    }
  }
  if (stack.length > 0) throw new KqlSafetyError('unbalanced KQL delimiter');
}

const PREDICATE_FORBIDDEN_WORDS = new Set([
  'dataset', 'send', 'export', 'externaldata', 'union', 'join', 'lookup',
  'print', 'range', 'render', 'let', 'set', 'evaluate',
]);

/** Accept a boolean expression only; pipeline stages and statements are forbidden. */
export function assertKqlPredicate(input: string): string {
  const predicate = input.trim();
  if (!predicate) return '';
  if (predicate.length > 4_000) throw new KqlSafetyError('KQL predicate is too long');
  const masked = maskStrings(predicate);
  if (masked.includes('|') || masked.includes(';')) {
    throw new KqlSafetyError('advanced KQL accepts a predicate only, not pipeline stages');
  }
  if (/\/\/|\/\*/.test(masked)) {
    throw new KqlSafetyError('comments are not allowed in an advanced KQL predicate');
  }
  assertBalanced(masked);
  const words = masked.toLowerCase().match(/[a-z_][a-z0-9_-]*/g) ?? [];
  const forbidden = words.find((word) => PREDICATE_FORBIDDEN_WORDS.has(word));
  if (forbidden) throw new KqlSafetyError(`operator ${forbidden} is not valid in a predicate`);
  return predicate;
}

const SIDE_EFFECT_STAGES = new Set(['send', 'export', 'externaldata']);

/**
 * Pass instead of an allowlist to accept ANY dataset id while keeping
 * every other read-only check.
 *
 * The allowlist exists for apps scoped to their own dataset, where a
 * query naming a different one is a bug. It's wrong for a host whose
 * job is exploring what data a workspace has — there the set of legal
 * datasets isn't known up front, and an allowlist would have to be
 * "everything the caller could discover", which is not a list.
 *
 * This drops the membership check ONLY. The query must still be a
 * read-only pipeline with an explicit double-quoted `dataset="…"`
 * scope: no `;`, no dot-commands, no `send`/`export`/`externaldata`,
 * balanced delimiters, no computed dataset name. Reading a dataset
 * the caller shouldn't see is a question for the bearer token's
 * permissions, which is where it belongs — this function only ever
 * decided whether a query is a READ, and it still does.
 *
 * `Symbol.for` (not a bare `Symbol`) so the identity check holds when
 * two copies of this module end up loaded at once — which happens
 * here, since consumers inline the published `dist/` under vitest
 * while resolving `src/` elsewhere.
 */
export const ANY_DATASET = Symbol.for('cribl.app-utils.kql.anyDataset');

/**
 * Validate a complete read-only query, either within a caller-provided
 * dataset allowlist or (with {@link ANY_DATASET}) against any dataset.
 */
export function assertReadOnlyKql(
  input: string,
  allowedDatasets: readonly string[] | typeof ANY_DATASET,
): string {
  const query = input.trim();
  if (!query) throw new KqlSafetyError('search query is required');
  if (query.length > 20_000) throw new KqlSafetyError('search query is too long');
  const noComments = query.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const masked = maskStrings(noComments);
  assertBalanced(masked);
  if (masked.includes(';') || /(^|\n)\s*\./.test(masked)) {
    throw new KqlSafetyError('KQL commands and statements are not allowed');
  }
  for (const match of masked.matchAll(/\|\s*([a-z][a-z0-9-]*)/gi)) {
    const stage = match[1].toLowerCase();
    if (SIDE_EFFECT_STAGES.has(stage)) {
      throw new KqlSafetyError(`side-effect operator ${stage} is not allowed`);
    }
  }
  const anyDataset = allowedDatasets === ANY_DATASET;
  const allowed = anyDataset ? null : new Set(allowedDatasets.map(kqlDatasetId));
  allowed?.add('$vt_results');
  const clauses = [...query.matchAll(/\bdataset\s*=\s*"([^"]+)"/gi)];
  if (clauses.length === 0) throw new KqlSafetyError('query must use an explicit dataset="…" scope');
  const maskedDatasetCount = (masked.match(/\bdataset\s*=/gi) ?? []).length;
  if (clauses.length !== maskedDatasetCount) {
    throw new KqlSafetyError('dataset scopes must use a double-quoted literal');
  }
  for (const match of clauses) {
    const dataset = match[1];
    if (allowed) {
      if (!allowed.has(dataset)) {
        throw new KqlSafetyError(`dataset ${dataset} is outside the investigation scope`);
      }
      continue;
    }
    // ANY_DATASET still validates the id's SHAPE. Membership is what's
    // waived, not the character set: the name is interpolated into a
    // query, so `dataset="a" | send …` hiding in the literal would
    // otherwise sail through the stage scan above.
    if (dataset !== '$vt_results') kqlDatasetId(dataset);
  }
  return query;
}
