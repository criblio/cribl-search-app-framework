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
 *
 * Apply goes through `applyProvisioningActions` — the same path as
 * `reconcile()` — so the plan guard, lookup seeding and notification
 * bindings run here exactly as they do from a CLI. A plan that fails the
 * guard is shown as a problem list with no Apply button.
 */
import { useState } from 'react';
import {
  createBrowserHttpClient,
  planOnly,
  applyProvisioningActions,
  unprovisionAll,
  type ProvisionerConfig,
  type PlanAction,
  type ActionResult,
  type SavedSearchRow,
  type ProvisionedSearch,
  type HttpClient,
  type NotificationResult,
} from './provisioner.js';
import { ProvisionPlanError, type ProvisionProblem } from './provision-guard.js';
import {
  runProvisionCanary,
  type ProvisionCanaryOptions,
  type ProvisionCanaryReport,
} from './provision-canary.js';
import s from './ProvisioningPanel.module.css';

/** One app-specific provisioning step run after the saved-search
 *  reconcile (e.g. a webhook target + notification binding). Reported
 *  as its own result row alongside the searches. */
export interface ProvisioningExtraStep {
  label: string;
  ok: boolean;
  detail?: string;
}

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
  | { kind: 'results'; results: ActionResult[]; extra?: ProvisioningExtraStep[] }
  | { kind: 'invalid'; problems: ProvisionProblem[] }
  | { kind: 'checking' }
  | { kind: 'error'; error: string };

export interface ProvisioningPanelProps {
  /** Same config object passed to reconcile() / planOnly(). The
   * panel uses the framework's HTTP client at runtime. */
  config: ProvisionerConfig;
  /** Optional custom help copy under the section title. */
  helpText?: React.ReactNode;
  /** Optional custom help copy in the Danger zone. */
  dangerHelpText?: React.ReactNode;
  /**
   * Optional app-specific steps to run on "Apply", AFTER the saved-search
   * reconcile (so any search the steps depend on already exists). Lets an
   * app do everything its CLI provisioner does from the same button —
   * e.g. ensure a notification target + binding. Receives the same
   * browser HTTP client; return a result row per step. Thrown errors are
   * caught and surfaced as a failed step, never failing the reconcile.
   */
  afterReconcile?: (http: HttpClient) => Promise<ProvisioningExtraStep[]>;
  /**
   * Optional post-reconcile canary (`runProvisionCanary`), run after
   * Apply and `afterReconcile`, and on demand from a "Run health check"
   * button. Each probe is reported as a result row. `firstInstall`
   * defaults to "this Apply created the sentinel search" — a search
   * created seconds ago cannot have results yet.
   */
  canary?: Omit<ProvisionCanaryOptions, 'firstInstall'> & { firstInstall?: boolean };
}

/** Result rows for a canary report. */
export function canarySteps(report: ProvisionCanaryReport): ProvisioningExtraStep[] {
  return report.probes.map((p) => ({
    label: `Health check: ${p.name}${p.tolerated ? ' (tolerated)' : ''}`,
    ok: p.ok,
    detail: p.message,
  }));
}

function notificationSteps(results: NotificationResult[]): ProvisioningExtraStep[] {
  return results.map((n) => ({
    label: `Notification ${n.step}: ${n.searchId}${n.ok && n.detail ? ` (${n.detail})` : ''}`,
    ok: n.ok,
    detail: n.error,
  }));
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
  afterReconcile,
  canary,
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
      setState(failureState(err));
    }
  }

  async function runCanary(
    http: HttpClient,
    firstInstall: boolean,
  ): Promise<ProvisioningExtraStep[]> {
    if (!canary) return [];
    try {
      const report = await runProvisionCanary(http, {
        ...canary,
        firstInstall: canary.firstInstall ?? firstInstall,
      });
      return canarySteps(report);
    } catch (err) {
      return [
        {
          label: 'Health check',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        },
      ];
    }
  }

  async function handleHealthCheck() {
    setState({ kind: 'checking' });
    const extra = await runCanary(createBrowserHttpClient(), false);
    setState({ kind: 'results', results: [], extra });
  }

  async function handleApply() {
    if (state.kind !== 'preview') return;
    const actions = state.actions;
    setState({ kind: 'applying', actions });
    try {
      const http = createBrowserHttpClient();
      // The same apply path as reconcile(): re-validates (so this button
      // can never write a plan the guard refuses), seeds lookups — every
      // `| lookup <name>` search fails to create without them — then
      // unbinds deleted searches, writes, and binds notifications.
      // Preview stays read-only; all of that is a write.
      const { results, notifications } = await applyProvisioningActions(http, config, actions);
      const extra: ProvisioningExtraStep[] = notificationSteps(notifications);
      // App-specific post-reconcile steps (e.g. webhook target + binding).
      // Runs after the searches so anything they depend on exists; a
      // throw becomes a failed step rather than failing the whole apply.
      if (afterReconcile) {
        try {
          extra.push(...(await afterReconcile(http)));
        } catch (err) {
          extra.push({
            label: 'Post-reconcile steps',
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (canary) {
        const sentinelCreated = actions.some(
          (a) => a.kind === 'create' && a.want.id === canary.sentinelSearchId,
        );
        extra.push(...(await runCanary(http, sentinelCreated)));
      }
      setState({ kind: 'results', results, extra: extra.length ? extra : undefined });
    } catch (err) {
      setState(failureState(err));
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
      setState(failureState(err));
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
          {canary && (
            <button type="button" className={s.secondaryBtn} onClick={handleHealthCheck}>
              Run health check
            </button>
          )}
        </div>
      )}

      {state.kind === 'loading' && <div className={s.statusLine}>Loading plan…</div>}

      {state.kind === 'checking' && (
        <div className={s.statusLine}>Checking the scheduled searches' output…</div>
      )}

      {state.kind === 'invalid' && (
        <InvalidPlanView problems={state.problems} onDismiss={() => setState({ kind: 'idle' })} />
      )}

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
        <ResultsView
          results={state.results}
          extra={state.extra}
          onDone={() => setState({ kind: 'idle' })}
        />
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

function failureState(err: unknown): PanelState {
  if (err instanceof ProvisionPlanError) return { kind: 'invalid', problems: err.problems };
  return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
}

/** A plan the guard refused. Deliberately no Apply button. */
export function InvalidPlanView({
  problems,
  onDismiss,
}: {
  problems: ProvisionProblem[];
  onDismiss: () => void;
}) {
  return (
    <div>
      <div className={s.errorBox}>
        <strong>Plan refused:</strong> {problems.length} problem(s) must be fixed in the
        app's provisioning plan before it can be applied. Nothing was written.
      </div>
      <ul className={s.actionList}>
        {problems.map((p, i) => (
          <li key={`${p.searchId}:${p.rule}:${i}`} className={s.actionRow}>
            <span className={`${s.actionKind} ${s.actionKind_delete}`}>{p.rule}</span>
            <span className={s.actionId}>{p.searchId}</span>
            <span className={s.errText}>{p.message}</span>
          </li>
        ))}
      </ul>
      <div className={s.actions}>
        <button type="button" className={s.secondaryBtn} onClick={onDismiss}>
          Dismiss
        </button>
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
  extra,
  onDone,
}: {
  results: ActionResult[];
  extra?: ProvisioningExtraStep[];
  onDone: () => void;
}) {
  const failures = results.filter((r) => !r.ok);
  const okCount = results.filter((r) => r.ok).length;
  const extraFailures = (extra ?? []).filter((e) => !e.ok).length;
  return (
    <div>
      <div className={s.statusLine}>
        {failures.length === 0 && extraFailures === 0 ? (
          <>All {okCount + (extra?.length ?? 0)} action(s) applied cleanly.</>
        ) : (
          <>
            {okCount + (extra?.length ?? 0) - failures.length - extraFailures} succeeded,{' '}
            <strong className={s.errText}>{failures.length + extraFailures} failed</strong>.
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
        {(extra ?? []).map((e) => (
          <li key={`extra:${e.label}`} className={s.actionRow}>
            <span
              className={`${s.actionKind} ${e.ok ? s.actionKind_noop : s.actionKind_delete}`}
            >
              {e.ok ? 'ok' : 'fail'}
            </span>
            <span className={s.actionId}>{e.label}</span>
            {e.detail && <span className={s.errText}>{e.detail}</span>}
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
