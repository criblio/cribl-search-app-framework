/**
 * First-run setup panel.
 *
 * Renders the flow `useSetup` drives, and is written around one idea: the
 * user must always be able to see WHICH of the five things is not done,
 * and whether the next move is theirs or an administrator's. A single
 * "Connect" button with a spinner cannot express "stored but not
 * activated", which is the state apps sit in longest.
 *
 * `onReady` fires with verified readiness so a parent can gate its main
 * feature on the same fact this panel renders, rather than re-deriving it
 * from a saved setting.
 */
import { useEffect, useState } from 'react';
import { Button } from '@capra/core';
import { useSetup, type SetupStep, type UseSetupOptions } from './useSetup.js';
import s from './SetupPanel.module.css';

// The hook ships from this React subpath, not from `./goattown` — see the
// note there about the module graph.
export {
  useSetup,
  type SetupStep,
  type SetupState,
  type UseSetupOptions,
  type UseSetupResult,
} from './useSetup.js';

export interface SetupPanelProps extends UseSetupOptions {
  title?: string;
  /** What the app does once set up, in one line. */
  description?: string;
  /**
   * Called whenever verified readiness changes.
   *
   * Gate the main feature on this. It is true only when an authenticated
   * call succeeded, the staged revision is active, AND the named agent is
   * in the catalog — never merely because a URL is saved.
   */
  onReady?: (ready: boolean) => void;
}

/** Progress rows. Each names a distinct thing that can be incomplete. */
function rowsFor(step: SetupStep, agentSlug: string) {
  const order: SetupStep[] = [
    'needs-url', 'needs-credential', 'needs-proposal', 'awaiting-activation', 'ready',
  ];
  const at = order.indexOf(step === 'loading' || step === 'error' ? 'needs-url' : step);
  const mark = (index: number) => (step === 'error' && index === at ? 'blocked' : at > index ? 'done' : at === index ? 'pending' : 'pending');
  return [
    { label: 'Service URL saved', state: mark(0) },
    { label: 'Credential accepted by the service', state: mark(1) },
    { label: 'App configuration staged', state: mark(2) },
    { label: `Activated by an administrator, with agent "${agentSlug}" available`, state: mark(3) },
  ];
}

export function SetupPanel({
  title = 'Set up the agent service',
  description,
  onReady,
  ...options
}: SetupPanelProps) {
  const setup = useSetup(options);
  const [token, setToken] = useState('');

  useEffect(() => {
    onReady?.(setup.ready);
  }, [onReady, setup.ready]);

  const rows = rowsFor(setup.step, options.agentSlug);

  return (
    <div className={s.panel}>
      <div className={s.title}>{title}</div>
      {description && <div className={s.lede}>{description}</div>}

      <ul className={s.steps}>
        {rows.map((row) => (
          <li key={row.label} className={s.stepRow}>
            <span className={`${s.mark} ${s[row.state]}`}>
              {row.state === 'done' ? '✓' : row.state === 'blocked' ? '✕' : '·'}
            </span>
            <span>{row.label}</span>
          </li>
        ))}
      </ul>

      {setup.error && <div className={s.error}>{setup.error}</div>}

      {setup.step !== 'ready' && (
        <>
          <div className={s.field}>
            <input
              className={s.input}
              type="url"
              inputMode="url"
              placeholder="https://goattown.example.com"
              value={setup.serviceUrl}
              onChange={(e) => setup.setServiceUrl(e.target.value)}
              aria-label="GoatTown service URL"
            />
            <Button variant="secondary" size="sm" disabled={setup.busy} onClick={() => void setup.saveServiceUrl()}>
              Save URL
            </Button>
          </div>

          {setup.step === 'needs-credential' && (
            <>
              <div className={s.field}>
                <input
                  className={s.input}
                  type="password"
                  autoComplete="off"
                  placeholder="App token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  aria-label="App token"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={setup.busy || !token.trim()}
                  onClick={() => void setup.saveToken(token).then(() => setToken(''))}
                >
                  Save token
                </Button>
              </div>
              <div className={s.hint}>
                The token is written to this app&apos;s key-value store and injected server-side by
                the platform proxy. It is never read back into the page and never sent from your
                browser. If your administrator delivers credentials through Connected apps instead,
                leave this blank and press Re-check once they have.
              </div>
            </>
          )}
        </>
      )}

      {setup.scope && (
        <div className={s.meta}>
          producer {setup.scope.producer} (assigned by credential)
          {setup.status?.activeRevisionId && ` · active revision ${setup.status.activeRevisionId}`}
        </div>
      )}

      <div className={s.actions}>
        {(setup.step === 'needs-proposal' || setup.step === 'awaiting-activation') && (
          <Button variant="primary" size="sm" disabled={setup.busy} onClick={() => void setup.stage()}>
            {setup.status?.stagedRevisionId ? 'Re-stage configuration' : 'Stage configuration'}
          </Button>
        )}
        {(setup.step === 'awaiting-activation' || setup.step === 'ready') && (
          <Button variant="secondary" size="sm" onClick={setup.review}>
            Open review page
          </Button>
        )}
        {/* Always available. The user's state changes when someone else
            acts, so they need a way to ask again without reloading. */}
        <Button variant="secondary" size="sm" disabled={setup.busy} onClick={() => void setup.recheck()}>
          {setup.busy ? 'Checking…' : 'Re-check'}
        </Button>
      </div>
    </div>
  );
}

export default SetupPanel;
