import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Alert, Button, SelectField } from '@capra/core';
import CadencePicker from '@criblio/app-utils/cadence-picker';
import ProvisioningPanel from '@criblio/app-utils/provisioning-panel';
import { setSearchCadence } from '@criblio/app-utils/cadence';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import { listSearchDatasets } from '@criblio/app-utils/metrics';
import { createBrowserHttpClient, planOnly } from '@criblio/app-utils/provisioner';
import { DEFAULT_SETTINGS, loadAppSettings, saveAppSettings, type Settings } from '../settings';
import { provisionerConfig } from '../provisioning/plan';
import s from './ConfigurationPage.module.css';

type Load<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; value: T };
type Check = { kind: 'checking' } | { kind: 'ready'; detail: string } | { kind: 'action'; detail: string; jump: string } | { kind: 'failed'; message: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** In-page jump: under React Router a bare `#id` href would route to `/#id`. */
function jumpTo(e: MouseEvent<HTMLAnchorElement>, id: string) {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
}

function StatusRow({ label, check }: { label: string; check: Check }) {
  const [mark, text] =
    check.kind === 'checking' ? ['…', 'Checking…']
    : check.kind === 'ready' ? ['✓', check.detail]
    : check.kind === 'action' ? ['!', check.detail]
    : ['?', `Could not check: ${check.message}`];
  return (
    <li className={s.statusRow} data-state={check.kind}>
      <span className={s.mark} aria-hidden>{mark}</span>
      <strong>{label}</strong>
      <span>{text}</span>
      {check.kind === 'action' && (
        <a href={`#${check.jump}`} onClick={(e) => jumpTo(e, check.jump)}>Jump to {check.jump}</a>
      )}
    </li>
  );
}

/**
 * Setup status → workspace settings → provisioning. Save stays disabled
 * unless settings loaded: saving defaults over a failed read wipes what is
 * stored, and DatasetProvider swallows KV errors, so this page is where a
 * broken store has to show.
 */
export default function ConfigurationPage() {
  const [saved, setSaved] = useState<Load<Settings>>({ kind: 'loading' });
  const [draft, setDraft] = useState<Settings | null>(null);
  const [datasets, setDatasets] = useState<Load<string[]>>({ kind: 'loading' });
  const [searches, setSearches] = useState<Check>({ kind: 'checking' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    loadAppSettings().then(
      (value) => { setSaved({ kind: 'ready', value }); setDraft(value); },
      (e) => setSaved({ kind: 'error', message: message(e) }), // never fall back to defaults
    );
    const ctl = new AbortController();
    listSearchDatasets(ctl.signal).then(
      (items) => setDatasets({ kind: 'ready', value: items.map((d) => d.id).sort() }),
      (e) => { if (!ctl.signal.aborted) setDatasets({ kind: 'error', message: message(e) }); },
    );
    return () => ctl.abort();
  }, []);

  const settings = saved.kind === 'ready' ? saved.value : null;
  const config = useMemo(() => (settings ? provisionerConfig(settings) : null), [settings]);

  useEffect(() => {
    if (!config) return;
    let current = true;
    setSearches({ kind: 'checking' });
    planOnly(createBrowserHttpClient(), config).then(
      ({ plan, actions }) => {
        if (!current) return;
        const pending = actions.filter((a) => a.kind === 'create' || a.kind === 'update').length;
        setSearches(
          plan.length === 0 ? { kind: 'ready', detail: 'None declared yet (src/provisioning/plan.ts)' }
          : pending === 0 ? { kind: 'ready', detail: `${plan.length} installed and current` }
          : { kind: 'action', detail: `${pending} of ${plan.length} need install or update`, jump: 'provisioning' },
        );
      },
      (e) => { if (current) setSearches({ kind: 'failed', message: message(e) }); },
    );
    return () => { current = false; };
  }, [config]);

  const settingsCheck: Check =
    saved.kind === 'loading' ? { kind: 'checking' }
    : saved.kind === 'error' ? { kind: 'failed', message: saved.message }
    : { kind: 'ready', detail: 'Loaded from the app KV store' };
  const datasetCheck: Check =
    saved.kind === 'error' ? { kind: 'failed', message: 'settings did not load' }
    : !settings || datasets.kind === 'loading' ? { kind: 'checking' }
    : datasets.kind === 'error' ? { kind: 'failed', message: datasets.message }
    : datasets.value.includes(settings.dataset) ? { kind: 'ready', detail: `Reading ${settings.dataset}` }
    : { kind: 'action', detail: `Dataset ${settings.dataset} does not exist in this workspace`, jump: 'workspace' };

  // The saved dataset stays selectable even when the list failed or omits it.
  const datasetIds = useMemo(() => {
    const ids = datasets.kind === 'ready' ? datasets.value : [];
    return draft && !ids.includes(draft.dataset) ? [draft.dataset, ...ids] : ids;
  }, [datasets, draft]);

  async function save() {
    if (!draft || !settings) return;
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    const r = await saveAppSettings(draft);
    setSaving(false);
    if (!r.ok) { setSaveError(r.error.message); return; }
    setCurrentDataset(draft.dataset);
    setSearchCadence(draft.searchCadence);
    const baked = draft.dataset !== settings.dataset || draft.searchCadence !== settings.searchCadence;
    setSaved({ kind: 'ready', value: draft });
    setNotice(baked
      ? 'Saved. Scheduled searches bake in the dataset and cadence: preview and Apply under Provisioning.'
      : 'Saved.');
  }

  return (
    <div className={s.page}>
      <h1>Configuration</h1>

      <section className={s.card} aria-labelledby="setup-status">
        <h2 id="setup-status">Setup status</h2>
        <ul className={s.statusList}>
          <StatusRow label="Settings" check={settingsCheck} />
          <StatusRow label="Dataset" check={datasetCheck} />
          <StatusRow label="Scheduled searches" check={searches} />
        </ul>
      </section>

      <section className={s.card} id="workspace" aria-labelledby="workspace-title">
        <h2 id="workspace-title">Workspace</h2>
        {saved.kind === 'error' && (
          <Alert appearance="danger" title="Settings could not be loaded">
            {saved.message}. Saving is disabled so the stored settings are not overwritten with defaults.
          </Alert>
        )}
        {datasets.kind === 'error' && (
          <Alert appearance="warning" title="Datasets could not be listed">{datasets.message}</Alert>
        )}
        <SelectField
          label="Dataset"
          helperText="The Cribl Search dataset every page and scheduled search reads."
          items={datasetIds.map((id) => ({ id, label: id }))}
          value={draft?.dataset ?? null}
          onChange={(key) => { if (draft && key != null) setDraft({ ...draft, dataset: String(key) }); }}
          disabled={!draft}
          canSearch
        />
        <CadencePicker
          value={draft?.searchCadence ?? DEFAULT_SETTINGS.searchCadence}
          onChange={(searchCadence) => draft && setDraft({ ...draft, searchCadence })}
          disabled={!draft}
        />
        {saveError && <Alert appearance="danger" title="Save failed">{saveError}</Alert>}
        {notice && <Alert appearance="success">{notice}</Alert>}
        <div>
          <Button variant="primary" onClick={() => void save()} disabled={!draft || saving} pending={saving}>
            Save
          </Button>
        </div>
      </section>

      <section className={s.card} id="provisioning" aria-labelledby="provisioning-title">
        <h2 id="provisioning-title">Provisioning</h2>
        {/* Only after settings load: a plan built from defaults would overwrite the real configuration. */}
        {config ? <ProvisioningPanel config={config} /> : <p>Available once settings load.</p>}
      </section>
    </div>
  );
}
