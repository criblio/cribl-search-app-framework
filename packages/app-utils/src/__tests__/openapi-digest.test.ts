/**
 * Digest search and path matching.
 *
 * The generated digest itself is checked here too (openapi-digest.json
 * is committed, so a regeneration that silently loses the endpoints
 * anyone actually calls should fail a test rather than a session).
 */
import { describe, expect, it } from 'vitest';
import {
  formatOpLine,
  isWriteMethod,
  matchOperation,
  searchOperations,
  searchTerms,
  unmatchedTerms,
  type OpenApiDigest,
} from '../openapi-digest.js';
import generated from '../openapi-digest.json' with { type: 'json' };

const DIGEST: OpenApiDigest = {
  specVersion: 't',
  ops: [
    { method: 'GET', path: '/search/jobs', operationId: 'listSearchJob', tag: 'search', summary: 'List all search jobs' },
    { method: 'POST', path: '/search/jobs', operationId: 'createSearchJob', tag: 'search' },
    { method: 'GET', path: '/search/jobs/{id}', operationId: 'getSearchJob', tag: 'search' },
    { method: 'DELETE', path: '/search/jobs/{id}/cancel', tag: 'search' },
    { method: 'GET', path: '/p/{pack}/search/jobs/{id}/acl/teams', tag: 'search', internal: true },
    { method: 'GET', path: '/apps', operationId: 'listApps', tag: 'apps', summary: 'List installed apps' },
  ],
};

describe('isWriteMethod', () => {
  it.each(['GET', 'get', ' HEAD ', 'options'])('%s is a read', (m) => {
    expect(isWriteMethod(m)).toBe(false);
  });

  it.each(['POST', 'put', 'PATCH', 'delete'])('%s is a write', (m) => {
    expect(isWriteMethod(m)).toBe(true);
  });

  it('treats an unknown verb as a write', () => {
    // Fails toward asking the user rather than toward acting.
    expect(isWriteMethod('PURGE')).toBe(true);
    expect(isWriteMethod('')).toBe(true);
  });
});

describe('searchTerms', () => {
  it('splits on anything that is not a path character', () => {
    expect(searchTerms('Create a search-job {id}!')).toEqual([
      'create',
      'a',
      'search-job',
      '{id}',
    ]);
  });

  it('de-duplicates so a repeated word cannot score twice', () => {
    expect(searchTerms('metrics METRICS metrics')).toEqual(['metrics']);
  });
});

describe('searchOperations', () => {
  it('prefers operations matching every term', () => {
    const hits = searchOperations(DIGEST, 'search jobs');
    expect(hits).not.toHaveLength(0);
    // Every returned hit covers the whole query, and `/apps` — which
    // matches neither word — is nowhere in it.
    expect(hits.every((h) => h.terms.length === 2)).toBe(true);
    expect(hits.map((h) => h.op.path)).not.toContain('/apps');
  });

  it('does not dilute a full match with partial ones', () => {
    // The AND is what keeps "search unicorns" from returning the whole
    // /search family; the fallback below must not undo that when
    // something genuinely matches everything.
    const hits = searchOperations(DIGEST, 'apps listApps');
    expect(hits.map((h) => h.op.path)).toEqual(['/apps']);
  });

  it('falls back to partial matches instead of answering nothing', () => {
    // The real report: a model looking for Stream metrics wrote nine
    // words, no endpoint had all nine, and an AND-only search said "no
    // endpoints matched" about a spec that documents the endpoint. The
    // words it got right have to survive the ones it got wrong.
    const hits = searchOperations(DIGEST, 'search jobs unicorns rainbows');
    expect(hits).not.toHaveLength(0);
    expect(hits[0].op.path).toBe('/search/jobs');
    // And the hit reports what it actually matched, so a caller can say
    // which words were ignored rather than presenting a loose list as
    // an exact one.
    expect(hits[0].terms.sort()).toEqual(['jobs', 'search']);
  });

  it('ranks a partial fallback by score, not by term coverage', () => {
    // Coverage is the tempting metric and the wrong one: broad words
    // pair up by accident. Here `/apps` matches two weak summary words
    // while `/search/jobs` matches one strong path word — and the path
    // hit is what the caller meant.
    const d: OpenApiDigest = {
      specVersion: 't',
      ops: [
        { method: 'GET', path: '/search/jobs', tag: 'search' },
        { method: 'GET', path: '/apps', summary: 'Installed things per tenant' },
      ],
    };
    const hits = searchOperations(d, 'jobs per tenant');
    expect(hits[0].op.path).toBe('/search/jobs');
    expect(hits[0].terms).toEqual(['jobs']);
    expect(hits[1].terms).toEqual(['per', 'tenant']);
  });

  it('finds the real metrics endpoint from an over-specified query', () => {
    // Verbatim from the session that prompted this change.
    const hits = searchOperations(
      generated as OpenApiDigest,
      'Stream worker input output metrics statistics event bytes per second',
    );
    const paths = hits.slice(0, 5).map((h) => h.op.path);
    expect(paths).toContain('/system/metrics/query');
  });

  it('prefers the plainest path over a deep templated one', () => {
    const hits = searchOperations(DIGEST, 'jobs');
    expect(hits[0].op.path).toBe('/search/jobs');
    const paths = hits.map((h) => h.op.path);
    expect(paths.indexOf('/search/jobs')).toBeLessThan(
      paths.indexOf('/p/{pack}/search/jobs/{id}/acl/teams'),
    );
  });

  it('filters by method and by write-ness', () => {
    expect(searchOperations(DIGEST, 'jobs', { method: 'post' }).every((h) => h.op.method === 'POST')).toBe(true);
    expect(searchOperations(DIGEST, 'jobs', { writes: false }).every((h) => !isWriteMethod(h.op.method))).toBe(true);
  });

  it('matches an operationId the path does not contain', () => {
    expect(searchOperations(DIGEST, 'listApps')[0].op.path).toBe('/apps');
  });

  it('honours limit and returns nothing for an empty query', () => {
    expect(searchOperations(DIGEST, 'jobs', { limit: 2 })).toHaveLength(2);
    expect(searchOperations(DIGEST, '   ')).toHaveLength(0);
  });

  it('still returns nothing when no term appears anywhere', () => {
    // The fallback is partial, not unconditional: a query with no
    // purchase at all must still come back empty so the caller can say
    // so, rather than being handed an arbitrary top-40.
    expect(searchOperations(DIGEST, 'unicorns rainbows')).toHaveLength(0);
  });
});

describe('unmatchedTerms', () => {
  it('names the words that appear in no operation', () => {
    expect(unmatchedTerms(DIGEST, 'search unicorns jobs rainbows')).toEqual([
      'unicorns',
      'rainbows',
    ]);
  });

  it('is empty when every word lands somewhere', () => {
    expect(unmatchedTerms(DIGEST, 'search apps')).toEqual([]);
    expect(unmatchedTerms(DIGEST, '')).toEqual([]);
  });

  it('ignores the method and writes filters', () => {
    // "Does this word exist in the spec" is a different question from
    // "did the filtered search return anything", and conflating them
    // tells a model to reword a query whose only problem was a filter.
    expect(unmatchedTerms(DIGEST, 'cancel')).toEqual([]);
    expect(searchOperations(DIGEST, 'cancel', { method: 'GET' })).toHaveLength(0);
  });
});

describe('matchOperation', () => {
  it('binds a concrete id to the templated path', () => {
    expect(matchOperation(DIGEST, 'GET', '/search/jobs/abc-123')?.operationId).toBe('getSearchJob');
  });

  it('prefers a literal segment over a template one', () => {
    // /search/jobs/{id} and a hypothetical literal must not collide.
    const d: OpenApiDigest = {
      specVersion: 't',
      ops: [
        { method: 'GET', path: '/a/{id}', operationId: 'byId' },
        { method: 'GET', path: '/a/summary', operationId: 'summary' },
      ],
    };
    expect(matchOperation(d, 'GET', '/a/summary')?.operationId).toBe('summary');
    expect(matchOperation(d, 'GET', '/a/xyz')?.operationId).toBe('byId');
  });

  it('requires the same segment count', () => {
    expect(matchOperation(DIGEST, 'GET', '/search/jobs/a/b')).toBeUndefined();
  });

  it('ignores a query string and a trailing slash', () => {
    expect(matchOperation(DIGEST, 'GET', '/search/jobs/?limit=1')?.operationId).toBe('listSearchJob');
    expect(matchOperation(DIGEST, 'GET', '/search/jobs/x?a=b')?.operationId).toBe('getSearchJob');
  });

  it('is method-specific', () => {
    expect(matchOperation(DIGEST, 'POST', '/search/jobs')?.operationId).toBe('createSearchJob');
    expect(matchOperation(DIGEST, 'PATCH', '/search/jobs')).toBeUndefined();
  });
});

describe('formatOpLine', () => {
  it('flags internal without hiding the endpoint', () => {
    expect(formatOpLine({ method: 'GET', path: '/x', internal: true })).toContain('(internal)');
    expect(formatOpLine({ method: 'GET', path: '/x' })).not.toContain('internal');
  });
});

describe('the committed digest', () => {
  const digest = generated as OpenApiDigest;

  it('carries a spec version and a useful number of operations', () => {
    expect(digest.specVersion).toMatch(/\d+\.\d+/);
    expect(digest.ops.length).toBeGreaterThan(500);
  });

  it.each([
    ['GET', '/search/jobs'],
    ['POST', '/search/jobs'],
    ['GET', '/search/jobs/{id}/results'],
    ['GET', '/search/datasets'],
    ['GET', '/search/saved'],
    ['GET', '/apps'],
    ['GET', '/system/info'],
    // The endpoint metrics.ts sends to (as /m/default_search/search/query).
    ['GET', '/search/query'],
  ])('still describes %s %s', (method, path) => {
    // A regeneration that drops these is the failure mode worth
    // catching: they're the endpoints an app is most likely to use.
    expect(matchOperation(digest, method, path)).toBeDefined();
  });

  it('keeps internal endpoints, flagged rather than dropped', () => {
    // x-cribl-internal excludes an endpoint from Cribl's generated
    // SDKs, which is not the same as unusable. An earlier generator
    // filtered them out and lost 133 operations, including the whole
    // search.metrics tag. Flagging lets a model prefer a supported
    // route and still find the one that exists.
    const internal = digest.ops.filter((op) => op.internal);
    expect(internal.length).toBeGreaterThan(50);
    const metricsQuery = matchOperation(digest, 'POST', '/search/metrics/query');
    expect(metricsQuery?.internal).toBe(true);
  });

  it('resolved every internal $ref', () => {
    // A dangling ref means the generator or the spec changed shape;
    // the digest is committed, so this is checkable.
    expect(JSON.stringify(digest).includes('unresolvedRef')).toBe(false);
  });

  it('keeps request bodies for the endpoints that take one', () => {
    const create = matchOperation(digest, 'POST', '/search/jobs');
    expect(create?.body).toBeTruthy();
    expect(JSON.stringify(create?.body)).toContain('query');
  });

  it('is small enough to load in a cell but too big to inline in a prompt', () => {
    // Both halves matter: the first is why we ship a digest instead of
    // the 8 MB spec, the second is why the tool searches it instead of
    // the seed embedding it.
    const bytes = JSON.stringify(digest).length;
    expect(bytes).toBeLessThan(1_500_000);
    expect(bytes).toBeGreaterThan(100_000);
  });
});
