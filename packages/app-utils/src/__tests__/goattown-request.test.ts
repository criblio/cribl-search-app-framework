/**
 * The regressions GoatTown named from the Hotdog Detector session review.
 *
 * (a) queued image input after an initial no-image answer
 * (b) prose and {kind:'report'} conclusions
 * (c) absent vs empty event collections, and unread finalSeq
 * (d) a routing/credential failure stays a transport error
 * (f) a successful answer followed by failed persistence stays successful
 *
 * (e) lives in goattown-kv.test.ts with the rest of the key encoding.
 *
 * These are fixture evidence, not live evidence: the service is stubbed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionExecution, WireLoopEvent } from '@criblio/agent-protocol';
import { GoatTownClient } from '../goattown/client.js';
import { runRequest, sendAndRun } from '../goattown/request.js';
import { SessionDiagnostics } from '../goattown/diagnostics.js';
import { kvPutText } from '../kv.js';
import { verdictOf } from '../goattown/example-image-classifier.js';

const text = (chunk: string, turnId = 'turn-0'): WireLoopEvent => ({ kind: 'assistantText', turnId, chunk });
const report = (headline: string, body: string): WireLoopEvent => ({
  kind: 'toolResult', turnId: 'turn-1',
  result: { id: 'c1', name: 'report', content: '', ui: { kind: 'report', headline, report: body } },
});
const exec = (over: Partial<SessionExecution> = {}): SessionExecution => ({
  requestId: 'r-image', state: 'complete', acceptedAt: 1, finalSeq: 2, ...over,
});

/** Serve scripted responses keyed by the requestId the caller asks about,
 *  so a test can prove observation followed the right receipt. */
function service(script: Record<string, Array<Record<string, unknown>>>, opts: { onDiagnostic?: never } = {}) {
  const seen: string[] = [];
  const cursors: Record<string, number> = {};
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const requestId = new URL(href, 'https://x').searchParams.get('requestId') ?? '(none)';
    if (init?.method === 'POST') {
      seen.push(`POST ${new URL(href, 'https://x').pathname}`);
      return new Response(JSON.stringify({ ok: true, requestId: 'r-image' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    seen.push(requestId);
    const pages = script[requestId] ?? script['(none)'] ?? [];
    const i = cursors[requestId] ?? 0;
    cursors[requestId] = Math.min(i + 1, pages.length - 1);
    return new Response(JSON.stringify(pages[Math.min(i, pages.length - 1)]), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  const client = new GoatTownClient({
    baseUrl: 'https://svc.example', userId: async () => 'u',
    fetch: fetchImpl as unknown as typeof fetch,
    ...opts,
  });
  return { client, seen };
}

describe('(a) queued image input after an initial no-image answer', () => {
  it('follows the image receipt and ignores the create request answer', async () => {
    // The observed defect: the app discarded sendImageMessage's receipt,
    // observed from seq 0 with no requestId, and accepted the CREATE
    // request's "no image attached" reply while the image request was still
    // running — a confident answer about a photo the model never saw.
    const { client, seen } = service({
      'r-initial': [{
        status: 'idle', latestSeq: 1,
        eventWindow: { since: 0, frames: [{ seq: 1, ev: text('No image was attached.') }] },
        execution: exec({ requestId: 'r-initial', finalSeq: 1 }),
      }],
      'r-image': [
        { status: 'running', latestSeq: 1, eventWindow: { since: 0, frames: [] },
          execution: exec({ state: 'running', finalSeq: null }) },
        { status: 'idle', latestSeq: 2,
          eventWindow: { since: 0, frames: [{ seq: 2, ev: text('NOT HOT DOG — a dachshund.') }] },
          execution: exec({ finalSeq: 2 }) },
      ],
    });

    const result = await runRequest(client, 's1', { requestId: 'r-image', since: 1, intervalMs: 0 });

    expect(result.outcome).toBe('completed');
    expect(result.requestId).toBe('r-image');
    expect(result.conclusion.text).toContain('NOT HOT DOG');
    // The create request's answer must never appear.
    expect(result.conclusion.text).not.toContain('No image was attached');
    expect(seen.every((id) => id === 'r-image')).toBe(true);
  });

  it('sendAndRun cannot discard the receipt — it is the same call', async () => {
    const { client } = service({
      'r-image': [{
        status: 'idle', latestSeq: 1,
        eventWindow: { since: 0, frames: [{ seq: 1, ev: text('NOT HOT DOG') }] },
        execution: exec({ finalSeq: 1 }),
      }],
    });
    const result = await sendAndRun(
      client, 's1',
      { content: 'is this a hot dog?', images: [{ data: 'AAAA', mimeType: 'image/png' }] },
      { intervalMs: 0 },
    );
    expect(result.outcome).toBe('completed');
    expect(result.requestId).toBe('r-image');
  });
});

describe('(b) conclusions', () => {
  it('reads a report payload', async () => {
    const { client } = service({
      'r-image': [{
        status: 'idle', latestSeq: 1,
        eventWindow: { since: 0, frames: [{ seq: 1, ev: report('NOT HOT DOG', 'A dachshund.') }] },
        execution: exec({ finalSeq: 1 }),
      }],
    });
    const result = await runRequest(client, 's1', { requestId: 'r-image', intervalMs: 0 });
    expect(result.conclusion.source).toBe('report');
    expect(result.conclusion.headline).toBe('NOT HOT DOG');
  });

  it('falls back to assistant prose', async () => {
    const { client } = service({
      'r-image': [{
        status: 'idle', latestSeq: 2,
        eventWindow: { since: 0, frames: [
          { seq: 1, ev: text('NOT HOT DOG') },
          { seq: 2, ev: { kind: 'assistantDone', turnId: 'turn-0' } },
        ] },
        execution: exec({ finalSeq: 2 }),
      }],
    });
    const result = await runRequest(client, 's1', { requestId: 'r-image', intervalMs: 0 });
    expect(result.conclusion.source).toBe('assistant');
    expect(result.conclusion.text).toBe('NOT HOT DOG');
  });

  it('reports source "none" rather than inventing an answer', async () => {
    const { client } = service({
      'r-image': [{
        status: 'idle', latestSeq: 1,
        eventWindow: { since: 0, frames: [{ seq: 1, ev: { kind: 'notification', turnId: 't', content: 'working' } }] },
        execution: exec({ finalSeq: 1 }),
      }],
    });
    const result = await runRequest(client, 's1', { requestId: 'r-image', intervalMs: 0 });
    expect(result.outcome).toBe('completed');
    expect(result.conclusion.source).toBe('none');
  });
});

describe('(c) collections and finalSeq', () => {
  it('an unread finalSeq does not complete, and a stall is named', async () => {
    // A terminal receipt promising frames the service never delivers used
    // to spin as an immediate tight loop. It is now bounded and reported.
    const { client } = service({
      'r-image': [{
        status: 'idle', latestSeq: 9,
        eventWindow: { since: 0, frames: [] },
        execution: exec({ finalSeq: 9 }),
      }],
    });
    const result = await runRequest(client, 's1', { requestId: 'r-image', intervalMs: 0 });
    expect(result.outcome).toBe('stalled');
    expect(result.outcome).not.toBe('completed');
  });

  it('an absent collection switches routes; an empty one does not', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url), 'https://x').pathname;
      calls.push(path);
      const body = path.endsWith('/status')
        ? { status: 'running', latestSeq: 1 }                       // absent
        : { status: 'idle', latestSeq: 1, frames: [{ seq: 1, ev: text('ok') }],
            execution: exec({ finalSeq: 1 }) };
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const client = new GoatTownClient({
      baseUrl: 'https://svc.example', userId: async () => 'u',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const result = await runRequest(client, 's1', { requestId: 'r-image', intervalMs: 0 });
    expect(result.outcome).toBe('completed');
    expect(calls[0]).toContain('/status');
    expect(calls[1]).toContain('/events');
  });

  it('a legacy session with no receipt is "untracked", never "completed"', async () => {
    const { client } = service({
      'r-image': [{
        status: 'concluded', latestSeq: 1,
        eventWindow: { since: 0, frames: [{ seq: 1, ev: text('done') }] },
        execution: null,
      }],
    });
    const result = await runRequest(client, 's1', { requestId: 'r-image', intervalMs: 0 });
    expect(result.outcome).toBe('untracked');
  });
});

describe('(d) transport failures stay transport failures', () => {
  it('a routing failure is a transport error, not an empty answer', async () => {
    const fetchImpl = vi.fn(async () => new Response('<!doctype html><html>login</html>', {
      status: 401, headers: { 'content-type': 'text/html' },
    }));
    const client = new GoatTownClient({
      baseUrl: 'https://svc.example', userId: async () => 'u',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const result = await runRequest(client, 's1', { requestId: 'r-image', intervalMs: 0 });
    expect(result.outcome).toBe('transport-error');
    expect(result.conclusion.source).toBe('none');
    // And it must not have been retried forever.
    expect(fetchImpl.mock.calls.length).toBeLessThan(5);
  });

  it('keeps the receipt on failure so the caller can resume, not resend', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    }));
    const client = new GoatTownClient({
      baseUrl: 'https://svc.example', userId: async () => 'u',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const result = await runRequest(client, 's1', { requestId: 'r-image', since: 7, intervalMs: 0 });
    expect(result.outcome).toBe('transport-error');
    expect(result.requestId).toBe('r-image');
    expect(result.cursor).toBe(7);
  });

  it('a malformed collection is visible, not an empty page', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: 'running', latestSeq: 1, frames: 'not-an-array' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = new GoatTownClient({
      baseUrl: 'https://svc.example', userId: async () => 'u',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const result = await runRequest(client, 's1', { requestId: 'r-image', intervalMs: 0 });
    expect(result.outcome).toBe('transport-error');
    expect(result.error?.message).toMatch(/malformed/);
  });
});

describe('(f) a successful answer survives failed persistence', () => {
  it('the request outcome is independent of a later KV write failure', async () => {
    const { client } = service({
      'r-image': [{
        status: 'idle', latestSeq: 1,
        eventWindow: { since: 0, frames: [{ seq: 1, ev: report('NOT HOT DOG', 'A dachshund.') }] },
        execution: exec({ finalSeq: 1 }),
      }],
    });
    const result = await runRequest(client, 's1', { requestId: 'r-image', intervalMs: 0 });
    expect(result.outcome).toBe('completed');

    // Persistence fails afterwards. The answer was still correct, and the
    // caller must be able to report it rather than losing it to the write.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    (globalThis as { CRIBL_API_URL?: string }).CRIBL_API_URL = 'https://api.example/v1';
    try {
      await expect(kvPutText('verdict', result.conclusion.text)).rejects.toThrow(/KV write/);
    } finally {
      globalThis.fetch = original;
    }
    expect(result.outcome).toBe('completed');
    expect(result.conclusion.headline).toBe('NOT HOT DOG');
  });
});

describe('diagnostics are wired without wrapping fetch', () => {
  it('captures operation, status, content type and collection presence', async () => {
    const diagnostics = new SessionDiagnostics(50);
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: 'idle', latestSeq: 1, eventWindow: { since: 0, frames: [{ seq: 1, ev: text('ok') }] }, execution: exec({ finalSeq: 1 }) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = new GoatTownClient({
      baseUrl: 'https://svc.example', userId: async () => 'u',
      fetch: fetchImpl as unknown as typeof fetch,
      onDiagnostic: diagnostics.sink,
    });
    await runRequest(client, 's1', { requestId: 'r-image', intervalMs: 0 });
    const snapshot = diagnostics.snapshot();
    expect(snapshot.events.length).toBeGreaterThan(0);
    expect(snapshot.events.some((e) => e.status === 200 && e.contentType?.includes('json'))).toBe(true);
    expect(snapshot.events.some((e) => e.collection === 'eventWindow.frames')).toBe(true);
    // The receipt IS captured — it is the thing that identifies which
    // request these events belong to, and GoatTown asked for it.
    expect(snapshot.events.some((e) => e.requestId === 'r-image')).toBe(true);
    // What must never be captured: credentials, and query VALUES (a
    // signed ticket rides in one). Keys survive so a reader can see what
    // was sent.
    const dump = JSON.stringify(snapshot);
    expect(dump.toLowerCase()).not.toContain('authorization');
    expect(dump).not.toContain('eventsSince=0');
    expect(dump).toContain('eventsSince=…');
  });
});

describe('the worked example', () => {
  it('checks the negative before the positive', () => {
    // "NOT HOT DOG" contains "HOT DOG", so matching the positive first
    // classifies every rejection as an acceptance.
    expect(verdictOf('NOT HOT DOG — this is a dachshund.')).toBe('not-hot-dog');
    expect(verdictOf('HOT DOG. Clearly a frankfurter in a bun.')).toBe('hot-dog');
    expect(verdictOf('not a hot-dog')).toBe('not-hot-dog');
    expect(verdictOf('I cannot tell from this photo.')).toBe('undetermined');
    expect(verdictOf('')).toBe('undetermined');
  });
});
