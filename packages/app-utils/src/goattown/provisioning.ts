/**
 * Stage a GoatTown configuration proposal from an app.
 *
 * Two rules shape this module, and both are the opposite of what the
 * previous generation of app code did.
 *
 * **The producer comes from the credential, not from the YAML.** The service
 * assigns a producer to each app credential and advertises it at
 * `/protocol` as `proposalScope.producer` with
 * `producerInput: 'credential'`. A proposal that declares its own `producer`
 * is rejected with `producer_mismatch`. So the YAML is submitted without
 * one, and this module refuses to submit at all unless the scope says
 * `credential` — a service that still wants a declared producer needs a
 * different call, not a guess.
 *
 * **No second credential belongs in the browser.** APM historically stashed
 * a shared service token in the KV store (`kv.sharedCellToken`) and set it
 * as an `authorization` header. That was never necessary — the platform
 * proxy injects the app's own credential for declared domains, and strips
 * any `authorization` the page sets, so the stored token bought nothing and
 * put a long-lived secret somewhere a screenshot could reach.
 * `assertNoBrowserCredential` exists to keep that from coming back.
 *
 * Activation stays human. This validates and stores an immutable revision;
 * a tenant administrator reviews and activates it at `scope.reviewPath`.
 */
import type { AppConfigurationScope } from '@criblio/agent-protocol';
import { errorFromResponse } from './errors.js';
import type { GoatTownClient } from './client.js';

export interface StagedProposal {
  revisionId: string;
  changes: number;
  hasConflicts: boolean;
  /** The producer the credential is assigned. Shown to the human so the
   *  review page is recognisable. */
  producer: string;
  /** Where a human activates it. */
  reviewPath: string;
}

export interface ProposalStatus {
  /** The revision this app last staged, if known. */
  stagedRevisionId: string | null;
  /** The revision the tenant currently has active. */
  activeRevisionId: string | null;
  /** True only when the staged revision is the active one. */
  isActive: boolean;
  /** True when the agent is present in the live catalog. */
  agentAvailable: boolean;
}

/**
 * Read the proposal scope this credential is assigned.
 *
 * Returns null when the service advertises none — that is a real answer
 * (this credential cannot propose configuration), not a transient failure,
 * and the UI should say so rather than offer a button that will 403.
 */
export async function readProposalScope(
  client: GoatTownClient,
  signal?: AbortSignal,
): Promise<AppConfigurationScope | null> {
  const protocol = await client.protocol(signal);
  return protocol.proposalScope ?? null;
}

/**
 * Guard against a credential being reintroduced into the browser.
 *
 * Called by the settings component before staging. Throws rather than
 * warns: the failure it prevents is a leaked long-lived token, and a
 * console warning is not a control.
 */
export function assertNoBrowserCredential(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization') {
      throw new Error(
        'Do not send an authorization header from the browser. The platform proxy injects the ' +
        'app credential for domains declared in config/proxies.yml and strips any header the page ' +
        'sets, so a stored token (APM\'s historical kv.sharedCellToken) adds no access and leaks a ' +
        'long-lived secret into client storage.',
      );
    }
  }
}

/**
 * Validate then store a configuration revision.
 *
 * Validate-before-store is not belt-and-braces: a store writes an immutable
 * revision, so a malformed proposal that goes straight to store leaves a
 * permanent bad revision in the tenant's history for a human to read past.
 */
export async function stageProposal(
  client: GoatTownClient,
  yaml: string,
  scope: AppConfigurationScope,
  signal?: AbortSignal,
): Promise<StagedProposal> {
  if (scope.producerInput !== 'credential') {
    throw new Error(
      `This service assigns producers by ${String(scope.producerInput)}, not by credential. ` +
      'Refusing to stage: the proposal would be attributed to the wrong producer.',
    );
  }
  assertProposalOmitsProducer(yaml);

  await configurationRequest(client, 'validate', yaml, signal);
  const stored = await configurationRequest(client, 'store', yaml, signal);
  const revision = (stored as { revision?: { id?: unknown } }).revision;
  if (typeof revision?.id !== 'string' || !revision.id) {
    throw new Error('GoatTown stored the configuration but returned no revision id.');
  }
  const diff = await configurationRequest(client, 'diff', undefined, signal, {
    revision: revision.id,
  });
  return {
    revisionId: revision.id,
    changes: typeof (diff as { changes?: unknown }).changes === 'number'
      ? (diff as { changes: number }).changes
      : 0,
    hasConflicts: (diff as { hasConflicts?: unknown }).hasConflicts === true,
    producer: scope.producer,
    reviewPath: scope.reviewPath,
  };
}

/**
 * Has a human activated the staged revision?
 *
 * Compares the tenant's `metadata.activeRevisionId` with what we staged, and
 * separately confirms the agent is in the live catalog. Both are reported:
 * an active revision whose agent is missing means the activation landed but
 * the agent did not, which is a different conversation to have with the
 * administrator.
 */
export async function readProposalStatus(
  client: GoatTownClient,
  stagedRevisionId: string | null,
  agentSlug: string,
  signal?: AbortSignal,
): Promise<ProposalStatus> {
  const metadata = await configurationRequest(client, 'metadata', undefined, signal)
    .catch(() => ({} as Record<string, unknown>));
  const active = (metadata as { metadata?: { activeRevisionId?: unknown } }).metadata?.activeRevisionId
    ?? (metadata as { activeRevisionId?: unknown }).activeRevisionId;
  const activeRevisionId = typeof active === 'string' ? active : null;
  const agents = await client.listAgents(signal).catch(() => []);
  return {
    stagedRevisionId,
    activeRevisionId,
    isActive: !!stagedRevisionId && stagedRevisionId === activeRevisionId,
    agentAvailable: agents.some((agent) => agent.slug === agentSlug),
  };
}

/**
 * Open the human review page in a new tab, severing the opener.
 *
 * `noopener` is the reason this is a helper rather than an inline
 * `window.open`: without it the opened page gets a live `window.opener`
 * handle back into the app's origin, which is a navigation hijack waiting
 * to happen. `noreferrer` is set alongside it for browsers that only honour
 * the older form.
 */
export function openReviewPage(baseUrl: string, reviewPath: string): void {
  const url = `${baseUrl.replace(/\/$/, '')}${reviewPath}`;
  const opened = globalThis.window?.open(url, '_blank', 'noopener,noreferrer');
  if (opened) opened.opener = null;
}

/** Reject a proposal that declares a producer, naming the fix. */
export function assertProposalOmitsProducer(yaml: string): void {
  // Top-level key only: a `producer:` nested under an agent or profile is a
  // different field and is none of this check's business.
  if (/^producer\s*:/m.test(yaml)) {
    throw new Error(
      'Remove the top-level `producer:` field from the proposal. The credential supplies the ' +
      'producer; declaring one is rejected with producer_mismatch.',
    );
  }
}

/** POST/GET /configurations with the action query the service expects. */
async function configurationRequest(
  client: GoatTownClient,
  action: string,
  yaml: string | undefined,
  signal?: AbortSignal,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({ action, ...params });
  // Deliberately not routed through the client's JSON request helper: this
  // endpoint takes application/yaml and the helper would JSON-encode it.
  const headers = new Headers({
    accept: 'application/json',
    'x-goattown-user': await client.actingUser(),
  });
  if (yaml !== undefined) headers.set('content-type', 'application/yaml');
  const response = await fetch(`${client.baseUrl}/configurations?${query.toString()}`, {
    method: yaml === undefined ? 'GET' : 'POST',
    headers,
    body: yaml,
    signal,
  });
  if (!response.ok) throw await errorFromResponse(response);
  return (await response.json()) as Record<string, unknown>;
}
