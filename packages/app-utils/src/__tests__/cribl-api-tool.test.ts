/**
 * The write gate is the point of this file.
 *
 * A test that only checks "an unapproved write returns a refusal
 * message" would pass against a tool that returns the refusal AND
 * sends the request, so the assertions here are about whether the
 * injected `request` was CALLED — the observable side effect — not
 * about what the agent was told. Same principle as the header-hop
 * tests: assert on the thing that would actually go wrong.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createCriblApiTool,
  criblApiDefinition,
  requestDigest,
  type CriblApiToolDeps,
  type CriblApiUi,
  type PendingWrite,
  type WriteApprovals,
} from '../cribl-api-tool.js';
import type { OpenApiDigest } from '../openapi-digest.js';

const DIGEST: OpenApiDigest = {
  specVersion: 'test-1.0',
  ops: [
    { method: 'GET', path: '/search/jobs', operationId: 'listSearchJob', tag: 'search', summary: 'List all search jobs' },
    {
      method: 'POST',
      path: '/search/jobs',
      operationId: 'createSearchJob',
      tag: 'search',
      summary: 'Create a search job',
      body: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
    },
    { method: 'DELETE', path: '/search/jobs/{id}', operationId: 'deleteSearchJob', tag: 'search', summary: 'Delete a search job' },
    { method: 'GET', path: '/apps', operationId: 'listApps', tag: 'apps', summary: 'List installed apps' },
    { method: 'GET', path: '/search/metrics/query', tag: 'search.metrics', summary: 'Metrics query', internal: true },
  ],
};

/** An in-memory approvals store with the atomicity the interface asks
 *  for; `approve` stands in for the UI-only host route. */
function memoryApprovals() {
  const rows = new Map<string, { pending: PendingWrite; approved: boolean; consumed: boolean }>();
  const store: WriteApprovals = {
    async put(pending) {
      rows.set(pending.id, { pending, approved: false, consumed: false });
    },
    async consume(id, digest) {
      const row = rows.get(id);
      if (!row || !row.approved || row.consumed || row.pending.digest !== digest) return null;
      row.consumed = true;
      return row.pending;
    },
  };
  return {
    store,
    /** What the UI does when the human clicks Approve. */
    approve(id: string) {
      const row = rows.get(id);
      if (row) row.approved = true;
    },
    rows,
  };
}

function makeTool(over: Partial<CriblApiToolDeps> = {}) {
  // Typed against the dependency so `request.mock.calls[i]` keeps the
  // real (method, path, opts) arity — a bare `vi.fn(async () => …)`
  // types the args as `[]` and makes the assertions unindexable.
  const request = vi.fn<CriblApiToolDeps['request']>(async () => ({
    status: 200,
    ok: true,
    text: '{"items":[]}',
  }));
  let n = 0;
  const tool = createCriblApiTool({
    digest: DIGEST,
    request,
    newApprovalId: () => `ap-${++n}`,
    ...over,
  });
  return { tool, request };
}

function invoke(args: unknown) {
  return { id: 'call-1', name: 'cribl_api', arguments: JSON.stringify(args) };
}

describe('search', () => {
  it('ranks the plainest matching endpoint first', async () => {
    const { tool } = makeTool();
    const r = await tool(invoke({ action: 'search', query: 'search jobs' }));
    expect(r.content).toContain('GET /search/jobs');
    expect(r.content.indexOf('/search/jobs')).toBeLessThan(r.content.indexOf('/search/jobs/{id}'));
  });

  it('requires every term to match, so a broad word does not return everything', async () => {
    const { tool } = makeTool();
    const r = await tool(invoke({ action: 'search', query: 'search nonexistentword' }));
    expect(r.content).toContain('No Cribl API endpoints matched');
  });

  it('can restrict to writes', async () => {
    const { tool } = makeTool();
    const r = await tool(invoke({ action: 'search', query: 'jobs', writesOnly: true }));
    expect(r.content).toContain('POST /search/jobs');
    expect(r.content).toContain('DELETE /search/jobs/{id}');
    expect(r.content).not.toContain('GET /search/jobs');
  });

  it('marks internal endpoints instead of hiding them', async () => {
    // /search/metrics/query is x-cribl-internal yet is the endpoint
    // this package's metrics client actually calls.
    const { tool } = makeTool();
    const r = await tool(invoke({ action: 'search', query: 'metrics query' }));
    expect(r.content).toContain('/search/metrics/query');
    expect(r.content).toContain('internal');
  });
});

describe('describe', () => {
  it('returns the request-body schema', async () => {
    const { tool } = makeTool();
    const r = await tool(invoke({ action: 'describe', method: 'post', path: '/search/jobs' }));
    expect(JSON.parse(r.content)).toMatchObject({
      method: 'POST',
      path: '/search/jobs',
      write: true,
      requestBody: { required: ['query'] },
    });
  });

  it('matches a concrete path against the templated spec entry', async () => {
    const { tool } = makeTool();
    const r = await tool(invoke({ action: 'describe', method: 'DELETE', path: '/search/jobs/abc123' }));
    expect(JSON.parse(r.content).path).toBe('/search/jobs/{id}');
  });

  it('sees through the group context the spec omits', async () => {
    // The spec says /search/jobs; the workspace only serves it under
    // /m/default_search. Both must describe.
    const { tool } = makeTool();
    const r = await tool(
      invoke({ action: 'describe', method: 'GET', path: '/m/default_search/search/jobs' }),
    );
    expect(JSON.parse(r.content).operationId).toBe('listSearchJob');
  });
});

describe('call — reads', () => {
  it('executes a GET immediately', async () => {
    const { tool, request } = makeTool();
    const r = await tool(invoke({ action: 'call', method: 'GET', path: '/apps' }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0].slice(0, 2)).toEqual(['GET', '/apps']);
    expect(r.content).toContain('→ 200');
  });

  it('reports a non-2xx as content rather than an error', async () => {
    const request = vi.fn(async () => ({ status: 403, ok: false, text: 'forbidden' }));
    const { tool } = makeTool({ request });
    const r = await tool(invoke({ action: 'call', method: 'GET', path: '/apps' }));
    expect(r.content).toContain('→ 403');
    expect(r.content).toContain('forbidden');
  });
});

describe('call — writes are gated on the user', () => {
  it('does NOT send the request on the first attempt', async () => {
    const { store } = memoryApprovals();
    const { tool, request } = makeTool({ approvals: store });
    const r = await tool(
      invoke({ action: 'call', method: 'POST', path: '/search/jobs', body: { query: 'x' } }),
    );
    // The assertion that matters. A refusal message with the request
    // already sent would be the bug this whole design prevents.
    expect(request).not.toHaveBeenCalled();
    expect(r.content).toContain('was NOT executed');
    expect((r.ui as CriblApiUi).approval?.id).toBe('ap-1');
  });

  it('still refuses when the agent supplies an id the user never approved', async () => {
    // The model can invent an id; it must not be able to invent an
    // approval.
    const { store } = memoryApprovals();
    const { tool, request } = makeTool({ approvals: store });
    await tool(invoke({ action: 'call', method: 'POST', path: '/search/jobs', body: { query: 'x' } }));
    const r = await tool(
      invoke({
        action: 'call',
        method: 'POST',
        path: '/search/jobs',
        body: { query: 'x' },
        approvalId: 'ap-1',
      }),
    );
    expect(request).not.toHaveBeenCalled();
    expect(r.content).toContain('not usable');
  });

  it('executes once the user approves and the agent retries', async () => {
    const { store, approve } = memoryApprovals();
    const { tool, request } = makeTool({ approvals: store });
    const first = await tool(
      invoke({ action: 'call', method: 'POST', path: '/search/jobs', body: { query: 'x' } }),
    );
    const id = (first.ui as CriblApiUi).approval!.id;
    approve(id);
    const r = await tool(
      invoke({
        action: 'call',
        method: 'POST',
        path: '/search/jobs',
        body: { query: 'x' },
        approvalId: id,
      }),
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('POST');
    expect(r.content).toContain('→ 200');
  });

  it('refuses a request whose body changed after approval', async () => {
    // The swap attack: get a harmless write approved, then send a
    // different one with the same id.
    const { store, approve } = memoryApprovals();
    const { tool, request } = makeTool({ approvals: store });
    const first = await tool(
      invoke({ action: 'call', method: 'POST', path: '/search/jobs', body: { query: 'harmless' } }),
    );
    const id = (first.ui as CriblApiUi).approval!.id;
    approve(id);
    const r = await tool(
      invoke({
        action: 'call',
        method: 'POST',
        path: '/search/jobs',
        body: { query: 'something else entirely' },
        approvalId: id,
      }),
    );
    expect(request).not.toHaveBeenCalled();
    expect(r.content).toContain('not usable');
  });

  it('refuses a different path under an approval for another one', async () => {
    const { store, approve } = memoryApprovals();
    const { tool, request } = makeTool({ approvals: store });
    const first = await tool(invoke({ action: 'call', method: 'DELETE', path: '/apps/harmless' }));
    const id = (first.ui as CriblApiUi).approval!.id;
    approve(id);
    const r = await tool(
      invoke({ action: 'call', method: 'DELETE', path: '/apps/production', approvalId: id }),
    );
    expect(request).not.toHaveBeenCalled();
    expect(r.content).toContain('not usable');
  });

  it('is single-use — a replayed approval does not fire a second write', async () => {
    const { store, approve } = memoryApprovals();
    const { tool, request } = makeTool({ approvals: store });
    const args = { action: 'call', method: 'POST', path: '/search/jobs', body: { query: 'x' } };
    const first = await tool(invoke(args));
    const id = (first.ui as CriblApiUi).approval!.id;
    approve(id);
    await tool(invoke({ ...args, approvalId: id }));
    const replay = await tool(invoke({ ...args, approvalId: id }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(replay.content).toContain('not usable');
  });

  it('accepts a retry whose body keys were reordered', async () => {
    // The model does not control JSON key order between turns; an
    // approval the user really gave must survive it.
    const { store, approve } = memoryApprovals();
    const { tool, request } = makeTool({ approvals: store });
    const first = await tool(
      invoke({ action: 'call', method: 'PATCH', path: '/apps/x', body: { a: 1, b: { c: 2, d: 3 } } }),
    );
    const id = (first.ui as CriblApiUi).approval!.id;
    approve(id);
    await tool(
      invoke({
        action: 'call',
        method: 'PATCH',
        path: '/apps/x',
        body: { b: { d: 3, c: 2 }, a: 1 },
        approvalId: id,
      }),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('treats an unrecognized method as a write', async () => {
    // Fail toward asking the user, not toward acting.
    const { store } = memoryApprovals();
    const { tool, request } = makeTool({ approvals: store });
    await tool(invoke({ action: 'call', method: 'PURGE', path: '/apps' }));
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses writes outright when the host has no approval store', async () => {
    const { tool, request } = makeTool();
    const r = await tool(invoke({ action: 'call', method: 'DELETE', path: '/apps/x' }));
    expect(request).not.toHaveBeenCalled();
    expect(r.content).toContain('writes are disabled');
  });

  it('gates a write even for a path absent from the spec', async () => {
    // The gate is on the METHOD, not on whether the spec knows the
    // endpoint — an unknown path is exactly when to be careful.
    const { store } = memoryApprovals();
    const { tool, request } = makeTool({ approvals: store });
    await tool(invoke({ action: 'call', method: 'POST', path: '/some/undocumented/thing' }));
    expect(request).not.toHaveBeenCalled();
  });
});

describe('requestDigest', () => {
  it('is stable across key order and distinct across content', () => {
    expect(requestDigest('POST', '/a', { x: 1, y: 2 })).toBe(
      requestDigest('post', '/a', { y: 2, x: 1 }),
    );
    expect(requestDigest('POST', '/a', { x: 1 })).not.toBe(requestDigest('POST', '/a', { x: 2 }));
    expect(requestDigest('POST', '/a', undefined)).not.toBe(requestDigest('POST', '/b', undefined));
    expect(requestDigest('POST', '/a', undefined)).not.toBe(requestDigest('DELETE', '/a', undefined));
  });
});

describe('bad input', () => {
  it.each([
    [{ action: 'search' }, 'non-empty `query`'],
    [{ action: 'describe', method: 'GET' }, 'needs both'],
    [{ action: 'call', method: 'GET', path: 'apps' }, "starting with '/'"],
    [{ action: 'frobnicate' }, 'Unknown cribl_api action'],
  ])('explains %j instead of throwing', async (args, expected) => {
    const { tool } = makeTool();
    const r = await tool(invoke(args));
    expect(r.content).toContain(expected);
  });

  it('survives malformed arguments', async () => {
    const { tool } = makeTool();
    const r = await tool({ id: 'c', name: 'cribl_api', arguments: 'not json' });
    expect(r.content).toContain('Unknown cribl_api action');
  });
});

describe('definition', () => {
  it('tells the model to stop and wait after a refused write', () => {
    const def = criblApiDefinition();
    expect(def.id).toBe('cribl_api');
    expect(def.description).toContain('STOP');
    expect(def.description).toContain('approvalId');
  });
});
