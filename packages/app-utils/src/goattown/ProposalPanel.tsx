/**
 * Settings-page panel for staging a GoatTown configuration proposal.
 *
 * The screen has to make one thing unmistakable: **this app cannot finish
 * the job.** It validates and stores an immutable revision; a tenant
 * administrator then reviews and activates it in GoatTown. A panel that
 * shows a spinner after staging implies the app is working on it, so the
 * waiting state names the person who has to act instead.
 */
import { Button } from '@capra/core';
import type { GoatTownClient } from './client.js';
import { useProposal, type UseProposalOptions } from './useProposal.js';
import s from './ProposalPanel.module.css';

export interface ProposalPanelProps extends UseProposalOptions {
  client: GoatTownClient;
  /** Shown as the panel heading. */
  title?: string;
  /** One line describing what the proposal contains. */
  description?: string;
}

export function ProposalPanel({
  title = 'Agent configuration',
  description,
  ...options
}: ProposalPanelProps) {
  const { phase, scope, staged, status, error, stage, review } = useProposal(options);

  return (
    <div className={s.panel}>
      <div className={s.title}>{title}</div>
      {description && <div className={s.body}>{description}</div>}

      {phase === 'loading' && <div className={s.body}>Checking this app&apos;s configuration scope…</div>}

      {phase === 'unsupported' && (
        <div className={s.body}>
          This connected app credential cannot propose agent configuration. Ask a tenant
          administrator to grant it a configuration producer, then reload.
        </div>
      )}

      {phase === 'idle' && (
        <div className={s.body}>
          Staging validates the configuration and stores an immutable revision. It does not
          activate anything — an administrator reviews and activates it in GoatTown.
        </div>
      )}

      {phase === 'awaiting-activation' && (
        <div className={s.waiting}>
          <strong>Waiting for an administrator.</strong> Revision{' '}
          <code>{staged?.revisionId ?? status?.stagedRevisionId}</code> is stored but not active.
          {status && !status.agentAvailable && status.isActive && (
            <> The revision is active, but the agent is not in the catalog yet.</>
          )}
        </div>
      )}

      {phase === 'active' && (
        <div className={s.body}>
          Active. The agent is available in the catalog.
        </div>
      )}

      {scope && (
        // Surfaced rather than hidden: when a proposal is rejected for
        // producer mismatch, the assigned producer is the fact that explains
        // it, and it is otherwise invisible to the person reading this page.
        <div className={s.meta}>
          producer {scope.producer} (assigned by credential) · review at {scope.reviewPath}
        </div>
      )}

      {error && <div className={s.error}>{error}</div>}

      <div className={s.actions}>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void stage()}
          disabled={phase === 'loading' || phase === 'staging' || phase === 'unsupported'}
        >
          {phase === 'staging' ? 'Staging…' : staged ? 'Re-stage' : 'Stage configuration'}
        </Button>
        {(phase === 'awaiting-activation' || phase === 'active') && (
          <Button variant="secondary" size="sm" onClick={review}>
            Open review page
          </Button>
        )}
      </div>
    </div>
  );
}

export default ProposalPanel;
