/**
 * Alert firing (GoatTown 0.40.4, capability `alerts-fire`).
 *
 * Contract read from the service source, not from a description: the
 * capability gate, the `app_alert_firing_disabled` 403, the absent member
 * header on this route alone, and the fact that a 202 says the array was
 * read rather than that work started.
 */
import { describe, expect, it, vi } from 'vitest';
import { ALERT_TRIGGER_LIMITS, type AlertTrigger } from '@criblio/agent-protocol';
import { GoatTownClient } from '../goattown/client.js';
import { GoatTownError } from '../goattown/errors.js';

const TRIGGER: AlertTrigger = {
  agent: 'my-investigator',
  eventId: 'stable-event-id',
  subject: 'checkout latency',
};

function clientWith(handler: (url: string, init?: RequestInit) => Response) {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return handler(String(url), init);
  });
  const client = new GoatTownClient({
    baseUrl: 'https://svc.example',
    userId: async () => 'member-1',
    fetch: fetchImpl as unknown as typeof fetch,
  });
  return { client, seen };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

describe('capability gating', () => {
  it('is the only permission check — never a token shape', async () => {
    const { client } = clientWith(() => json({
      protocolVersion: 1, capabilities: ['events-poll', 'alerts-fire'],
    }));
    expect(await client.canFireAlerts()).toBe(true);
  });

  it('reports false when the grant is off', async () => {
    // Absent unless the connection is active AND an administrator enabled
    // "Allow alert firing" — off by default, including for existing
    // connections, because an external event starts billable work.
    const { client } = clientWith(() => json({ protocolVersion: 1, capabilities: ['events-poll'] }));
    expect(await client.canFireAlerts()).toBe(false);
  });
});

describe('the member header', () => {
  it('is NOT sent when firing — the sender is a machine', async () => {
    const { client, seen } = clientWith(() => json({ accepted: 1 }, 202));
    await client.fireAlerts([TRIGGER]);
    const headers = new Headers(seen[0].init?.headers);
    expect(headers.get('x-goattown-user')).toBeNull();
    expect(seen[0].url).toContain('/alerts/fire');
  });

  it('is still sent for discovery and session reads', async () => {
    const { client, seen } = clientWith(() => json({ agents: [] }));
    await client.listAgents();
    expect(new Headers(seen[0].init?.headers).get('x-goattown-user')).toBe('member-1');
  });

  it('never sends an authorization header — the proxy injects it', async () => {
    const { client, seen } = clientWith(() => json({ accepted: 0 }, 202));
    await client.fireAlerts([]);
    expect(new Headers(seen[0].init?.headers).get('authorization')).toBeNull();
  });
});

describe('202 does not establish that work started', () => {
  it('an empty array is a safe probe: 202 accepted 0, nothing queued', async () => {
    const { client } = clientWith(() => json({ accepted: 0 }, 202));
    expect(await client.fireAlerts([])).toEqual({ accepted: 0 });
  });

  it('preserves the accepted count', async () => {
    const { client } = clientWith(() => json({ accepted: 2 }, 202));
    expect((await client.fireAlerts([TRIGGER, TRIGGER])).accepted).toBe(2);
  });

  it('preserves rejection diagnostics, which are otherwise a silent skip', async () => {
    const { client } = clientWith(() => json({
      accepted: 1,
      rejected: [{ index: 1, reason: 'missing eventId' }],
    }, 202));
    const result = await client.fireAlerts([TRIGGER, { ...TRIGGER, eventId: '' }]);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([{ index: 1, reason: 'missing eventId' }]);
  });

  it('a retry accepting zero is a correct answer, not a failure', async () => {
    // Deduplication by connection, agent and event id means a replayed
    // delivery legitimately admits nothing.
    const { client } = clientWith(() => json({ accepted: 0 }, 202));
    const result = await client.fireAlerts([TRIGGER]);
    expect(result.accepted).toBe(0);
    expect(result.rejected).toBeUndefined();
  });

  it('a missing accepted count reads as zero, never as success', async () => {
    const { client } = clientWith(() => json({}, 202));
    expect((await client.fireAlerts([TRIGGER])).accepted).toBe(0);
  });
});

describe('the disabled-firing 403', () => {
  it('is its own condition, not a rejected credential', async () => {
    // The remedy is an administrator enabling a grant. Reporting it as an
    // auth failure sends the operator to fix a token that is already fine,
    // and there is no fallback credential that would work instead.
    const { client } = clientWith(() => json({
      error: 'Alert firing is disabled for this app connection.',
      code: 'app_alert_firing_disabled',
    }, 403));
    const error = await client.fireAlerts([TRIGGER]).then(() => null, (e) => e as GoatTownError);
    expect(error).toBeInstanceOf(GoatTownError);
    expect(error!.isAlertFiringDisabled).toBe(true);
    expect(error!.isPermanentAuthFailure).toBe(false);
  });

  it('an ordinary 403 is still a permanent auth failure', async () => {
    const { client } = clientWith(() => json({ error: 'denied' }, 403));
    const error = await client.fireAlerts([TRIGGER]).then(() => null, (e) => e as GoatTownError);
    expect(error!.isAlertFiringDisabled).toBe(false);
    expect(error!.isPermanentAuthFailure).toBe(true);
  });
});

describe('advertised limits', () => {
  it('are exported so a caller can trim before sending', () => {
    // The seed is history[0] and is re-sent every turn, so an oversized
    // payload is charged again for the life of the session.
    expect(ALERT_TRIGGER_LIMITS).toEqual({
      maxFields: 48, maxValueChars: 600, maxSummaryChars: 4_000, maxIdChars: 200,
    });
  });
});
