import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import CadencePicker from '@criblio/app-utils/cadence-picker';
import { CADENCE_OPTIONS } from '@criblio/app-utils/cadence';
import { validateProvisionerPlan } from '@criblio/app-utils/provisioner';
import { DEFAULT_SETTINGS, cadence } from '../settings';
import { PREFIX, provisionerConfig } from '../provisioning/plan';
import { PATHS } from '../routes/paths';

describe('skeleton contract', () => {
  it('defaults name a dataset and a known cadence', () => {
    expect(DEFAULT_SETTINGS.dataset).not.toBe('');
    expect(CADENCE_OPTIONS.map((o) => o.value)).toContain(DEFAULT_SETTINGS.searchCadence);
    expect(cadence('bogus')).toBe(DEFAULT_SETTINGS.searchCadence);
  });

  it('the real plan passes the provisioner guard', () => {
    const config = provisionerConfig(DEFAULT_SETTINGS);
    expect(config.prefix).toBe(PREFIX);
    expect(PREFIX).toMatch(/^[a-z0-9_]+__$/);
    expect(validateProvisionerPlan(config).problems).toEqual([]);
  });

  it('no route contains "settings" (the host shell intercepts it)', () => {
    for (const path of Object.values(PATHS)) expect(path).not.toMatch(/settings/i);
  });

  // Exercises vitest.config.ts: this component imports a .css module, which
  // only loads because app-utils is inlined.
  it('renders an app-utils component that imports CSS', () => {
    const html = renderToString(createElement(CadencePicker, { value: '5m', onChange: () => {} }));
    expect(html).toContain('Search cadence');
  });
});
