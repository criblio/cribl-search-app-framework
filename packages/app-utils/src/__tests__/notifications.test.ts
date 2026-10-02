/**
 * Saved-search notifications go through the separate notifications
 * resource. Writing `schedule.notifications` in the saved-search body is
 * dropped by the server (it reads back `{}`), which is why one app's alert
 * trigger never fired.
 */
import { describe, expect, it } from 'vitest';
import {
  ensureNotificationTarget,
  ensureSavedSearchNotification,
  notificationsPath,
  removeNotificationsForSearch,
  removeSavedSearchNotification,
  savedSearchNotificationBody,
  savedSearchNotificationId,
} from '../notifications.js';
import type { HttpClient } from '../provisioner.js';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function fakeHttp(get: (path: string) => unknown): { http: HttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const http: HttpClient = {
    get: async (path) => {
      calls.push({ method: 'GET', path });
      const r = get(path);
      if (r instanceof Error) throw r;
      return r;
    },
    post: async (path, body) => (calls.push({ method: 'POST', path, body }), {}),
    patch: async (path, body) => (calls.push({ method: 'PATCH', path, body }), {}),
    del: async (path) => (calls.push({ method: 'DELETE', path }), {}),
  };
  return { http, calls };
}

const missing = { items: [], count: 0 };
const present = { items: [{ id: 'x' }], count: 1 };

describe('paths and ids', () => {
  it('follow the API and Cribl conventions', () => {
    expect(notificationsPath()).toBe('/m/default_search/notifications');
    expect(notificationsPath('a b', 'g')).toBe('/m/g/notifications/a%20b');
    expect(savedSearchNotificationId('app__alerts')).toBe('app__alerts_Notification_1');
  });
});

describe('savedSearchNotificationBody', () => {
  it('builds the shape the reference app runs in production', () => {
    expect(savedSearchNotificationBody({ searchId: 'app__alerts', targetId: 'hook', conf: { message: 'firing' } })).toEqual({
      id: 'app__alerts_Notification_1',
      group: 'default_search',
      disabled: false,
      condition: 'search',
      targets: ['hook'],
      conf: { triggerType: 'resultsCount', triggerComparator: '>', triggerCount: 0, message: 'firing', savedQueryId: 'app__alerts' },
      targetConfigs: [{ id: 'hook', conf: { includeResults: true, attachmentType: 'inline' } }],
    });
  });

  it('pins savedQueryId to the search even if conf tries to override it', () => {
    const body = savedSearchNotificationBody({ searchId: 's', targetId: 't', conf: { savedQueryId: 'other' } });
    expect((body.conf as { savedQueryId: string }).savedQueryId).toBe('s');
  });

  it('rejects ids the server would 400 and empty targets', () => {
    expect(() => savedSearchNotificationBody({ searchId: 'has space', targetId: 't' })).toThrow(/notificationId/);
    expect(() => savedSearchNotificationBody({ searchId: 's', targetId: [] })).toThrow(/target/);
  });
});

describe('ensureSavedSearchNotification', () => {
  it('POSTs to the notifications collection when absent — a 200 with no items is absent', async () => {
    const { http, calls } = fakeHttp(() => missing);
    expect(await ensureSavedSearchNotification(http, { searchId: 's', targetId: 't' })).toBe('created');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /m/default_search/notifications/s_Notification_1',
      'POST /m/default_search/notifications',
    ]);
  });

  it('PATCHes by id when present (idempotent re-run)', async () => {
    const { http, calls } = fakeHttp(() => present);
    expect(await ensureSavedSearchNotification(http, { searchId: 's', targetId: 't' })).toBe('updated');
    expect(calls[1]).toMatchObject({ method: 'PATCH', path: '/m/default_search/notifications/s_Notification_1' });
  });

  it('never writes through the saved-search body', async () => {
    const { http, calls } = fakeHttp(() => missing);
    await ensureSavedSearchNotification(http, { searchId: 's', targetId: 't' });
    expect(calls.some((c) => c.path.includes('/search/saved'))).toBe(false);
  });
});

describe('ensureNotificationTarget', () => {
  it('creates, then updates, outside any group', async () => {
    const absent = fakeHttp(() => missing);
    expect(await ensureNotificationTarget(absent.http, { id: 'hook', type: 'webhook', url: 'https://x' })).toBe('created');
    expect(absent.calls[1]).toMatchObject({ method: 'POST', path: '/notification-targets' });
    const there = fakeHttp(() => present);
    expect(await ensureNotificationTarget(there.http, { id: 'hook', type: 'webhook' })).toBe('updated');
    expect(there.calls[1]).toMatchObject({ method: 'PATCH', path: '/notification-targets/hook' });
  });
});

describe('removal', () => {
  it('removeSavedSearchNotification deletes a present binding and reports absent ones', async () => {
    const there = fakeHttp(() => present);
    expect(await removeSavedSearchNotification(there.http, { searchId: 's' })).toBe('deleted');
    expect(there.calls[1]).toMatchObject({ method: 'DELETE', path: '/m/default_search/notifications/s_Notification_1' });
    expect(await removeSavedSearchNotification(fakeHttp(() => missing).http, { searchId: 's' })).toBe('absent');
    expect(
      await removeSavedSearchNotification(fakeHttp(() => new Error('GET x failed (404): nf')).http, { searchId: 's' }),
    ).toBe('absent');
  });

  it('a failed read is never reported as "already gone"', async () => {
    const { http } = fakeHttp(() => new Error('GET x failed (403): forbidden'));
    await expect(removeSavedSearchNotification(http, { searchId: 's' })).rejects.toThrow('403');
  });

  it('removeNotificationsForSearch deletes only that search\'s bindings', async () => {
    const { http, calls } = fakeHttp(() => ({
      items: [
        { id: 's_Notification_1', conf: { savedQueryId: 's' } },
        { id: 'custom_id', conf: { savedQueryId: 's' } },
        { id: 's_Notification_2' },
        { id: 'ss_Notification_1', conf: { savedQueryId: 'ss' } },
        { id: 'other', conf: { savedQueryId: 'other' } },
      ],
    }));
    expect(await removeNotificationsForSearch(http, 's')).toEqual(['s_Notification_1', 'custom_id', 's_Notification_2']);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      '/m/default_search/notifications/s_Notification_1',
      '/m/default_search/notifications/custom_id',
      '/m/default_search/notifications/s_Notification_2',
    ]);
  });
});
