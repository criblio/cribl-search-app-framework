/**
 * Search over the Cribl OpenAPI digest — the "what can I even call?"
 * half of the cribl_api tool.
 *
 * The digest is generated at build time by
 * scripts/build-openapi-digest.mjs; see that file for why the 8 MB
 * spec is not loaded at runtime. Consumers pass the parsed digest in
 * rather than this module importing the JSON, so a host can ship its
 * own (a different Cribl version, or a trimmed subset) and so nothing
 * pulls a 580 KB import into a browser TS graph that doesn't want it.
 */

/** One parameter of one operation, as kept in the digest. */
export interface DigestParam {
  name: string;
  in?: string;
  required?: true;
  type?: string;
  description?: string;
}

/** One operation. Field names are short because there are ~900. */
export interface DigestOp {
  method: string;
  path: string;
  operationId?: string;
  tag?: string;
  summary?: string;
  /** `x-cribl-internal` in the spec: excluded from Cribl's generated
   *  SDKs. NOT the same as unusable — see the generator's note. */
  internal?: true;
  params?: DigestParam[];
  /** JSON request-body schema, $refs already followed. */
  body?: unknown;
}

export interface OpenApiDigest {
  specVersion: string;
  generatedFrom?: string;
  ops: DigestOp[];
}

/** The only verbs that don't change state. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a method mutates.
 *
 * Defined as "not a read" rather than as a list of writes on purpose:
 * an unrecognized verb — a typo, a method Cribl adds later — is then
 * treated as a write, so the unknown case fails toward asking the user
 * instead of toward acting without them. An allowlist of writes would
 * fail the other way.
 */
export function isWriteMethod(method: string): boolean {
  return !READ_METHODS.has(method.trim().toUpperCase());
}

/**
 * Turn a concrete request path into the digest's templated form so a
 * real call can be matched against the spec: `/search/jobs/abc123`
 * becomes a candidate for `/search/jobs/{id}`.
 *
 * Segment count must match exactly; a literal segment beats a template
 * one, so `/search/jobs/{id}` and `/search/jobs/cancel` don't collide.
 */
export function matchOperation(
  digest: OpenApiDigest,
  method: string,
  path: string,
): DigestOp | undefined {
  const m = method.trim().toUpperCase();
  const want = path.split('?')[0].replace(/\/+$/, '').split('/').filter(Boolean);
  let best: { op: DigestOp; literals: number } | undefined;
  for (const op of digest.ops) {
    if (op.method !== m) continue;
    const have = op.path.split('/').filter(Boolean);
    if (have.length !== want.length) continue;
    let literals = 0;
    let ok = true;
    for (let i = 0; i < have.length; i++) {
      const seg = have[i];
      if (seg.startsWith('{') && seg.endsWith('}')) continue;
      if (seg !== want[i]) {
        ok = false;
        break;
      }
      literals++;
    }
    if (ok && (!best || literals > best.literals)) best = { op, literals };
  }
  return best?.op;
}

export interface SearchOptions {
  /** Restrict to one method. */
  method?: string;
  /** Restrict to writes (true) or reads (false). */
  writes?: boolean;
  /** Max results. Defaults to 40 — enough to choose from, small
   *  enough that the whole list stays a readable tool result. */
  limit?: number;
}

/** A scored search hit. `score` is exposed only for testing ordering. */
export interface SearchHit {
  op: DigestOp;
  score: number;
  /** Which of the query's terms this operation actually matched. Fewer
   *  than the whole query means the search fell back to partial
   *  matching — see {@link searchOperations}. Callers should say so
   *  rather than presenting a loose list as an exact answer. */
  terms: string[];
}

/**
 * Split a free-text query into the terms the scorer matches on.
 *
 * Exported so a caller can report which of the user's own words did
 * nothing — the difference between "no endpoint does this" and "you
 * used two words that appear nowhere in any spec" is the whole
 * difference between a dead end and a next move.
 */
export function searchTerms(query: string): string[] {
  // De-duplicated: a repeated word would otherwise score twice and
  // inflate its operation over an equally relevant one.
  return [...new Set(query.toLowerCase().split(/[^a-z0-9_.{}-]+/i).filter(Boolean))];
}

/** The four fields a term is matched against, lowercased once. */
interface OpText {
  path: string;
  id: string;
  tag: string;
  summary: string;
}

function opText(op: DigestOp): OpText {
  return {
    path: op.path.toLowerCase(),
    id: (op.operationId ?? '').toLowerCase(),
    tag: (op.tag ?? '').toLowerCase(),
    summary: (op.summary ?? '').toLowerCase(),
  };
}

/**
 * How strongly one term matches one operation; 0 means not at all.
 *
 * Weighted by how much a field says about what an endpoint IS: the path
 * is the strongest signal, the summary the weakest.
 */
function scoreTerm(t: OpText, term: string): number {
  let score = 0;
  if (t.path.includes(term)) score += 10;
  if (t.id.includes(term)) score += 6;
  if (t.tag === term) score += 6;
  else if (t.tag.includes(term)) score += 3;
  if (t.summary.includes(term)) score += 2;
  return score;
}

/**
 * Rank operations against a free-text query.
 *
 * Deliberately a plain scorer, not a fuzzy index: the corpus is ~900
 * short strings, the queries are things like "create a search job" or
 * "kvstore", and the cost of a wrong ranking is one extra tool call.
 *
 * Operations matching EVERY term win outright, and if any exist they
 * are the whole result — that AND is what stops "search unicorns" from
 * returning the several hundred endpoints that merely say "search".
 * When nothing matches every term, though, the answer is not silence:
 * it falls back to everything matching at least one, ranked by the same
 * score. A model asked to find Stream metrics wrote "Stream worker
 * input output metrics statistics event bytes per second" — ten terms,
 * no endpoint has all ten, and the AND-only version answered "no
 * endpoints matched" about a spec that describes `/system/metrics/query`
 * one summary line away. Under the fallback that endpoint ranks third.
 *
 * The fallback ranks by SCORE, not by how many terms an operation
 * covers. Coverage sounds better and measures worse: on that same
 * query the highest-coverage hits were `/system/inputs/{id}/pq` and
 * `/search/event-breaker-preview` — "input"+"per" (from
 * "persistent") and "output"+"event" — while every `/system/metrics*`
 * endpoint matched the one term that mattered. Broad words pair up by
 * accident; a single strong path hit does not.
 */
export function searchOperations(
  digest: OpenApiDigest,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const wantMethod = opts.method?.trim().toUpperCase();
  const full: SearchHit[] = [];
  const partial: SearchHit[] = [];

  for (const op of digest.ops) {
    if (wantMethod && op.method !== wantMethod) continue;
    if (opts.writes !== undefined && isWriteMethod(op.method) !== opts.writes) continue;

    const text = opText(op);
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      const termScore = scoreTerm(text, term);
      if (termScore === 0) continue;
      matched.push(term);
      score += termScore;
    }
    if (matched.length === 0) continue;

    // Prefer the plainest endpoint that matches: a shorter path with
    // fewer template segments is nearly always the one a caller means
    // (`/apps` over `/p/{pack}/apps/{id}/acl/teams`).
    score -= op.path.split('/').length;
    score -= (op.path.match(/\{/g) ?? []).length * 2;
    // SDK-supported routes outrank internal ones at equal relevance.
    if (op.internal) score -= 5;

    (matched.length === terms.length ? full : partial).push({ op, score, terms: matched });
  }

  const hits = full.length > 0 ? full : partial;
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.op.path.localeCompare(b.op.path) ||
      a.op.method.localeCompare(b.op.method),
  );
  return hits.slice(0, opts.limit ?? 40);
}

/**
 * The query terms that appear in no operation at all.
 *
 * Ignores the method/writes filters on purpose: this answers "is this
 * word in the spec anywhere", which is what a caller needs to tell a
 * model to drop it. Filter-induced emptiness is a different message.
 */
export function unmatchedTerms(digest: OpenApiDigest, query: string): string[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const remaining = new Set(terms);
  for (const op of digest.ops) {
    if (remaining.size === 0) break;
    const text = opText(op);
    for (const term of [...remaining]) {
      if (scoreTerm(text, term) > 0) remaining.delete(term);
    }
  }
  return terms.filter((t) => remaining.has(t));
}

/** One-line rendering of an operation, for a list of search results. */
export function formatOpLine(op: DigestOp): string {
  const flags = [op.internal ? 'internal' : null].filter(Boolean).join(' ');
  return [
    `${op.method} ${op.path}`,
    op.summary ? `— ${op.summary}` : null,
    op.tag ? `[${op.tag}]` : null,
    flags ? `(${flags})` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Full rendering of one operation: everything needed to construct the
 * call. Returned as pretty JSON — a model reads a schema far more
 * reliably as JSON than as prose, and these are ~500 bytes at the
 * median.
 */
export function formatOpDetail(op: DigestOp): string {
  const detail = {
    method: op.method,
    path: op.path,
    operationId: op.operationId,
    tag: op.tag,
    summary: op.summary,
    internal: op.internal,
    write: isWriteMethod(op.method),
    params: op.params,
    requestBody: op.body,
  };
  return JSON.stringify(detail, null, 1);
}
