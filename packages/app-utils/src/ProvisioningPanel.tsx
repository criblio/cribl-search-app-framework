/**
 * Generic Settings-page section for reconciling an app's scheduled
 * saved searches against the workspace.
 *
 * Drop into any Settings page and pass a `ProvisionerConfig` (the
 * same shape passed to `reconcile`/`planOnly`). The panel handles
 * the full preview → apply → results flow, plus a two-click
 * "Unprovision all" escape hatch for resetting state.
 *
 * Customize the help copy via the optional `helpText` and
 * `dangerHelpText` props.
 */
import { useState } from 'react';
import {
  createBrowserHttpClient,
  planOnly,
  applyProvisioningPlan,
  unprovisionAll,
  type ProvisionerConfig,
  type PlanAction,
  type ActionResult,
  type SavedSearchRow,
  type ProvisionedSearch,
} from './provisioner.js';
import s from './ProvisioningPanel.module.css';

type PanelState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'preview';
      plan: ProvisionedSearch[];
      current: SavedSearchRow[];
      actions: PlanAction[];
    }
  | { kind: 'applying'; actions: PlanAction[] }
  | { kind: 'results'; results: ActionResult[] }
  | { kind: 'error'; error: string };

export interface ProvisioningPanelProps {
  /** Same config object passed to reconcile() / planOnly(). The
   * panel uses the framework's HTTP client at runtime. */
  config: ProvisionerConfig;
  /** Optional custom help copy under the section title. */
  helpText?: React.ReactNode;
  /** Optional custom help copy in the Danger zone. */
  dangerHelpText?: React.ReactNode;
}

function countByKind(actions: PlanAction[]): Record<PlanAction['kind'], number> {
  const counts: Record<PlanAction['kind'], number> = {
    create: 0,
    update: 0,
    delete: 0,
    noop: 0,
  };
  for (const a of actions) counts[a.kind]++;
  return counts;
}

function actionLabel(action: PlanAction): string {
  switch (action.kind) {
    case 'create':
      return action.want.id;
    case 'update':
      return action.want.id;
    case 'delete':
      return action.current.id;
    case 'noop':
      return action.want.id;
  }
}

const DEFAULT_HELP = (
  <>
    Scheduled saved searches pre-aggregate the data this app's pages
    read at view time. Re-run the preview after upgrading the pack so
    any new or modified searches are picked up.
  </>
);

const DEFAULT_DANGER_HELP = (prefix: string): React.ReactNode => (
  <>
    Deletes every <code>{prefix}*</code> saved search from the
    workspace. Pages revert to a "no data yet" state until
    re-provisioned. Use before reinstalling the pack or to fully
    reset state.
  </>
);

export default function ProvisioningPanel({
  config,
  helpText,
  dangerHelpText,
}: ProvisioningPanelProps) {
  const [state, setState] = useState<PanelState>({ kind: 'idle' });
  const [confirmUnprovision, setConfirmUnprovision] = useState(false);

  async function handlePreview() {
    setState({ kind: 'loading' });
    try {
      const http = createBrowserHttpClient();
      const { plan, current, actions } = await planOnly(http, config);
      setState({ kind: 'preview', plan, current, actions });
    } catch (err) {
      setState({ kind: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleApply() {
    if (state.kind !== 'preview') return;
    const actions = state.actions;
    setState({ kind: 'applying', actions });
    try {
      const http = createBrowserHttpClient();
      const results = await applyProvisioningPlan(http, actions);
      setState({ kind: 'results', results });
    } catch (err) {
      setState({ kind: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleUnprovision() {
    if (!confirmUnprovision) {
      setConfirmUnprovision(true);
      return;
    }
    setConfirmUnprovision(false);
    setState({ kind: 'loading' });
    try {
      const http = createBrowserHttpClient();
      const results = await unprovisionAll(http, config.prefix);
      setState({ kind: 'results', results });
    } catch (err) {
      setState({ kind: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className={s.card}>
      <h2 className={s.sectionTitle}>Scheduled searches</h2>
      <p className={s.sectionHelp}>{helpText ?? DEFAULT_HELP}</p>

      {state.kind === 'idle' && (
        <div className={s.actions}>
          <button type="button" className={s.primaryBtn} onClick={handlePreview}>
            Preview plan
          </button>
        </div>
      )}

      {state.kind === 'loading' && <div className={s.statusLine}>Loading plan…</div>}

      {state.kind === 'error' && (
        <>
          <div className={s.errorBox}>
            <strong>Error:</strong> {state.error}
          </div>
          <div className={s.actions}>
            <button
              type="button"
              className={s.secondaryBtn}
              onClick={() => setState({ kind: 'idle' })}
            >
              Dismiss
            </button>
          </div>
        </>
      )}

      {state.kind === 'preview' && (
        <PreviewView
          state={state}
          onApply={handleApply}
          onCancel={() => setState({ kind: 'idle' })}
        />
      )}

      {state.kind === 'applying' && (
        <div className={s.statusLine}>
          Applying {state.actions.filter((a) => a.kind !== 'noop').length} change(s)…
        </div>
      )}

      {state.kind === 'results' && (
        <ResultsView results={state.results} onDone={() => setState({ kind: 'idle' })} />
      )}

      <div className={s.dangerZone}>
        <div className={s.dangerTitle}>Danger zone</div>
        <p className={s.dangerHelp}>
          {dangerHelpText ?? DEFAULT_DANGER_HELP(config.prefix)}
        </p>
        <button
          type="button"
          className={confirmUnprovision ? s.dangerBtnConfirm : s.dangerBtn}
          onClick={handleUnprovision}
        >
          {confirmUnprovision ? 'Click again to confirm' : 'Unprovision all'}
        </button>
        {confirmUnprovision && (
          <button
            type="button"
            className={s.secondaryBtn}
            onClick={() => setConfirmUnprovision(false)}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function PreviewView({
  state,
  onApply,
  onCancel,
}: {
  state: { plan: ProvisionedSearch[]; current: SavedSearchRow[]; actions: PlanAction[] };
  onApply: () => void;
  onCancel: () => void;
}) {
  const counts = countByKind(state.actions);
  const hasChanges = counts.create + counts.update + counts.delete > 0;
  return (
    <div>
      <div className={s.summary}>
        <SummaryChip kind="create" count={counts.create} label="Create" />
        <SummaryChip kind="update" count={counts.update} label="Update" />
        <SummaryChip kind="delete" count={counts.delete} label="Delete" />
        <SummaryChip kind="noop" count={counts.noop} label="Unchanged" />
      </div>

      <ul className={s.actionList}>
        {state.actions.map((action) => (
          <li key={actionLabel(action)} className={s.actionRow}>
            <span className={`${s.actionKind} ${s[`actionKind_${action.kind}`]}`}>
              {action.kind}
            </span>
            <span className={s.actionId}>{actionLabel(action)}</span>
          </li>
        ))}
      </ul>

      <div className={s.actions}>
        <button
          type="button"
          className={s.primaryBtn}
          onClick={onApply}
          disabled={!hasChanges}
        >
          {hasChanges ? 'Apply' : 'Nothing to do'}
        </button>
        <button type="button" className={s.secondaryBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SummaryChip({
  kind,
  count,
  label,
}: {
  kind: PlanAction['kind'];
  count: number;
  label: string;
}) {
  return (
    <span className={`${s.summaryChip} ${s[`summaryChip_${kind}`]}`}>
      <span className={s.summaryCount}>{count}</span>
      <span className={s.summaryLabel}>{label}</span>
    </span>
  );
}

function ResultsView({
  results,
  onDone,
}: {
  results: ActionResult[];
  onDone: () => void;
}) {
  const failures = results.filter((r) => !r.ok);
  const okCount = results.filter((r) => r.ok).length;
  return (
    <div>
      <div className={s.statusLine}>
        {failures.length === 0 ? (
          <>All {okCount} action(s) applied cleanly.</>
        ) : (
          <>
            {okCount} succeeded,{' '}
            <strong className={s.errText}>{failures.length} failed</strong>.
          </>
        )}
      </div>
      <ul className={s.actionList}>
        {results.map((r) => (
          <li key={actionLabel(r.action)} className={s.actionRow}>
            <span
              className={`${s.actionKind} ${
                r.ok ? s.actionKind_noop : s.actionKind_delete
              }`}
            >
              {r.ok ? 'ok' : 'fail'}
            </span>
            <span className={s.actionId}>
              {r.action.kind}: {actionLabel(r.action)}
            </span>
            {r.error && <span className={s.errText}>{r.error}</span>}
          </li>
        ))}
      </ul>
      <div className={s.actions}>
        <button type="button" className={s.primaryBtn} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
