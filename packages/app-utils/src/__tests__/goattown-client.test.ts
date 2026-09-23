/**
 * Image validation, typed errors, redaction, and proposal rules.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_IMAGE_INPUT, type AppConfigurationScope } from '@criblio/agent-protocol';
import { GoatTownClient, assertImagesWithin } from '../goattown/client.js';
import { GoatTownError, ImageInputError, retryAfterSeconds } from '../goattown/errors.js';
import { SessionDiagnostics, redact } from '../goattown/diagnostics.js';
import { assertProposalOmitsProducer, assertNoBrowserCredential, stageProposal } from '../goattown/provisioning.js';

/** Valid base64 of a given length (length must be a multiple of 4). */
const b64 = (length: number) => 'A'.repeat(length);
const png = (length: number) => ({ data: b64(length), mimeType: 'image/png' });

describe('assertImagesWithin', () => {
  it('counts base64 characters, not decoded bytes', () => {
    // Decoded, 4 MiB of base64 is ~3 MiB. Validating decoded bytes accepts
    // payloads ~33% over the real ceiling, which then fail server-side after
    // the entire upload.
    const limits = { ...DEFAULT_IMAGE_INPUT, maxBase64CharsPerImage: 8 };
    expect(() => assertImagesWithin([png(8)], limits)).not.toThrow();
    expect(() => assertImagesWithin([png(12)], limits)).toThrow(/max 8 base64 characters/);
  });

  it('names the data: URL mistake explicitly', () => {
    expect(() => assertImagesWithin(
      [{ data: 'data:image/png;base64,AAAA', mimeType: 'image/png' }],
      DEFAULT_IMAGE_INPUT,
    )).toThrow(/strip the data: URL prefix/);
  });

  it('rejects an unsupported mime type', () => {
    expect(() => assertImagesWithin([{ data: b64(8), mimeType: 'image/tiff' }], DEFAULT_IMAGE_INPUT))
      .toThrow(/unsupported type/);
  });

  it('enforces the image count and the combined ceiling separately', () => {
    const limits = { ...DEFAULT_IMAGE_INPUT, maxImages: 2, maxInlineBase64Chars: 12 };
    expect(() => assertImagesWithin([png(4), png(4), png(4)], limits)).toThrow(/Up to 2 images/);
    expect(() => assertImagesWithin([png(8), png(8)], limits)).toThrow(/combined base64 limit/);
  });

  it('rejects malformed base64', () => {
    expect(() => assertImagesWithin([{ data: 'AAA', mimeType: 'image/png' }], DEFAULT_IMAGE_INPUT))
      .toThrow(/not valid base64/);
    expect(() => assertImagesWithin([{ data: 'AA!A', mimeType: 'image/png' }], DEFAULT_IMAGE_INPUT))
      .toThrow(/not valid base64/);
  });

  it('is an ImageInputError, distinguishable from a service rejection', () => {
    expect(() => assertImagesWithin([], DEFAULT_IMAGE_INPUT)).toThrow(ImageInputError);
  });
});

describe('typed errors', () => {
  it('surfaces image_input_unavailable without a text fallback', async () => {
    // The temptation on this 422 is to drop the attachments and resend the
    // text, which produces a confident answer about an image never seen.
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      JSON.stringify({ code: 'image_input_unavailable', error: 'no vision' }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    ));
    const client = new GoatTownClient({
      baseUrl: 'https://svc.example',
      userId: async () => 'u',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const error = await client.sendImageMessage('s1', 'hi', [png(8)]).catch((e) => e);
    expect(error).toBeInstanceOf(GoatTownError);
    expect((error as GoatTownError).isImageInputUnavailable).toBe(true);
    // One call: the send. No silent retry without images.
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/messages'))).toHaveLength(1);
  });

  it('parses retry-after in seconds and as an absolute date', () => {
    expect(retryAfterSeconds(new Headers({ 'retry-after': '5' }))).toBe(5);
    const future = new Date(Date.now() + 2000).toUTCString();
    const parsed = retryAfterSeconds(new Headers({ 'retry-after': future }));
    expect(parsed).toBeGreaterThan(0);
    expect(retryAfterSeconds(new Headers())).toBeNull();
    expect(retryAfterSeconds(new Headers({ 'retry-after': 'soon' }))).toBeNull();
  });

  it('keeps an unparseable error body as the message', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response('<html>502</html>', { status: 502 }));
    const client = new GoatTownClient({
      baseUrl: 'https://svc.example', userId: async () => 'u',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const error = await client.listAgents().then(() => null, (e: unknown) => e as GoatTownError);
    expect(error).toBeInstanceOf(GoatTownError);
    expect(error!.status).toBe(502);
    expect(error!.body).toContain('502');
  });
});

describe('client transport', () => {
  it('sends the acting user and never an authorization header', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ agents: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    const client = new GoatTownClient({
      baseUrl: 'https://svc.example/', userId: async () => 'user-9',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await client.listAgents();
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get('x-goattown-user')).toBe('user-9');
    // The platform proxy injects the credential and strips any the page
    // sets; shipping one would leak a secret and buy nothing.
    expect(headers.get('authorization')).toBeNull();
  });

  it('names an absent requestId `initial` so callers have one shape', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 's1', title: 't' }), {
        status: 202, headers: { 'content-type': 'application/json' },
      }));
    const client = new GoatTownClient({
      baseUrl: 'https://svc.example', userId: async () => 'u',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.createSession({ prompt: 'hi' })).toMatchObject({ id: 's1', requestId: 'initial' });
  });
});

describe('diagnostics', () => {
  it('redacts credentials by key and replaces image bytes with a length', () => {
    const out = redact({
      authorization: 'Bearer abc',
      sharedCellToken: 'secret',
      nested: { apiKey: 'k', data: 'AAAABBBB' },
      keep: 'visible',
    }) as Record<string, unknown>;
    expect(out.authorization).toBe('[redacted]');
    expect(out.sharedCellToken).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).apiKey).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).data).toBe('[image 8 base64 chars]');
    expect(out.keep).toBe('visible');
  });

  it('bounds the ring buffer and reports what it dropped', () => {
    const diagnostics = new SessionDiagnostics(2);
    for (let seq = 1; seq <= 4; seq += 1) {
      diagnostics.recordFrame({ seq, ev: { kind: 'assistantText', turnId: 't', chunk: 'x' } });
    }
    const snapshot = diagnostics.snapshot();
    expect(snapshot.frames.map((f) => f.seq)).toEqual([3, 4]);
    expect(snapshot.dropped).toBeGreaterThan(0);
    expect(snapshot.cursor).toBe(4);
  });
});

describe('proposal rules', () => {
  const scope: AppConfigurationScope = {
    appConnectionId: 'c', appId: 'a', producer: 'cribl-apm',
    producerInput: 'credential', reviewPath: '/console/i/x/configurations',
  };

  it('rejects a top-level producer field', () => {
    expect(() => assertProposalOmitsProducer('version: 1\nproducer: cribl-apm\n'))
      .toThrow(/Remove the top-level `producer:` field/);
  });

  it('allows a nested producer, which is a different field', () => {
    expect(() => assertProposalOmitsProducer('agents:\n  - slug: a\n    producer: x\n')).not.toThrow();
  });

  it('refuses to stage when the service does not assign producers by credential', async () => {
    const client = new GoatTownClient({
      baseUrl: 'https://svc.example', userId: async () => 'u',
      fetch: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    await expect(
      stageProposal(client, 'version: 1\n', { ...scope, producerInput: 'query' as 'credential' }),
    ).rejects.toThrow(/not by credential/);
  });

  it('blocks a browser credential from coming back', () => {
    expect(() => assertNoBrowserCredential({ authorization: 'Bearer x' }))
      .toThrow(/kv\.sharedCellToken/);
    expect(() => assertNoBrowserCredential({ 'x-goattown-user': 'u' })).not.toThrow();
  });
});
