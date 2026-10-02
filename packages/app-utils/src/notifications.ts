/**
 * Saved-search notifications: the target a scheduled search fires at, and
 * the binding that makes it fire.
 *
 * A saved search's notifications are a SEPARATE resource under
 * `/m/<group>/notifications`, joined into the search's
 * `schedule.notifications` only on read. Writing `schedule.notifications`
 * in the saved-search body is silently ignored — the server keeps `{}` —
 * which is why one app's alert trigger never fired. Bind through this
 * module (or `ProvisionerConfig.notifications`) instead.
 *
 * Endpoints, as used in production by the reference app:
 *
 *   GET/POST        /notification-targets            (no group context)
 *   GET/PATCH       /notification-targets/:id
 *   GET/POST        /m/<group>/notifications
 *   GET/PATCH/DEL   /m/<group>/notifications/:id
 *
 * A by-id GET for a missing record answers `200 {items:[],count:0}`, not
 * a 404, so "the GET didn't throw" is not "it exists".
 */
import type { HttpClient } from './provisioner.js';

/** Search group hosted Cribl Cloud uses. */
export const DEFAULT_NOTIFICATION_GROUP = 'default_search';

/** The server's pattern for a notification id; anything else is a 400. */
const NOTIFICATION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** `/m/<group>/notifications[/<id>]`. */
export function notificationsPath(id?: string, group: string = DEFAULT_NOTIFICATION_GROUP): string {
  const base = `/m/${group}/notifications`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

/** `/notification-targets[/<id>]` — targets live outside any group. */
export function notificationTargetsPath(id?: string): string {
  return id ? `/notification-targets/${encodeURIComponent(id)}` : '/notification-targets';
}

/** Cribl's own id convention for a saved search's n-th notification —
 * the Search UI names them the same way. */
export function savedSearchNotificationId(searchId: string, n = 1): string {
  return `${searchId}_Notification_${n}`;
}

/** A notification target body. `id` and `type` are required by the API;
 * the rest is type-specific (webhook `url`, `method`, `authType`, …). */
export interface NotificationTarget {
  id: string;
  type: string;
  [field: string]: unknown;
}

/** The trigger half of a saved-search notification. */
export interface SavedSearchNotificationConf {
  /** Default `'resultsCount'`. */
  triggerType?: string;
  /** Default `'>'`. */
  triggerComparator?: string;
  /** Default `0` — fire whenever the search returns any row. */
  triggerCount?: number;
  /** Message the target receives. */
  message?: string;
  [field: string]: unknown;
}

/** A binding from one saved search to one or more targets. */
export interface SavedSearchNotification {
  searchId: string;
  targetId: string | string[];
  conf?: SavedSearchNotificationConf;
  /** Per-target conf. Default `{ includeResults: true, attachmentType: 'inline' }`
   * — a webhook that should receive the rows needs `includeResults`. */
  targetConf?: Record<string, unknown>;
  /** Default `savedSearchNotificationId(searchId)`. */
  notificationId?: string;
  /** Default `'default_search'`. */
  group?: string;
  /** Default `false`. */
  disabled?: boolean;
}

function existsFromGet(resp: unknown): boolean {
  const r = resp as { count?: number; items?: unknown[] } | null;
  return (r?.count ?? r?.items?.length ?? 0) > 0;
}

/** For the ensure paths: an unreadable record is treated as absent, as
 * the reference app does — the create that follows fails legibly if the
 * record does exist. The remove path reads with `http.get` directly so a
 * failed read is never reported as "already gone". */
async function existsOrAbsent(http: HttpClient, path: string): Promise<boolean> {
  try {
    return existsFromGet(await http.get(path));
  } catch {
    return false;
  }
}

/** Create or update a notification target. Idempotent. */
export async function ensureNotificationTarget(
  http: HttpClient,
  target: NotificationTarget,
): Promise<'created' | 'updated'> {
  if (!target.id || !target.type) throw new Error('notification target needs an id and a type');
  const path = notificationTargetsPath(target.id);
  if (await existsOrAbsent(http, path)) {
    await http.patch(path, target);
    return 'updated';
  }
  await http.post(notificationTargetsPath(), target);
  return 'created';
}

/** The request body for a binding. Exported for tests and dry runs. */
export function savedSearchNotificationBody(binding: SavedSearchNotification): Record<string, unknown> {
  const group = binding.group ?? DEFAULT_NOTIFICATION_GROUP;
  const id = binding.notificationId ?? savedSearchNotificationId(binding.searchId);
  if (!NOTIFICATION_ID_PATTERN.test(id)) {
    throw new Error(
      `notification id ${JSON.stringify(id)} must match ${NOTIFICATION_ID_PATTERN.source}; pass notificationId explicitly`,
    );
  }
  const targets = Array.isArray(binding.targetId) ? binding.targetId : [binding.targetId];
  if (targets.length === 0 || targets.some((t) => !t)) {
    throw new Error(`notification ${id} needs at least one non-empty target id`);
  }
  const targetConf = binding.targetConf ?? { includeResults: true, attachmentType: 'inline' };
  return {
    id,
    group,
    disabled: binding.disabled ?? false,
    condition: 'search',
    targets,
    conf: {
      triggerType: 'resultsCount',
      triggerComparator: '>',
      triggerCount: 0,
      ...binding.conf,
      // Forced last: the binding IS this search's notification.
      savedQueryId: binding.searchId,
    },
    targetConfigs: targets.map((t) => ({ id: t, conf: targetConf })),
  };
}

/**
 * Bind a saved search to its target(s). Run AFTER both the target and the
 * search exist. Idempotent: PATCH when the record exists, POST otherwise.
 *
 * ```ts
 * await ensureSavedSearchNotification(http, {
 *   searchId: 'myapp__alerts', targetId: 'myapp_webhook',
 *   conf: { message: 'myapp: alert(s) firing' },
 * });
 * ```
 */
export async function ensureSavedSearchNotification(
  http: HttpClient,
  binding: SavedSearchNotification,
): Promise<'created' | 'updated'> {
  const body = savedSearchNotificationBody(binding);
  const group = body.group as string;
  const path = notificationsPath(body.id as string, group);
  if (await existsOrAbsent(http, path)) {
    await http.patch(path, body);
    return 'updated';
  }
  await http.post(notificationsPath(undefined, group), body);
  return 'created';
}

/** Remove one binding by id. Absent is not an error; any other failure
 * propagates, so a binding that could not be deleted is never reported
 * as gone. */
export async function removeSavedSearchNotification(
  http: HttpClient,
  { searchId, notificationId, group }: { searchId: string; notificationId?: string; group?: string },
): Promise<'deleted' | 'absent'> {
  const path = notificationsPath(notificationId ?? savedSearchNotificationId(searchId), group);
  let resp: unknown;
  try {
    resp = await http.get(path);
  } catch (err) {
    // Both framework HTTP clients put the status in the message.
    if (/\(404\)/.test(err instanceof Error ? err.message : String(err))) return 'absent';
    throw err;
  }
  if (!existsFromGet(resp)) return 'absent';
  await http.del(path);
  return 'deleted';
}

interface NotificationRow {
  id?: string;
  conf?: { savedQueryId?: string };
}

/**
 * Remove every notification bound to `searchId` — the orphan path for a
 * saved search the provisioner deletes. Matches on `conf.savedQueryId`
 * (what a binding stores) or the `<searchId>_Notification_<n>` id
 * convention. Returns the deleted ids.
 */
export async function removeNotificationsForSearch(
  http: HttpClient,
  searchId: string,
  group: string = DEFAULT_NOTIFICATION_GROUP,
): Promise<string[]> {
  const idPrefix = `${searchId}_Notification_`;
  const matches: string[] = [];
  const pageSize = 200;
  for (let page = 0, offset = 0; page < 50; page++) {
    const resp = (await http.get(`${notificationsPath(undefined, group)}?limit=${pageSize}&offset=${offset}`)) as
      | { items?: NotificationRow[] }
      | null;
    const items = resp?.items ?? [];
    for (const row of items) {
      if (typeof row?.id !== 'string') continue;
      if (row.conf?.savedQueryId === searchId || row.id.startsWith(idPrefix)) matches.push(row.id);
    }
    if (items.length < pageSize) break;
    offset += items.length;
  }
  for (const id of matches) await http.del(notificationsPath(id, group));
  return matches;
}
