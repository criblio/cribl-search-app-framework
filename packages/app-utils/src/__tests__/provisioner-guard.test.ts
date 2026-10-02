/**
 * The guard is wired into every apply path, by default.
 *
 * The reference app ran its plan guard from its CLI only; its Settings
 * page "Apply" went straight to the API, so the same corrupt plan the CLI
 * refused could be pushed with one click. These tests pin that no apply
 * path — reconcile, planOnly, applyProvisioningActions (the panel's path),
 * or the low-level applyProvisioningPlan — writes a failing plan unless
 * the app explicitly opts out.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import {
  applyProvisioningActions,
  applyProvisioningPlan,
  diffProvisioned,
  planOnly,
  reconcile,
  validateProvisionerPlan,
  type HttpClient,
  type ProvisionedSearch,
  type ProvisionerConfig,
} from '../provisioner.js';
import { ProvisionPlanError } from '../provision-guard.js';
import { InvalidPlanView } from '../ProvisioningPanel.js';

function search(id: string, query = 'dataset="otel" | limit 1'): ProvisionedSearch {
  return {
    id,
    name: 'A name',
    description: '',
    query,
    earliest: '-1h',
    latest: 'now',
    schedule: { enabled: true, cronSchedule: '*/5 * * * *', tz: 'UTC', keepLastN: 2 },
  };
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Records every call; the saved-search list and notification reads are scripted. */
function fakeHttp(opts: {
  saved?: { id: string }[];
  notifications?: { id: string; conf?: { savedQueryId?: string } }[];
  failPost?: RegExp;
} = {}): { http: HttpClient; calls: Call[]; writes: () => Call[] } {
  const calls: Call[] = [];
  const http: HttpClient = {
    get: async (path) => {
      calls.push({ method: 'GET', path });
      if (path.startsWith('/m/default_search/search/saved')) return { items: opts.saved ?? [] };
      if (path.startsWith('/m/default_search/notifications?')) return { items: opts.notifications ?? [] };
      return { items: [], count: 0 };
    },
    post: async (path, body) => {
      calls.push({ method: 'POST', path, body });
      if (opts.failPost?.test(JSON.stringify(body))) throw new Error('POST failed (400): nope');
      return {};
    },
    patch: async (path, body) => {
      calls.push({ method: 'PATCH', path, body });
      return {};
    },
    del: async (path) => {
      calls.push({ method: 'DELETE', path });
      return {};
    },
  };
  return { http, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

const bad: ProvisionerConfig = { prefix: 'app__', plan: [search('app__ok'), search('app__bad', 'dataset="" | limit 1')] };

describe('the default guard', () => {
  it('reconcile refuses a failing plan and writes nothing', async () => {
    const { http, writes } = fakeHttp();
    await expect(reconcile(http, bad)).rejects.toBeInstanceOf(ProvisionPlanError);
    expect(writes()).toEqual([]);
  });

  it('planOnly refuses too, with the problems attached', async () => {
    const { http } = fakeHttp();
    const err = await planOnly(http, bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisionPlanError);
    expect((err as ProvisionPlanError).problems).toEqual([
      expect.objectContaining({ searchId: 'app__bad', rule: 'dataset-empty' }),
    ]);
  });

  it('applyProvisioningActions (the panel Apply path) re-validates the previewed actions', async () => {
    const { http, writes } = fakeHttp();
    const actions = diffProvisioned(bad.plan as ProvisionedSearch[], []);
    await expect(applyProvisioningActions(http, bad, actions)).rejects.toBeInstanceOf(ProvisionPlanError);
    expect(writes()).toEqual([]);
  });

  it('the low-level applyProvisioningPlan guards by default', async () => {
    const { http, writes } = fakeHttp();
    const actions = diffProvisioned(bad.plan as ProvisionedSearch[], []);
    await expect(applyProvisioningPlan(http, actions)).rejects.toBeInstanceOf(ProvisionPlanError);
    expect(writes()).toEqual([]);
  });

  it('refuses a bad seed lookup before seeding anything', async () => {
    const { http, calls } = fakeHttp();
    const config: ProvisionerConfig = {
      prefix: 'app__',
      plan: [search('app__ok')],
      seedLookups: [{ name: 'l', seedQuery: 'dataset="otel" | export mode=overwrite to lookup l' }],
    };
    await expect(reconcile(http, config)).rejects.toBeInstanceOf(ProvisionPlanError);
    expect(calls).toEqual([]);
  });

  it('applies a healthy plan', async () => {
    const { http, writes } = fakeHttp();
    const { results } = await reconcile(http, { prefix: 'app__', plan: [search('app__ok')] });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual(['POST /m/default_search/search/saved']);
  });
});

describe('opting out and extending', () => {
  it('guard: false applies the plan as-is', async () => {
    const { http, writes } = fakeHttp();
    await reconcile(http, { ...bad, guard: false });
    expect(writes()).toHaveLength(2);
  });

  it('guard.disableRules skips one rule and keeps the rest', () => {
    const v = validateProvisionerPlan({
      prefix: 'app__',
      plan: [search('app__x', 'dataset="otel" | export to lookup l'), search('oops')],
      guard: { disableRules: ['overwrite-without-sentinel'] },
    });
    expect(v.problems.map((p) => p.rule)).toEqual(['id-prefix']);
  });

  it('validate adds app rules on top of the built-in guard, never instead of it', async () => {
    const config: ProvisionerConfig = {
      ...bad,
      validate: (plan) =>
        plan.filter((s) => s.schedule.keepLastN < 3).map((s) => ({
          searchId: s.id,
          rule: 'keep-last-n',
          message: 'app rule: keepLastN must be >= 3',
        })),
    };
    const v = validateProvisionerPlan(config);
    expect(v.problems.map((p) => p.message)).toEqual([
      expect.stringContaining('dataset=""'),
      'app rule: keepLastN must be >= 3',
      'app rule: keepLastN must be >= 3',
    ]);
    const { http, writes } = fakeHttp();
    await expect(reconcile(http, config)).rejects.toBeInstanceOf(ProvisionPlanError);
    expect(writes()).toEqual([]);
  });

  it('validate may return a ProvisionValidation', () => {
    const v = validateProvisionerPlan({
      prefix: 'app__',
      plan: [search('app__ok')],
      validate: () => ({ ok: false, problems: [{ searchId: 'x', rule: 'duplicate-id', message: 'm' }] }),
    });
    expect(v.ok).toBe(false);
  });
});

describe('app rule names', () => {
  // An app rule used to have to borrow a built-in name ('invalid-name'),
  // which mislabelled it in the panel and the error. Its own name must
  // survive validateProvisionerPlan, ProvisionPlanError and InvalidPlanView.
  const config: ProvisionerConfig = {
    prefix: 'app__',
    plan: [search('app__ok')],
    guard: { disableRules: ['invalid-name'] },
    validate: (plan) => plan.map((s) => ({ searchId: s.id, rule: 'keep-last-n', message: 'keepLastN must be >= 3' })),
  };

  it('round-trips into ProvisionPlanError.problems and its message', async () => {
    const { http, writes } = fakeHttp();
    const err = await reconcile(http, config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisionPlanError);
    expect((err as ProvisionPlanError).problems).toEqual([
      { searchId: 'app__ok', rule: 'keep-last-n', message: 'keepLastN must be >= 3' },
    ]);
    expect((err as ProvisionPlanError).message).toContain('app__ok [keep-last-n]');
    expect(writes()).toEqual([]);
  });

  it('is not dropped by disabling a built-in rule', () => {
    expect(validateProvisionerPlan(config).problems.map((p) => p.rule)).toEqual(['keep-last-n']);
  });

  it('keeps disableRules typed to the built-in rules', () => {
    // @ts-expect-error — disableRules names built-ins only; an app rule is off in its own validate
    const guard: ProvisionerConfig['guard'] = { disableRules: ['keep-last-n'] };
    expect(guard).toBeTruthy();
  });

  it('renders in InvalidPlanView', () => {
    const html = renderToString(
      createElement(InvalidPlanView, {
        problems: validateProvisionerPlan(config).problems,
        onDismiss: () => undefined,
      }),
    );
    expect(html).toContain('keep-last-n');
    expect(html).toContain('app__ok');
  });
});

describe('notification bindings on the apply path', () => {
  it('binds after the search is written, through the notifications resource', async () => {
    const { http, writes } = fakeHttp();
    const { notifications } = await reconcile(http, {
      prefix: 'app__',
      plan: [search('app__alerts')],
      notifications: [{ searchId: 'app__alerts', targetId: 'hook' }],
    });
    expect(notifications).toEqual([{ searchId: 'app__alerts', step: 'ensure', ok: true, detail: 'created' }]);
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /m/default_search/search/saved',
      'POST /m/default_search/notifications',
    ]);
  });

  it('skips the binding when its search failed to write', async () => {
    const { http, writes } = fakeHttp({ failPost: /app__alerts/ });
    const { notifications } = await reconcile(http, {
      prefix: 'app__',
      plan: [search('app__alerts')],
      notifications: [{ searchId: 'app__alerts', targetId: 'hook' }],
    });
    expect(notifications[0]).toMatchObject({ ok: false, error: expect.stringContaining('failed to write') });
    expect(writes().filter((c) => c.path.includes('notifications'))).toEqual([]);
  });

  it('reports a binding for a search not in the plan', async () => {
    const { http } = fakeHttp();
    const { notifications } = await reconcile(http, {
      prefix: 'app__',
      plan: [search('app__a')],
      notifications: [{ searchId: 'app__gone', targetId: 'hook' }],
    });
    expect(notifications[0]).toMatchObject({ ok: false, error: expect.stringContaining('in the plan') });
  });

  it('unbinds a deleted search BEFORE deleting it', async () => {
    const { http, writes } = fakeHttp({
      saved: [{ id: 'app__old' }],
      notifications: [
        { id: 'app__old_Notification_1', conf: { savedQueryId: 'app__old' } },
        { id: 'unrelated', conf: { savedQueryId: 'someone_else' } },
      ],
    });
    const { notifications } = await reconcile(http, { prefix: 'app__', plan: [], notifications: [] });
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      'DELETE /m/default_search/notifications/app__old_Notification_1',
      'DELETE /m/default_search/search/saved/app__old',
    ]);
    expect(notifications).toEqual([
      { searchId: 'app__old', step: 'remove', ok: true, detail: 'app__old_Notification_1' },
    ]);
  });

  it('touches no notification endpoint when the app declares none', async () => {
    const { http, calls } = fakeHttp({ saved: [{ id: 'app__old' }] });
    await reconcile(http, { prefix: 'app__', plan: [] });
    expect(calls.some((c) => c.path.includes('notifications'))).toBe(false);
  });
});

describe('InvalidPlanView', () => {
  it('lists every problem and offers no Apply', () => {
    const html = renderToString(
      createElement(InvalidPlanView, {
        problems: [{ searchId: 'app__bad', rule: 'dataset-empty', message: 'empty dataset clause' }],
        onDismiss: () => undefined,
      }),
    );
    expect(html).toContain('app__bad');
    expect(html).toContain('dataset-empty');
    expect(html).not.toMatch(/>Apply</);
  });
});
