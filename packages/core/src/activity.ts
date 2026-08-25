import { and, desc, eq, inArray, like, lt, or } from 'drizzle-orm';
import type { Role } from './auth.js';
import type { Db } from './db.js';
import { newId } from './reserved.js';
import { activity, user } from './tables.js';

/**
 * One thing that happened, as its writer knows it. `at` and the id are this file's, so no
 * caller can date a row; everything else is the caller's, because only it knows what the
 * event was about.
 */
export interface ActivityEntry {
  /** Null is the system: a cron job, or a message that failed after the response had gone. */
  userId?: string | null;
  kind: string;
  /** An entry path, a media id or a user id — whichever this kind is about. */
  subject?: string | null;
  /** Small json. Never file contents, and never a one-time link: those are credentials. */
  detail?: unknown;
  commitSha?: string | null;
}

/** A row on its way to the screen, with the person it belongs to already looked up. */
export interface ActivityEvent {
  id: string;
  at: number;
  kind: string;
  subject: string | null;
  detail: unknown;
  commitSha: string | null;
  /**
   * Null is the system. A removed member keeps their events for the rest of the retention
   * window, so the id is there with nothing behind it — the log outlives the account.
   */
  user: { id: string; name: string | null; email: string | null } | null;
}

export interface ActivityQuery {
  group?: string;
  /** Only an owner is asked; an editor's own id is used whatever this says. */
  user?: string;
  entry?: string;
  cursor?: string;
}

/**
 * The kind groups the screen filters by. The kinds themselves are
 * `docs/features/activity-log.md`'s single list and this is a transcription of it, so a kind
 * that has no caller yet is here anyway — adding one is a string and needs no migration.
 */
export const ACTIVITY_GROUPS = {
  Accounts: ['login', 'invite', 'role-change', 'member-removed', 'password-set'],
  Publishing: [
    'publish',
    'publish-failed',
    'publish-conflict',
    'revert',
    'draft-discard',
    'hold-released',
    'lock-takeover',
  ],
  Entries: ['entry-rename', 'entry-delete', 'locale-off', 'entry-duplicate', 'template-saved'],
  Media: ['upload', 'media-archive', 'media-delete'],
  Settings: ['setting-changed'],
  System: ['mail-failed'],
} as const;
export type ActivityGroup = keyof typeof ACTIVITY_GROUPS;

// Every registered cron job writes its own `cron-<job>`, so System is the one group that is a
// prefix as well as a list.
const groupWhere = (group: ActivityGroup) =>
  group === 'System'
    ? or(inArray(activity.kind, [...ACTIVITY_GROUPS.System]), like(activity.kind, 'cron-%'))
    : inArray(activity.kind, [...ACTIVITY_GROUPS[group]]);

/**
 * One row. It never throws: nobody loses a sign-in, an invite or a commit because the line
 * recording it could not be written, and every caller here is on a path where the thing being
 * recorded has already happened.
 */
export async function logActivity(siteId: string, db: Db, event: ActivityEntry): Promise<void> {
  try {
    await db.insert(activity).values({
      id: newId(siteId),
      siteId,
      at: Date.now(),
      userId: event.userId ?? null,
      kind: event.kind,
      subject: event.subject ?? null,
      detail: event.detail ?? null,
      commitSha: event.commitSha ?? null,
    });
  } catch (err) {
    console.error(`activity: a ${event.kind} event was not logged`, err);
  }
}

/** The screen's page size. It is not a parameter: a caller-chosen limit is a self-inflicted scan. */
const PAGE = 50;

/**
 * `at` is not unique — two events in the same millisecond are ordinary — so the cursor is the
 * whole of what the order is on. An offset would re-read every row already served, and D1
 * bills rows scanned.
 */
const cursorOf = (raw: string | undefined) => {
  const [at, id] = (raw ?? '').split('.');
  const ms = Number(at);
  return id && at && Number.isSafeInteger(ms) ? { at: ms, id } : undefined;
};

/**
 * The last fifty events this person may see, newest first. **The filter is the whole of
 * "an editor sees only their own"**: their id comes off the session, and a `user` in the
 * query is read only for an owner — an editor naming somebody else is not refused, it is
 * not looked at, so there is nothing to probe.
 */
export async function activityPage(
  siteId: string,
  db: Db,
  viewer: { id: string; role: Role },
  query: ActivityQuery = {},
): Promise<{ events: ActivityEvent[]; cursor: string | null }> {
  const group = query.group as ActivityGroup | undefined;
  const after = cursorOf(query.cursor);
  const rows = await db
    .select({
      id: activity.id,
      at: activity.at,
      kind: activity.kind,
      subject: activity.subject,
      detail: activity.detail,
      commitSha: activity.commitSha,
      userId: activity.userId,
      name: user.name,
      email: user.email,
    })
    .from(activity)
    .leftJoin(user, eq(activity.userId, user.id))
    .where(
      and(
        eq(activity.siteId, siteId),
        viewer.role === 'owner'
          ? query.user
            ? eq(activity.userId, query.user)
            : undefined
          : eq(activity.userId, viewer.id),
        group && group in ACTIVITY_GROUPS ? groupWhere(group) : undefined,
        query.entry ? eq(activity.subject, query.entry) : undefined,
        after
          ? or(lt(activity.at, after.at), and(eq(activity.at, after.at), lt(activity.id, after.id)))
          : undefined,
      ),
    )
    .orderBy(desc(activity.at), desc(activity.id))
    // One more than the page, so "is there another" costs no second query.
    .limit(PAGE + 1);
  const page = rows.slice(0, PAGE);
  const last = page.at(-1);
  return {
    events: page.map((row) => ({
      id: row.id,
      at: row.at,
      kind: row.kind,
      subject: row.subject,
      detail: row.detail ?? null,
      commitSha: row.commitSha,
      user: row.userId ? { id: row.userId, name: row.name, email: row.email } : null,
    })),
    cursor: rows.length > PAGE && last ? `${last.at}.${last.id}` : null,
  };
}

/**
 * Which group's chip a row wears — the inverse of the table above, with the same `cron-` rule
 * `groupWhere` applies. Null for a kind nothing claims: a screen must be able to draw a row it
 * has never heard of rather than throw on it.
 */
export function activityGroupOf(kind: string): ActivityGroup | null {
  if (kind.startsWith('cron-')) return 'System';
  for (const [group, kinds] of Object.entries(ACTIVITY_GROUPS)) {
    if ((kinds as readonly string[]).includes(kind)) return group as ActivityGroup;
  }
  return null;
}
