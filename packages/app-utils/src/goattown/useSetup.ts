/**
 * First-run setup for an app that drives a GoatTown agent.
 *
 * Getting an app from "installed" to "can actually run its agent" takes
 * five things that fail independently: a service URL, a credential, a
 * working authenticated call, a staged configuration revision, and a human
 * activating it. Every app was writing this flow, and the failure they
 * shared is the one this is built to prevent — **treating a saved setting
 * as a working setup**. A stored URL proves someone typed a URL. It does
 * not prove the service answers, that the credential is accepted, that the
 * configuration was activated, or that the agent exists.
 *
 * So `ready` is VERIFIED readiness, and it requires all four in the same
 * pass: an authenticated call succeeded, a revision is staged, that exact
 * revision is the active one, and the agent named by the consumer is in
 * the live catalog. Nothing here infers one from another.
 *
 * Two related rules:
 *
 *  - **A missing agent is never replaced.** If the app asks for
 *    `my-app-analyst` and the catalog has only `investigator`, that is not
 *    ready. Substituting a generic agent produces an app that runs with
 *    the wrong instructions and tools and looks like it works.
 *  - **No installation token, ever.** Authentication is proxy-injected:
 *    the app writes its token to the KV store and `proxies.yml`
 *    `headers.inject` reads it server-side. Writing a secret there is
 *    supported and is what this does. What is forbidden is READING a saved
 *    secret back, or setting an `authorization` header from page code —
 *    the proxy strips it anyway, so it buys nothing and leaks something.
 *
 * Public setup state (service URL, staged revision) lives in the app's KV
 * store, which is app-scoped rather than per-browser, so it survives a
 * reload and is shared across members. The token is written to a separate
 * key and never read back by this module.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppConfigurationScope } from '@criblio/agent-protocol';
import { KvError, kvGetJson, kvPutJson, kvPutText } from '../kv.js';
import { GoatTownClient } from './client.js';
import { SessionDiagnostics, type DiagnosticSnapshot } from './diagnostics.js';
import { GoatTownError } from './errors.js';
import {
  openReviewPage,
  readProposalScope,
  readProposalStatus,
  stageProposal,
  type ProposalStatus,
  type StagedProposal,
} from './provisioning.js';

/** Where the flow currently is. Each value names something different for a
 *  human to do — which is why this is not a boolean or a percentage. */
export type SetupStep =
  | 'loading'
  /** No service URL saved yet. */
  | 'needs-url'
  /** The service rejected the credential. Either enter an app token or
   *  have an administrator deliver one through Connected apps. */
  | 'needs-credential'
  /** Authenticated, but the app's configuration has never been staged. */
  | 'needs-proposal'
  /** Staged and waiting on a human to activate it in GoatTown. */
  | 'awaiting-activation'
  /** Verified: authenticated, active revision, agent present. */
  | 'ready'
  /** Something failed in a way the user cannot resolve by continuing. */
  | 'error';

/** Public, shareable setup state. Deliberately contains no secret. */
export interface SetupState {
  serviceUrl: string;
  stagedRevisionId: string | null;
}

export interface UseSetupOptions {
  /** Agent slug the app requires. Checked exactly; never substituted. */
  agentSlug: string;
  /** The app's bundled configuration. Must omit a top-level `producer:`. */
  buildYaml: () => string;
  /** Default service URL offered before anything is saved. */
  defaultServiceUrl?: string;
  /** KV key holding the public setup state. App-scoped, so it is shared
   *  across members and survives reloads. */
  stateKey?: string;
  /** KV key the proxy reads the token from. Must match the `${kv.…}`
   *  reference in `config/proxies.yml`. */
  tokenKey?: string;
  /** Injected for tests. */
  createClient?: (baseUrl: string) => GoatTownClient;
  /** Resolve the acting Cribl user id. */
  userId?: () => Promise<string>;
}

export interface UseSetupResult {
  step: SetupStep;
  /**
   * VERIFIED readiness. Gate the app's main feature on this and nothing
   * else — in particular not on `serviceUrl` being set.
   */
  ready: boolean;
  serviceUrl: string;
  /** Local edit buffer; not persisted until `saveServiceUrl`. */
  setServiceUrl: (url: string) => void;
  /** Persist the URL and immediately re-verify. A checked KV write: a
   *  rejected save throws rather than appearing to succeed. */
  saveServiceUrl: () => Promise<void>;
  /** Write the app token to the KV store the proxy injects from, then
   *  re-verify. Write-only — the value is never read back or logged. */
  saveToken: (token: string) => Promise<void>;
  /** Validate and store a configuration revision. Never activates. */
  stage: () => Promise<void>;
  /** Open the human review page (new tab, opener severed). */
  review: () => void;
  /** Re-run every check. The button a user presses after an administrator
   *  says they have done their part. */
  recheck: () => Promise<void>;
  scope: AppConfigurationScope | null;
  status: ProposalStatus | null;
  staged: StagedProposal | null;
  error: string | null;
  /** Redacted record of every call this flow made. */
  diagnostics: DiagnosticSnapshot;
  busy: boolean;
}

const DEFAULT_STATE_KEY = 'goattown-setup';
const DEFAULT_TOKEN_KEY = 'goattown_token';

export function useSetup(options: UseSetupOptions): UseSetupResult {
  const {
    agentSlug, buildYaml, defaultServiceUrl = '',
    stateKey = DEFAULT_STATE_KEY, tokenKey = DEFAULT_TOKEN_KEY,
    createClient, userId,
  } = options;

  const [step, setStep] = useState<SetupStep>('loading');
  const [serviceUrl, setServiceUrl] = useState(defaultServiceUrl);
  const [savedUrl, setSavedUrl] = useState('');
  const [scope, setScope] = useState<AppConfigurationScope | null>(null);
  const [status, setStatus] = useState<ProposalStatus | null>(null);
  const [staged, setStaged] = useState<StagedProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<DiagnosticSnapshot>(() => new SessionDiagnostics().snapshot());

  const alive = useRef(true);
  /** Only the newest verification writes state. A slow earlier check
   *  against a stale URL must never overwrite a newer one — that is how a
   *  corrected URL gets clobbered by the failure it was meant to fix. */
  const generation = useRef(0);
  const diagnostics = useRef(new SessionDiagnostics());

  const clientFor = useCallback((url: string) => (
    createClient
      ? createClient(url)
      : new GoatTownClient({
        baseUrl: url,
        userId: userId ?? defaultUserId,
        onDiagnostic: diagnostics.current.sink,
      })
  ), [createClient, userId]);

  /**
   * Run every check against `url` and settle the step.
   *
   * One function rather than a chain of effects, because the checks are
   * only meaningful together: authentication that succeeded five seconds
   * ago does not make an inactive revision ready.
   */
  const verify = useCallback(async (url: string, revisionId: string | null) => {
    const mine = ++generation.current;
    const settle = (next: SetupStep, message?: string) => {
      if (!alive.current || mine !== generation.current) return false;
      setStep(next);
      setError(message ?? null);
      setSnapshot(diagnostics.current.snapshot());
      return true;
    };

    if (!url) return settle('needs-url');
    const client = clientFor(url);

    // 1. Authenticated call. A saved URL proves nothing until this passes.
    let found: AppConfigurationScope | null;
    try {
      found = await readProposalScope(client);
    } catch (err) {
      if (err instanceof GoatTownError && err.isPermanentAuthFailure) {
        return settle('needs-credential',
          'The service rejected this app\'s credential. Save an app token below, or ask an '
          + 'administrator to deliver one through Connected apps.');
      }
      return settle('error', describe(err));
    }
    if (!alive.current || mine !== generation.current) return false;
    setScope(found);
    if (!found) {
      return settle('error',
        'Connected, but this credential is not allowed to propose agent configuration. Ask an '
        + 'administrator to assign it a configuration producer.');
    }

    // 2. Configuration state. Both halves are required, and the agent is
    //    checked by its exact slug — a different agent being present is
    //    not a substitute.
    let next: ProposalStatus;
    try {
      next = await readProposalStatus(client, revisionId, agentSlug);
    } catch (err) {
      return settle('error', describe(err));
    }
    if (!alive.current || mine !== generation.current) return false;
    setStatus(next);

    if (!next.stagedRevisionId) return settle('needs-proposal');
    if (!next.isActive) {
      return settle('awaiting-activation',
        `Revision ${next.stagedRevisionId} is stored but not active. An administrator activates `
        + 'it in GoatTown; press Re-check afterwards.');
    }
    if (!next.agentAvailable) {
      return settle('awaiting-activation',
        `The configuration is active, but the agent "${agentSlug}" is not in the catalog yet. `
        + 'This app requires that agent specifically and will not run against a different one.');
    }
    return settle('ready');
  }, [agentSlug, clientFor]);

  /** Load public state, then verify. */
  useEffect(() => {
    alive.current = true;
    void (async () => {
      let state: SetupState = { serviceUrl: defaultServiceUrl, stagedRevisionId: null };
      try {
        const stored = await kvGetJson<SetupState>(stateKey);
        if (stored.found) state = { ...state, ...stored.value };
      } catch (err) {
        // A routing failure is NOT "no state yet" — see the kv module.
        if (!alive.current) return;
        setStep('error');
        setError(describe(err));
        return;
      }
      if (!alive.current) return;
      setSavedUrl(state.serviceUrl);
      setServiceUrl((current) => (current === defaultServiceUrl ? state.serviceUrl : current));
      await verify(state.serviceUrl, state.stagedRevisionId);
    })();
    return () => { alive.current = false; };
    // Mount-time load only; `verify` is re-created per render by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey, defaultServiceUrl]);

  const persist = useCallback(async (next: SetupState) => {
    // A checked write. kvPutJson throws on a rejected save rather than
    // letting the setting appear to stick and vanish on reload.
    await kvPutJson(stateKey, next);
  }, [stateKey]);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      if (alive.current) {
        setError(describe(err));
        setStep('error');
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const saveServiceUrl = useCallback(() => run(async () => {
    const url = serviceUrl.trim().replace(/\/$/, '');
    if (!url) throw new Error('Enter the GoatTown service URL.');
    await persist({ serviceUrl: url, stagedRevisionId: status?.stagedRevisionId ?? null });
    if (!alive.current) return;
    setSavedUrl(url);
    await verify(url, status?.stagedRevisionId ?? null);
  }), [run, serviceUrl, persist, status, verify]);

  const saveToken = useCallback((token: string) => run(async () => {
    const value = token.trim();
    if (!value) throw new Error('Enter the app token.');
    // Write-only. The proxy reads this key server-side via
    // proxies.yml headers.inject; nothing here reads it back, and the
    // value never reaches an error message or a diagnostic.
    await kvPutText(tokenKey, value);
    if (!alive.current) return;
    await verify(savedUrl || serviceUrl.trim(), status?.stagedRevisionId ?? null);
  }), [run, tokenKey, savedUrl, serviceUrl, status, verify]);

  const stage = useCallback(() => run(async () => {
    if (!scope) throw new Error('Not connected yet.');
    const url = savedUrl || serviceUrl.trim();
    const result = await stageProposal(clientFor(url), buildYaml(), scope);
    if (!alive.current) return;
    setStaged(result);
    await persist({ serviceUrl: url, stagedRevisionId: result.revisionId });
    if (!alive.current) return;
    // The revision just staged, explicitly — state has not landed yet.
    await verify(url, result.revisionId);
  }), [run, scope, savedUrl, serviceUrl, clientFor, buildYaml, persist, verify]);

  const recheck = useCallback(() => run(async () => {
    await verify(savedUrl || serviceUrl.trim(), staged?.revisionId ?? status?.stagedRevisionId ?? null);
  }), [run, savedUrl, serviceUrl, staged, status, verify]);

  const review = useCallback(() => {
    const path = staged?.reviewPath ?? scope?.reviewPath;
    if (path) openReviewPage(savedUrl || serviceUrl.trim(), path);
  }, [staged, scope, savedUrl, serviceUrl]);

  return {
    step,
    // Readiness is the step and nothing else. In particular a saved URL
    // does not imply it.
    ready: step === 'ready',
    serviceUrl,
    setServiceUrl,
    saveServiceUrl,
    saveToken,
    stage,
    review,
    recheck,
    scope,
    status,
    staged,
    error,
    diagnostics: snapshot,
    busy,
  };
}

async function defaultUserId(): Promise<string> {
  const getCriblUser = (globalThis as unknown as {
    getCriblUser?: () => Promise<{ id?: unknown }>;
  }).getCriblUser;
  const user = typeof getCriblUser === 'function' ? await getCriblUser() : null;
  if (typeof user?.id === 'string' && user.id) return user.id;
  throw new Error('GoatTown requires a signed-in Cribl user, but getCriblUser() returned no id.');
}

/** Message only. A KvError already carries its status and body KIND, never
 *  a body — so nothing here can leak a stored value. */
function describe(error: unknown): string {
  if (error instanceof KvError || error instanceof GoatTownError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
