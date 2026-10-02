/**
 * `diffProvisioned` and inline notifications.
 *
 * The server drops `schedule.notifications` on a saved search and reads it
 * back as `{}`. The diff required the plan's notifications to be a subset
 * of what the server returned, which `{}` never is — so a plan that set
 * them reported drift on every run and re-patched the search forever.
 */
import { describe, expect, it } from 'vitest';
import { diffProvisioned, type ProvisionedSearch, type SavedSearchRow } from '../provisioner.js';

const want: ProvisionedSearch = {
  id: 'app__errors',
  name: 'Errors',
  description: 'error rollup',
  query: 'dataset="otel" | summarize count() by service',
  earliest: '-5m',
  latest: 'now',
  schedule: {
    enabled: true,
    cronSchedule: '*/5 * * * *',
    tz: 'UTC',
    keepLastN: 2,
    notifications: {
      items: [{ condition: 'results > 0', targets: ['webhook'], conf: {}, targetConfigs: [], group: 'g' }],
    },
  },
};

/** The row as the server actually returns it after a create with `want`. */
function serverRow(overrides: Partial<SavedSearchRow['schedule'] & object> = {}): SavedSearchRow {
  return {
    id: want.id,
    name: want.name,
    description: want.description,
    query: want.query,
    earliest: want.earliest,
    latest: want.latest,
    sampleRate: 1,
    schedule: {
      enabled: true, cronSchedule: '*/5 * * * *', tz: 'UTC', keepLastN: 2,
      notifications: {},
      ...overrides,
    },
  };
}

describe('diffProvisioned with inline notifications', () => {
  it('a server that stored {} is not drift', () => {
    const [action] = diffProvisioned([want], [serverRow()]);
    expect(action?.kind).toBe('noop');
  });

  it('a server that omits notifications entirely is not drift either', () => {
    const row = serverRow();
    delete (row.schedule as Record<string, unknown>).notifications;
    expect(diffProvisioned([want], [row])[0]?.kind).toBe('noop');
  });

  it('still reports real schedule drift', () => {
    const [action] = diffProvisioned([want], [serverRow({ cronSchedule: '* * * * *' })]);
    expect(action?.kind).toBe('update');
  });
});
