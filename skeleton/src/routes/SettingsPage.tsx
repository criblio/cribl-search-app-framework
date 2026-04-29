import { useCallback, useEffect, useState } from 'react';
import StatusBanner from '../components/StatusBanner';

interface AppSettings {
  dataset: string;
}

const DEFAULT_SETTINGS: AppSettings = { dataset: 'otel' };

function apiUrl(): string {
  return window.CRIBL_API_URL ?? '/api/v1';
}

function kvUrl(key: string): string {
  const appId = window.CRIBL_APP_ID ?? '';
  return `${apiUrl()}/kvstore/${appId}/${key}`;
}

async function loadSettings(): Promise<AppSettings> {
  try {
    const resp = await fetch(kvUrl('settings'));
    if (!resp.ok) return { ...DEFAULT_SETTINGS };
    const text = await resp.text();
    return JSON.parse(text) as AppSettings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings: AppSettings): Promise<void> {
  await fetch(kvUrl('settings'), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(settings),
  });
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  const handleSave = useCallback(async () => {
    try {
      await saveSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [settings]);

  return (
    <div style={{ maxWidth: 600 }}>
      <h1 style={{ marginBottom: 16 }}>Settings</h1>
      {error && <StatusBanner kind="error">{error}</StatusBanner>}
      {saved && <StatusBanner kind="info">Settings saved</StatusBanner>}

      <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
        Dataset
      </label>
      <input
        type="text"
        value={settings.dataset}
        onChange={(e) => setSettings({ ...settings, dataset: e.target.value })}
        style={{
          width: '100%',
          padding: '8px 12px',
          border: '1px solid var(--cds-color-border)',
          borderRadius: 'var(--cds-radius-md)',
          marginBottom: 16,
        }}
      />
      <p style={{ fontSize: 'var(--cds-font-size-sm)', color: 'var(--cds-color-fg-muted)', marginBottom: 16 }}>
        The Cribl Search dataset to query. Typically "otel" for OpenTelemetry data.
      </p>

      <button
        onClick={() => void handleSave()}
        style={{
          padding: '8px 20px',
          background: 'var(--cds-color-primary)',
          color: 'var(--cds-color-primary-fg)',
          border: 'none',
          borderRadius: 'var(--cds-radius-md)',
          fontWeight: 600,
        }}
      >
        Save
      </button>
    </div>
  );
}
