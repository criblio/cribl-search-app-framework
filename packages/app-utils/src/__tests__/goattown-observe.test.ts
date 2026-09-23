/**
 * Observation rules.
 *
 * Every case here is a way a consumer previously decided a session was
 * finished when it was not, or kept polling one that was.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionExecution, WireLoopEvent } from '@criblio/agent-protocol';
import { GoatTownClient } from '../goattown/client.js';
import { observeSession } from '../goattown/observe.js';
import { GoatTownError } from '../goattown/errors.js';

const ANSWER: WireLoopEvent = { kind: 'assistantText', turnId: 'turn-0', chunk: 'NOT HOT DOG' };

/** Serve a scripted list of responses, recording the URLs requested. */
function stubService(responses: Array<Record<string, unknown> | { __status: number; body?: unknown; headers?: Record<string, string> }>) {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url));
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next && typeof next === 'object' && '__status' in next) {
      const failure = next as { __status: number; body?: unknown; headers?: Record<string, string> };
      return new Response(JSON.stringify(failure.body ?? {}), {
        status: failure.__status,
        headers: { 'content-type': 'application/json', ...(failure.headers ?? {}) },
      });
    }
    return new Response(JSON.stringify(next), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  const client = new GoatTownClient({
    baseUrl: 'https://svc.example',
    userId: async () => 'user-1',
    fetch: fetchImpl as unknown as typeof fetch,
  });
  return { client, urls, fetchImpl };
}

const execution = (over: Partial<SessionExecution> = {}): SessionExecution => ({
  requestId: 'r1', state: 'complete', acceptedAt: 1, finalSeq: 2, ...over,
});

describe('observeSession completion', () => {
  it('does not finish on idle — idle is between turns, not done', async () => {
    // The failure this prevents: observation ends before the answer arrives
    // and the caller reports an empty conclusion as if it were a real one.
    const { client } = stubService([
      { status: 'idle', latestSeq: 0, eventWindow: { since: 0, frames: [] }, execution: execution({ state: 'running', finalSeq: null }) },
      { status: 'idle', latestSeq: 1, eventWindow: { since: 0, frames: [{ seq: 1, ev: ANSWER }] }, execution: execution({ finalSeq: 1 }) },
    ]);
    const seen: string[] = [];
    const result = await observeSession(client, 's1', {
      intervalMs: 0,
      onEvent: (ev) => seen.push(ev.kind),
    });
    expect(result.reason).toBe('drained');
    expect(seen).toEqual(['assistantText']);
  });

  it('drains paginated final events after the receipt turns terminal', async () => {
    // Pages are bounded at 100 frames, so the last page of a completed
    // request routinely arrives after the state flips to complete.
    const { client } = stubService([
      { status: 'running', latestSeq: 3, eventWindow: { since: 0, frames: [{ seq: 1, ev: ANSWER }] }, execution: execution({ finalSeq: 3 }) },
      { status: 'idle', latestSeq: 3, eventWindow: { since: 1, frames: [{ seq: 2, ev: ANSWER }, { seq: 3, ev: ANSWER }] }, execution: execution({ finalSeq: 3 }) },
    ]);
    const result = await observeSession(client, 's1', { intervalMs: 0 });
    expect(result.reason).toBe('drained');
    expect(result.cursor).toBe(3);
    expect(result.frameCount).toBe(3);
  });

  it('keeps polling while a terminal receipt has unread finalSeq', async () => {
    const { client, urls } = stubService([
      { status: 'idle', latestSeq: 1, eventWindow: { since: 0, frames: [] }, execution: execution({ finalSeq: 1 }) },
      { status: 'idle', latestSeq: 1, eventWindow: { since: 0, frames: [{ seq: 1, ev: ANSWER }] }, execution: execution({ finalSeq: 1 }) },
    ]);
    const result = await observeSession(client, 's1', { intervalMs: 0 });
    expect(result.reason).toBe('drained');
    expect(urls.length).toBeGreaterThanOrEqual(2);
  });

  it('uses terminal SESSION status only when no receipt exists (legacy)', async () => {
    const { client } = stubService([
      { status: 'concluded', latestSeq: 1, eventWindow: { since: 0, frames: [{ seq: 1, ev: ANSWER }] }, execution: null },
    ]);
    const result = await observeSession(client, 's1', { intervalMs: 0 });
    expect(result.reason).toBe('terminal-status');
    expect(result.execution).toBeNull();
  });

  it('a null execution is never read as success', async () => {
    // Legacy/untracked. An idle session with no receipt must keep polling.
    const { client, urls } = stubService([
      { status: 'idle', latestSeq: 0, eventWindow: { since: 0, frames: [] }, execution: null },
    ]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await observeSession(client, 's1', { intervalMs: 1, signal: controller.signal });
    expect(result.reason).toBe('aborted');
    expect(urls.length).toBeGreaterThan(1);
  });
});

describe('observeSession transport behavior', () => {
  it('dedupes by service seq and never by turnId or text', async () => {
    // Identical chunk + turnId on a different seq is a real repeated event.
    const { client } = stubService([
      { status: 'running', latestSeq: 2, eventWindow: { since: 0, frames: [{ seq: 1, ev: ANSWER }, { seq: 2, ev: ANSWER }] }, execution: execution({ finalSeq: 2 }) },
    ]);
    const seen: number[] = [];
    await observeSession(client, 's1', { intervalMs: 0, onEvent: (_ev, seq) => seen.push(seq) });
    expect(seen).toEqual([1, 2]);
  });

  it('ignores a frame at or below the cursor when a page repeats', async () => {
    const { client } = stubService([
      { status: 'running', latestSeq: 1, eventWindow: { since: 0, frames: [{ seq: 1, ev: ANSWER }] }, execution: execution({ finalSeq: 2 }) },
      { status: 'idle', latestSeq: 2, eventWindow: { since: 0, frames: [{ seq: 1, ev: ANSWER }, { seq: 2, ev: ANSWER }] }, execution: execution({ finalSeq: 2 }) },
    ]);
    const seen: number[] = [];
    await observeSession(client, 's1', { intervalMs: 0, onEvent: (_ev, seq) => seen.push(seq) });
    expect(seen).toEqual([1, 2]);
  });

  it('falls back to /events permanently when status carries no collection', async () => {
    const { client, urls } = stubService([
      { status: 'running', latestSeq: 1 },
      { status: 'idle', latestSeq: 1, frames: [{ seq: 1, ev: ANSWER }], execution: execution({ finalSeq: 1 }) },
    ]);
    await observeSession(client, 's1', { intervalMs: 0 });
    expect(urls[0]).toContain('/status?');
    expect(urls[1]).toContain('/events?');
  });

  it('honors Retry-After on 429 instead of hammering', async () => {
    const { client } = stubService([
      { __status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '0' } },
      { status: 'idle', latestSeq: 1, eventWindow: { since: 0, frames: [{ seq: 1, ev: ANSWER }] }, execution: execution({ finalSeq: 1 }) },
    ]);
    const errors: unknown[] = [];
    const result = await observeSession(client, 's1', { intervalMs: 0, onError: (e) => errors.push(e) });
    expect(result.reason).toBe('drained');
    expect((errors[0] as GoatTownError).isRateLimited).toBe(true);
    expect((errors[0] as GoatTownError).retryAfterSeconds).toBe(0);
  });

  it('pauses while the page is hidden', async () => {
    const { client, urls } = stubService([
      { status: 'idle', latestSeq: 1, eventWindow: { since: 0, frames: [{ seq: 1, ev: ANSWER }] }, execution: execution({ finalSeq: 1 }) },
    ]);
    let hidden = true;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15);
    await observeSession(client, 's1', {
      intervalMs: 1, isHidden: () => hidden, signal: controller.signal,
    });
    expect(urls).toHaveLength(0);
    hidden = false;
  });

  it('aborts promptly on session switch', async () => {
    const { client } = stubService([
      { status: 'running', latestSeq: 0, eventWindow: { since: 0, frames: [] }, execution: execution({ state: 'running', finalSeq: null }) },
    ]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const result = await observeSession(client, 's1', { intervalMs: 1000, signal: controller.signal });
    expect(result.reason).toBe('aborted');
  });

  it('throws on an unknown receipt rather than retrying forever', async () => {
    const { client } = stubService([
      { __status: 404, body: { code: 'execution_not_found', error: 'no such receipt' } },
    ]);
    await expect(
      observeSession(client, 's1', { intervalMs: 0, requestId: 'ghost' }),
    ).rejects.toMatchObject({ status: 404, code: 'execution_not_found' });
  });

  it('routes the user turn away from applyLoopEvent', async () => {
    const { client } = stubService([
      {
        status: 'idle', latestSeq: 2,
        eventWindow: { since: 0, frames: [
          { seq: 1, ev: { kind: 'userMessage', turnId: 'u', content: 'is this a hot dog?', imageCount: 1 } },
          { seq: 2, ev: ANSWER },
        ] },
        execution: execution({ finalSeq: 2 }),
      },
    ]);
    const loopKinds: string[] = [];
    const users: Array<{ content: string; imageCount: number }> = [];
    await observeSession(client, 's1', {
      intervalMs: 0,
      onEvent: (ev) => loopKinds.push(ev.kind),
      onUserMessage: (content, _seq, imageCount) => users.push({ content, imageCount }),
    });
    expect(loopKinds).toEqual(['assistantText']);
    expect(users).toEqual([{ content: 'is this a hot dog?', imageCount: 1 }]);
  });
});
