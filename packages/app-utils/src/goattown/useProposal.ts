/**
 * React state for the stage → review → confirm provisioning flow.
 *
 * Kept apart from the component so an app with its own settings design can
 * reuse the state machine without the markup, and so the transitions are
 * testable without a DOM.
 *
 * The flow is deliberately not a single "provision" button. Staging is
 * automatic; activation is a human action in another product, and there is
 * no call this app can make to complete it. The state machine therefore has
 * a waiting state with no progress bar — the app is waiting on a person.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppConfigurationScope } from '@criblio/agent-protocol';
import type { GoatTownClient } from './client.js';
import {
  openReviewPage,
  readProposalScope,
  readProposalStatus,
  stageProposal,
  type ProposalStatus,
  type StagedProposal,
} from './provisioning.js';

export type ProposalPhase =
  /** Reading /protocol. */
  | 'loading'
  /** This credential cannot propose configuration. */
  | 'unsupported'
  /** Ready to stage. */
  | 'idle'
  | 'staging'
  /** Stored, waiting for a human to activate it. */
  | 'awaiting-activation'
  /** Active and the agent is in the catalog. */
  | 'active'
  | 'error';

export interface UseProposalOptions {
  client: GoatTownClient;
  /** Build the proposal YAML. Must NOT include a top-level `producer:` —
   *  the credential supplies it. */
  buildYaml: () => string;
  /** Agent slug to confirm in the live catalog after activation. */
  agentSlug: string;
  /** Persist/restore the staged revision id across reloads, so a page
   *  refresh while waiting for an administrator does not lose track of what
   *  was staged. */
  persist?: {
    read: () => string | null;
    write: (revisionId: string | null) => void;
  };
}

export interface UseProposalResult {
  phase: ProposalPhase;
  scope: AppConfigurationScope | null;
  staged: StagedProposal | null;
  status: ProposalStatus | null;
  error: string | null;
  /** Validate and store a revision. Never activates. */
  stage: () => Promise<void>;
  /** Open the human review page (new tab, opener severed). */
  review: () => void;
  /** Re-read activation status. */
  refresh: () => Promise<void>;
}

export function useProposal(options: UseProposalOptions): UseProposalResult {
  const { client, buildYaml, agentSlug, persist } = options;
  const [phase, setPhase] = useState<ProposalPhase>('loading');
  const [scope, setScope] = useState<AppConfigurationScope | null>(null);
  const [staged, setStaged] = useState<StagedProposal | null>(null);
  const [status, setStatus] = useState<ProposalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Survives unmount so a late response cannot setState on a dead component.
  const alive = useRef(true);

  const revisionId = staged?.revisionId ?? persist?.read() ?? null;

  const refresh = useCallback(async () => {
    try {
      const next = await readProposalStatus(client, revisionId, agentSlug);
      if (!alive.current) return;
      setStatus(next);
      // Both conditions: an active revision whose agent never appeared is
      // not a working install, and saying "active" would send the user off
      // to debug the wrong thing.
      setPhase(next.isActive && next.agentAvailable ? 'active' : 'awaiting-activation');
    } catch (err) {
      if (!alive.current) return;
      setError(messageOf(err));
      setPhase('error');
    }
  }, [client, revisionId, agentSlug]);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const found = await readProposalScope(client);
        if (!alive.current) return;
        setScope(found);
        if (!found) {
          setPhase('unsupported');
          return;
        }
        if (revisionId) await refresh();
        else setPhase('idle');
      } catch (err) {
        if (!alive.current) return;
        setError(messageOf(err));
        setPhase('error');
      }
    })();
    return () => {
      alive.current = false;
    };
    // `refresh` and `revisionId` are intentionally excluded: this effect is
    // the mount-time discovery pass, and including them re-runs discovery on
    // every staging result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const stage = useCallback(async () => {
    if (!scope) return;
    setPhase('staging');
    setError(null);
    try {
      const result = await stageProposal(client, buildYaml(), scope);
      if (!alive.current) return;
      setStaged(result);
      persist?.write(result.revisionId);
      setPhase('awaiting-activation');
      await refresh();
    } catch (err) {
      if (!alive.current) return;
      setError(messageOf(err));
      setPhase('error');
    }
  }, [client, scope, buildYaml, persist, refresh]);

  const review = useCallback(() => {
    const path = staged?.reviewPath ?? scope?.reviewPath;
    if (path) openReviewPage(client.baseUrl, path);
  }, [client.baseUrl, staged, scope]);

  return { phase, scope, staged, status, error, stage, review, refresh };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
