import { and, desc, eq, inArray, isNotNull, like, lt, or } from 'drizzle-orm';
import type { Role } from './auth.js';
import { chunksOf, D1_MAX_BOUND_PARAMETERS } from './d1-limits.js';
import type { Db } from './db.js';
import { entryKey } from './entries.js';
import { newId } from './reserved.js';
import { activity, operations, user } from './tables.js';

/** `at` and the id are this file's, so no caller can date a row. */
export interface ActivityEntry {
  /** Null is the system: a cron job, or a message that failed after the response had gone. */
  userId?: string | null;
  kind: string;
  /** An entry path, a media id or a user id — whichever this kind is about. */
  subject?: string | null;
  /** Small JSON with no file contents or credentials. */
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
  /** Null is the system; a removed member's id stays with nothing behind it. */
  user: { id: string; name: string | null; email: string | null } | null;
}

export interface ActivityQuery {
  group?: string;
  /** Only an owner is asked; an editor's own id is used whatever this says. */
  user?: string;
  entry?: string;
  cursor?: string;
}

/** Transcribed from `docs/features/activity-log.md`, so a kind with no caller yet is here too. */
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
  Site: ['redirect-added', 'redirect-changed', 'redirect-deleted'],
  Settings: ['setting-changed'],
  System: ['mail-failed'],
} as const;
export type ActivityGroup = keyof typeof ACTIVITY_GROUPS;

// Every cron job writes its own `cron-<job>`, so System is a prefix as well as a list.
const groupWhere = (group: ActivityGroup) =>
  group === 'System'
    ? or(inArray(activity.kind, [...ACTIVITY_GROUPS.System]), like(activity.kind, 'cron-%'))
    : inArray(activity.kind, [...ACTIVITY_GROUPS[group]]);

/** Never throws: nobody loses a sign-in or a commit because the line recording it failed. */
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

/** Not a parameter: a caller-chosen limit is a self-inflicted scan. */
const PAGE = 50;

/** `at` is not unique, so the cursor carries the id too; an offset would rescan served rows. */
const cursorOf = (raw: string | undefined) => {
  const [at, id] = (raw ?? '').split('.');
  const ms = Number(at);
  return id && at && Number.isSafeInteger(ms) ? { at: ms, id } : undefined;
};

/** The whole of "an editor sees only their own": `query.user` is read for an owner only. */
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

/** The two commits that take a file away, which are the two a restore is offered over. */
const REMOVALS = ['entry-delete', 'locale-off'];

/** Read from the log, not the index: a deleted entry is in neither index nor draft rows. */
export async function deletedEntries(
  siteId: string,
  db: Db,
  collection: string,
): Promise<ActivityEvent[]> {
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
        inArray(activity.kind, REMOVALS),
        // A delete of a never-published entry made no commit, so there is nothing to put back.
        isNotNull(activity.commitSha),
        like(activity.subject, `src/content/${collection}/%`),
      ),
    )
    .orderBy(desc(activity.at), desc(activity.id))
    .limit(PAGE);
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    kind: row.kind,
    subject: row.subject,
    detail: row.detail ?? null,
    commitSha: row.commitSha,
    user: row.userId ? { id: row.userId, name: row.name, email: row.email } : null,
  }));
}

/** The build has not seen a template saved since it ran, so the log offers it until then. */
export async function savedTemplates(
  siteId: string,
  db: Db,
  collection: string,
): Promise<string[]> {
  const rows = await db
    .select({ detail: activity.detail })
    .from(activity)
    .where(
      and(
        eq(activity.siteId, siteId),
        eq(activity.kind, 'template-saved'),
        like(activity.subject, `src/content/${collection}/%`),
      ),
    )
    .orderBy(desc(activity.at), desc(activity.id));
  const names = rows.map((row) => (row.detail as { template?: unknown } | null)?.template);
  return [...new Set(names.filter((name): name is string => typeof name === 'string'))];
}

/** Null for a kind nothing claims: a screen must draw a row it has never heard of, not throw. */
export function activityGroupOf(kind: string): ActivityGroup | null {
  if (kind.startsWith('cron-')) return 'System';
  for (const [group, kinds] of Object.entries(ACTIVITY_GROUPS)) {
    if ((kinds as readonly string[]).includes(kind)) return group as ActivityGroup;
  }
  return null;
}

/** One entry somebody last touched, and who: the dashboard's *Recently edited* rows. */
export interface EntryEdit {
  /** `"listings/mill-house"` — the entry, never one of its files. */
  entry: string;
  at: number;
  /** Their name, never their address: this list is not narrowed to the person reading it. */
  by: string | null;
}

/** Read from the log, not the draft rows: a draft is deleted once its build is live. */
export async function publishedEntries(siteId: string, db: Db, limit = 8): Promise<EntryEdit[]> {
  const rows = await db
    .select({
      at: activity.at,
      subject: activity.subject,
      detail: activity.detail,
      name: user.name,
    })
    .from(activity)
    .leftJoin(user, eq(activity.userId, user.id))
    .where(and(eq(activity.siteId, siteId), eq(activity.kind, 'publish')))
    .orderBy(desc(activity.at), desc(activity.id))
    // A publish of twenty entries is one row, so a handful of rows already overfills the tile.
    .limit(limit);
  const found = new Map<string, EntryEdit>();
  for (const row of rows) {
    const named = (row.detail as { entries?: unknown } | null)?.entries;
    // A row from before `entries` was recorded names one entry only through its `subject`.
    const one = entryKey(row.subject ?? '');
    const entries = Array.isArray(named)
      ? named.filter((e): e is string => typeof e === 'string')
      : one
        ? [one]
        : [];
    for (const entry of entries)
      if (!found.has(entry)) found.set(entry, { entry, at: row.at, by: row.name ?? null });
  }
  return [...found.values()].slice(0, limit);
}

/** What the build status reads: a publish redeploys the Worker. */
export async function lastCommit(
  siteId: string,
  db: Db,
): Promise<{ sha: string; at: number; kind: string; by: string | null } | undefined> {
  const [telemetry] = await db
    // Name and never address: this row is read by everybody, not only the person it is about.
    .select({ sha: activity.commitSha, at: activity.at, kind: activity.kind, by: user.name })
    .from(activity)
    .leftJoin(user, eq(activity.userId, user.id))
    .where(and(eq(activity.siteId, siteId), isNotNull(activity.commitSha)))
    .orderBy(desc(activity.at), desc(activity.id))
    .limit(1);
  const [durable] = await db
    .select({
      sha: operations.commitSha,
      at: operations.committedAt,
      kind: operations.kind,
      by: user.name,
    })
    .from(operations)
    .leftJoin(user, eq(operations.userId, user.id))
    .where(and(eq(operations.siteId, siteId), isNotNull(operations.commitSha)))
    .orderBy(desc(operations.committedAt), desc(operations.id))
    .limit(1);
  const row = durable?.sha && (durable.at ?? 0) >= (telemetry?.at ?? 0) ? durable : telemetry;
  return row?.sha
    ? { sha: row.sha, at: row.at ?? 0, kind: row.kind, by: row.by ?? null }
    : undefined;
}

/** Git cannot answer this: an admin commit is the installation's, so the name lives only here. */
export async function commitAuthors(
  siteId: string,
  db: Db,
  shas: readonly string[],
): Promise<Record<string, string>> {
  if (shas.length === 0) return {};
  // The site id takes one binding, leaving 99 for commit SHAs in each D1 statement.
  const chunks = chunksOf([...new Set(shas)], D1_MAX_BOUND_PARAMETERS - 1);
  const rows: { sha: string | null; name: string }[] = [];
  const durable: { sha: string | null; name: string }[] = [];
  for (const chunk of chunks) {
    const [activityRows, operationRows] = await Promise.all([
      db
        .select({ sha: activity.commitSha, name: user.name })
        .from(activity)
        .innerJoin(user, eq(activity.userId, user.id))
        .where(and(eq(activity.siteId, siteId), inArray(activity.commitSha, chunk))),
      db
        .select({ sha: operations.commitSha, name: user.name })
        .from(operations)
        .innerJoin(user, eq(operations.userId, user.id))
        .where(and(eq(operations.siteId, siteId), inArray(operations.commitSha, chunk))),
    ]);
    rows.push(...activityRows);
    durable.push(...operationRows);
  }
  const found: Record<string, string> = {};
  // A commit can carry several events by the same person, so the first row to name it wins.
  for (const row of [...durable, ...rows])
    if (row.sha && row.name && !(row.sha in found)) found[row.sha] = row.name;
  return found;
}

/** The one exception to never-delete: this is telemetry about client data, not client data. */
const KEEP = 180 * 24 * 60 * 60 * 1000;

/** Rows older than the window, deleted; the count is what the cron dispatcher logs. */
export async function expireActivity(siteId: string, db: Db, now = Date.now()): Promise<number> {
  const gone = await db
    .delete(activity)
    .where(and(eq(activity.siteId, siteId), lt(activity.at, now - KEEP)))
    .returning({ id: activity.id });
  return gone.length;
}
