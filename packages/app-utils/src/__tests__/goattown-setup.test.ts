/**
 * Setup controller and the proposal-helper fixes.
 *
 * `useSetup` is a React hook and this package carries no DOM harness, so
 * the flow is exercised through the pieces it composes — which is where
 * every reported defect actually lived.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoatTownClient } from '../goattown/client.js';
import { SessionDiagnostics } from '../goattown/diagnostics.js';
import { GoatTownError } from '../goattown/errors.js';
import { readProposalScope, readProposalStatus, stageProposal } from '../goattown/provisioning.js';
import type { AppConfigurationScope } from '@criblio/agent-protocol';

const API = 'https://api.example/api/v1';
const originalFetch = globalThis.fetch;

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { CRIBL_API_URL: API };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as { window?: unknown }).window;
});

const SCOPE: AppConfigurationScope = {
  appConnectionId: 'c', appId: 'a', producer: 'cribl-demo',
  producerInput: 'credential', reviewPath: '/console/i/x/configurations',
};

/** A client whose transport is fully injected, so nothing can escape it. */
function clientWith(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  onDiagnostic?: SessionDiagnostics,
) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    return handler(String(url), init);
  });
  const client = new GoatTownClient({
    baseUrl: 'https://svc.example',
    userId: async () => 'u',
    fetch: fetchImpl as unknown as typeof fetch,
    onDiagnostic: onDiagnostic?.sink,
  });
  return { client, calls, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

describe('proposal requests go through the client transport', () => {
  it('uses the injected fetch rather than the global one', async () => {
    // It called the global `fetch` directly, so an injected transport was
    // ignored and the one flow first-run setup depends on was untestable.
    globalThis.fetch = (() => { throw new Error('global fetch must not be used'); }) as typeof fetch;
    const { client, calls } = clientWith(() => json({ metadata: { activeRevisionId: 'r1' } }));
    await readProposalStatus(client, 'r1', 'demo-agent').catch(() => undefined);
    expect(calls.some((u) => u.includes('/configurations?action=metadata'))).toBe(true);
  });

  it('records configuration calls in diagnostics', async () => {
    // Previously invisible: the bare fetch bypassed onDiagnostic entirely.
    const diagnostics = new SessionDiagnostics();
    const { client } = clientWith(() => json({ agents: [], metadata: {} }), diagnostics);
    await readProposalStatus(client, null, 'demo-agent').catch(() => undefined);
    const ops = diagnostics.snapshot().events.map((e) => e.op);
    expect(ops).toContain('configurations');
  });

  it('sends YAML as application/yaml, and reads without a body', async () => {
    const types = new Map<string, string | null>();
    const { client } = clientWith((url, init) => {
      const action = new URL(url).searchParams.get('action') ?? '?';
      types.set(action, new Headers(init?.headers).get('content-type'));
      if (url.includes('action=store')) return json({ revision: { id: 'r9' } });
      if (url.includes('action=diff')) return json({ changes: 1, hasConflicts: false });
      return json({ ok: true });
    });
    const staged = await stageProposal(client, 'version: 1\n', SCOPE);
    expect(staged.revisionId).toBe('r9');
    // validate and store carry the document; diff is a GET and carries none.
    expect(types.get('validate')).toBe('application/yaml');
    expect(types.get('store')).toBe('application/yaml');
    expect(types.get('diff')).toBeNull();
  });

  it('validates before storing, since a store writes an immutable revision', async () => {
    const order: string[] = [];
    const { client } = clientWith((url) => {
      order.push(new URL(url).searchParams.get('action') ?? '?');
      if (url.includes('action=store')) return json({ revision: { id: 'r9' } });
      if (url.includes('action=diff')) return json({ changes: 0, hasConflicts: false });
      return json({ ok: true });
    });
    await stageProposal(client, 'version: 1\n', SCOPE);
    expect(order.slice(0, 2)).toEqual(['validate', 'store']);
  });
});

describe('readProposalStatus no longer swallows failures', () => {
  it('propagates an auth failure instead of reporting "not active yet"', async () => {
    // Swallowed into {} and [], a 403 rendered as "no active revision, no
    // agents" — indistinguishable from waiting on an administrator. The
    // user then waits for a person who was never going to fix it.
    const { client } = clientWith(() => json({ error: 'denied' }, 403));
    const error = await readProposalStatus(client, 'r1', 'demo-agent').then(() => null, (e) => e);
    expect(error).toBeInstanceOf(GoatTownError);
    expect((error as GoatTownError).isPermanentAuthFailure).toBe(true);
  });

  it('propagates a network failure too', async () => {
    const { client } = clientWith(() => { throw new TypeError('offline'); });
    await expect(readProposalStatus(client, 'r1', 'demo-agent')).rejects.toBeInstanceOf(TypeError);
  });

  it('still reports a genuine not-yet-active state', async () => {
    const { client } = clientWith((url) => (url.includes('/agents')
      ? json({ agents: [{ slug: 'demo-agent' }] })
      : json({ metadata: { activeRevisionId: 'other' } })));
    expect(await readProposalStatus(client, 'r1', 'demo-agent')).toMatchObject({
      isActive: false, agentAvailable: true, activeRevisionId: 'other',
    });
  });
});

describe('a missing custom agent is never substituted', () => {
  it('reports agentAvailable false when only another agent exists', async () => {
    // Running an app's workflow against a generic agent gives it the wrong
    // instructions and tools, and looks like it works.
    const { client } = clientWith((url) => (url.includes('/agents')
      ? json({ agents: [{ slug: 'investigator' }] })
      : json({ metadata: { activeRevisionId: 'r1' } })));
    const status = await readProposalStatus(client, 'r1', 'my-app-analyst');
    expect(status.isActive).toBe(true);
    expect(status.agentAvailable).toBe(false);
  });
});

describe('proposal scope', () => {
  it('returns null when the credential cannot propose, rather than throwing', async () => {
    const { client } = clientWith(() => json({ protocolVersion: 1, capabilities: [] }));
    expect(await readProposalScope(client)).toBeNull();
  });

  it('surfaces the credential-assigned producer', async () => {
    const { client } = clientWith(() => json({
      protocolVersion: 1, capabilities: [], proposalScope: SCOPE,
    }));
    expect(await readProposalScope(client)).toMatchObject({
      producer: 'cribl-demo', producerInput: 'credential',
    });
  });

  it('refuses to stage when the YAML declares a producer', async () => {
    const { client } = clientWith(() => json({ ok: true }));
    await expect(stageProposal(client, 'producer: someone\nversion: 1\n', SCOPE))
      .rejects.toThrow(/Remove the top-level `producer:` field/);
  });
});

describe('setup state is public and holds no secret', () => {
  it('persists only the URL and the staged revision', async () => {
    // Shared across members and reloads because app KV is app-scoped —
    // which is exactly why the token must not live in it.
    const written: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        written.push({ url: String(url), body: String(init.body) });
        return new Response('', { status: 200 });
      }
      return json({ message: 'Key not found' }, 404);
    }) as typeof fetch;

    const { kvPutJson, kvPutText } = await import('../kv.js');
    await kvPutJson('goattown-setup', { serviceUrl: 'https://svc.example', stagedRevisionId: 'r1' });
    await kvPutText('goattown_token', 'SENTINEL_TOKEN_NOT_REAL');

    const state = written.find((w) => w.url.includes('goattown-setup'));
    expect(state?.body).toContain('serviceUrl');
    expect(state?.body).not.toContain('SENTINEL_TOKEN_NOT_REAL');
    // The token goes to its own key, which the proxy reads server-side.
    expect(written.find((w) => w.url.includes('goattown_token'))).toBeDefined();
  });

  it('a rejected state save throws rather than appearing to stick', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const { kvPutJson } = await import('../kv.js');
    await expect(kvPutJson('goattown-setup', { serviceUrl: 'x' })).rejects.toThrow(/KV write/);
  });
});
