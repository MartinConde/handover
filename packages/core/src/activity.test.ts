import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/d1';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import {
  activityGroupOf,
  activityPage,
  commitAuthors,
  deletedEntries,
  expireActivity,
  lastCommit,
  logActivity,
  publishedEntries,
} from './activity.js';
import type { Db } from './db.js';
import * as tables from './tables.js';

// The same harness `auth.test.ts` uses: a real D1 behind the real generated schema, since
// what this file is about is a query and a cursor rather than arithmetic.
const mf = new Miniflare({
  modules: true,
  script: 'export default {}',
  d1Databases: { DB: ':memory:' },
});
afterAll(() => mf.dispose());

let binding: Awaited<ReturnType<typeof mf.getD1Database>>;
let db: Db;
let ddl: string[];
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  db = drizzle(binding, { schema: { drafts: tables.drafts } }) as unknown as Db;
  ddl = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson({ ...tables }),
  );
});

beforeEach(async () => {
  const rows = (await binding.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all())
    .results as { name: string }[];
  for (const { name } of rows.filter((r) => !/^(sqlite_|_cf_)/.test(r.name))) {
    await binding.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  }
  await binding.batch(ddl.map((sql) => binding.prepare(sql)));
});

const OWNER = { id: 'u1', role: 'owner' } as const;
const EDITOR = { id: 'u2', role: 'editor' } as const;

async function seedUser(id: string, name: string, email: string) {
  await binding
    .prepare(
      `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'editor', 0, 0)`,
    )
    .bind(id, name, email)
    .run();
}

/** A row written straight in, so a test can say what time it happened and in what order. */
async function seedEvent(row: {
  id: string;
  at: number;
  userId?: string | null;
  kind: string;
  subject?: string | null;
  detail?: unknown;
  commitSha?: string | null;
}) {
  await binding
    .prepare(
      `INSERT INTO activity (id, site_id, at, user_id, kind, subject, detail, commit_sha)
       VALUES (?, 'default', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.at,
      row.userId ?? null,
      row.kind,
      row.subject ?? null,
      row.detail === undefined ? null : JSON.stringify(row.detail),
      row.commitSha ?? null,
    )
    .run();
}

const kindsOf = async (viewer: typeof OWNER | typeof EDITOR, query = {}) =>
  (await activityPage('default', db, viewer, query)).events.map((e) => e.kind);

test('a logged event keeps every column it was given', async () => {
  await logActivity('default', db, {
    userId: 'u1',
    kind: 'publish',
    subject: 'src/content/listings/en/mill-house.yaml',
    detail: { files: 3 },
    commitSha: 'def456',
  });

  const { events } = await activityPage('default', db, OWNER);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: 'publish',
    subject: 'src/content/listings/en/mill-house.yaml',
    detail: { files: 3 },
    commitSha: 'def456',
  });
});

test('an event with no user is the system, and reads back as one', async () => {
  await logActivity('default', db, { kind: 'mail-failed', detail: { message: 'sign-in link' } });

  const { events } = await activityPage('default', db, OWNER);
  expect(events[0]?.user).toBe(null);
});

test('an event names the person it belongs to', async () => {
  await seedUser('u1', 'Martin', 'martin@example.com');
  await logActivity('default', db, { userId: 'u1', kind: 'login', detail: { method: 'password' } });

  const { events } = await activityPage('default', db, OWNER);
  expect(events[0]?.user).toEqual({ id: 'u1', name: 'Martin', email: 'martin@example.com' });
});

test('an event outlives the account it belongs to, and still names the id', async () => {
  await seedUser('u1', 'Martin', 'martin@example.com');
  await logActivity('default', db, { userId: 'u1', kind: 'login', detail: { method: 'password' } });
  await binding.prepare(`DELETE FROM user WHERE id = 'u1'`).run();

  const { events } = await activityPage('default', db, OWNER);
  expect(events[0]?.user).toEqual({ id: 'u1', name: null, email: null });
});

test('newest first', async () => {
  await seedEvent({ id: 'a', at: 1000, kind: 'login' });
  await seedEvent({ id: 'b', at: 3000, kind: 'publish' });
  await seedEvent({ id: 'c', at: 2000, kind: 'invite' });

  expect(await kindsOf(OWNER)).toEqual(['publish', 'invite', 'login']);
});

test('an owner sees everybody', async () => {
  await seedEvent({ id: 'a', at: 1000, userId: 'u1', kind: 'login' });
  await seedEvent({ id: 'b', at: 2000, userId: 'u2', kind: 'publish' });
  await seedEvent({ id: 'c', at: 3000, kind: 'cron-retention' });

  expect(await kindsOf(OWNER)).toEqual(['cron-retention', 'publish', 'login']);
});

test('an editor sees only their own events', async () => {
  await seedEvent({ id: 'a', at: 1000, userId: 'u1', kind: 'login' });
  await seedEvent({ id: 'b', at: 2000, userId: 'u2', kind: 'publish' });
  await seedEvent({ id: 'c', at: 3000, kind: 'cron-retention' });

  expect(await kindsOf(EDITOR)).toEqual(['publish']);
});

test('an editor asking for somebody else gets their own events, not a refusal', async () => {
  await seedEvent({ id: 'a', at: 1000, userId: 'u1', kind: 'login' });
  await seedEvent({ id: 'b', at: 2000, userId: 'u2', kind: 'publish' });

  expect(await kindsOf(EDITOR, { user: 'u1' })).toEqual(['publish']);
});

test('an owner can ask for one person', async () => {
  await seedEvent({ id: 'a', at: 1000, userId: 'u1', kind: 'login' });
  await seedEvent({ id: 'b', at: 2000, userId: 'u2', kind: 'publish' });

  expect(await kindsOf(OWNER, { user: 'u1' })).toEqual(['login']);
});

test('a kind group takes the kinds in it and nothing else', async () => {
  await seedEvent({ id: 'a', at: 1000, kind: 'login' });
  await seedEvent({ id: 'b', at: 2000, kind: 'publish' });
  await seedEvent({ id: 'c', at: 3000, kind: 'invite' });

  expect(await kindsOf(OWNER, { group: 'Accounts' })).toEqual(['invite', 'login']);
});

test('the System group takes every cron job, whatever it is called', async () => {
  await seedEvent({ id: 'a', at: 1000, kind: 'cron-retention' });
  await seedEvent({ id: 'b', at: 2000, kind: 'cron-orphans' });
  await seedEvent({ id: 'c', at: 3000, kind: 'publish' });

  expect(await kindsOf(OWNER, { group: 'System' })).toEqual(['cron-orphans', 'cron-retention']);
});

test('a group nobody defines filters nothing out', async () => {
  await seedEvent({ id: 'a', at: 1000, kind: 'login' });

  expect(await kindsOf(OWNER, { group: 'Nonsense' })).toEqual(['login']);
});

test('an entry filter takes the events about that entry', async () => {
  const entry = 'src/content/listings/en/mill-house.yaml';
  await seedEvent({ id: 'a', at: 1000, kind: 'publish', subject: entry });
  await seedEvent({
    id: 'b',
    at: 2000,
    kind: 'publish',
    subject: 'src/content/pages/en/about.yaml',
  });

  expect((await activityPage('default', db, OWNER, { entry })).events.map((e) => e.id)).toEqual([
    'a',
  ]);
});

test('a page is fifty rows and says where the next one starts', async () => {
  for (let i = 0; i < 51; i += 1) await seedEvent({ id: `e${i}`, at: 1000 + i, kind: 'login' });

  const first = await activityPage('default', db, OWNER);
  expect(first.events).toHaveLength(50);
  expect(first.events[0]?.id).toBe('e50');
  expect(first.cursor).toBe('1001.e1');
});

test('the last page has no cursor', async () => {
  await seedEvent({ id: 'a', at: 1000, kind: 'login' });

  expect((await activityPage('default', db, OWNER)).cursor).toBe(null);
});

test('paging does not skip or repeat rows written in the same millisecond', async () => {
  // Three events sharing one `at`: `at` alone cannot order them, so a cursor that carries only
  // the time either loses the middle row or serves it twice.
  await seedEvent({ id: 'aaa', at: 5000, kind: 'login' });
  await seedEvent({ id: 'bbb', at: 5000, kind: 'invite' });
  await seedEvent({ id: 'ccc', at: 5000, kind: 'publish' });

  const seen: string[] = [];
  let cursor = '5000.ccc';
  for (let page = 0; page < 3; page += 1) {
    const { events, cursor: next } = await activityPage('default', db, OWNER, { cursor });
    seen.push(...events.map((e) => e.id));
    if (!next) break;
    cursor = next;
  }
  expect(seen).toEqual(['bbb', 'aaa']);
});

test('a cursor that is not a cursor is ignored rather than obeyed', async () => {
  await seedEvent({ id: 'a', at: 1000, kind: 'login' });

  expect(await kindsOf(OWNER, { cursor: "1000' OR 1=1 --" })).toEqual(['login']);
});

// The inverse of the group table, for the chip a row wears. It is here rather than in the
// screen because the `cron-` prefix rule is this file's and two copies of it would drift.
test('a kind is named by the group that holds it', () => {
  expect(activityGroupOf('login')).toBe('Accounts');
  expect(activityGroupOf('publish')).toBe('Publishing');
  expect(activityGroupOf('mail-failed')).toBe('System');
});

test('every cron job is System, whatever the job is called', () => {
  expect(activityGroupOf('cron-retention')).toBe('System');
  expect(activityGroupOf('cron-whatever-3-17-registers')).toBe('System');
});

// A screen that throws on a kind nobody has claimed yet is a screen that breaks on the next
// row, so the lookup answers rather than refuses.
test('a kind no group claims is named by none of them', () => {
  expect(activityGroupOf('something-phase-9-invents')).toBe(null);
});

// What the build pill reads after the publish that redeployed the Worker under it.
test('the last commit is the newest one the log carries', async () => {
  await logActivity('default', db, { kind: 'publish', commitSha: 'aaa111' });
  await logActivity('default', db, { kind: 'login' });
  await logActivity('default', db, { kind: 'revert', commitSha: 'bbb222' });
  await logActivity('default', db, { kind: 'draft-discard' });

  expect(await lastCommit('default', db)).toMatchObject({ sha: 'bbb222', kind: 'revert' });
});

test('the last commit names who made it, by name and not by address', async () => {
  await seedUser('u1', 'Anna Berg', 'anna@example.com');
  await seedEvent({ id: 'a1', at: 1000, userId: 'u1', kind: 'publish', commitSha: 'aaa111' });

  expect(await lastCommit('default', db)).toEqual({
    sha: 'aaa111',
    at: 1000,
    kind: 'publish',
    by: 'Anna Berg',
  });
});

test('a log with no commit in it has no last commit', async () => {
  await logActivity('default', db, { kind: 'login' });

  expect(await lastCommit('default', db)).toBe(undefined);
});

test('retention deletes rows past 180 days and keeps the day before the cut', async () => {
  const now = 1_800_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  await seedEvent({ id: 'ancient', at: now - 400 * day, kind: 'login' });
  await seedEvent({ id: 'just-out', at: now - 181 * day, kind: 'publish' });
  await seedEvent({ id: 'just-in', at: now - 179 * day, kind: 'publish' });
  await seedEvent({ id: 'today', at: now, kind: 'login' });

  expect(await expireActivity('default', db, now)).toBe(2);
  expect(await kindsOf(OWNER)).toEqual(['login', 'publish']);
});

// The Deleted view is a query against the log, so what it asks for is this file's to get right:
// the two kinds that take a file away, in one collection, and only where there is a commit to
// undo.
test('the deleted list is the two removals in one collection, newest first', async () => {
  const at = 1_800_000_000_000;
  const gone = 'src/content/listings/en/mill-house.yaml';
  await seedEvent({ id: 'e1', at, kind: 'entry-delete', subject: gone, commitSha: 'aaa111' });
  await seedEvent({
    id: 'e2',
    at: at + 1000,
    kind: 'locale-off',
    subject: 'src/content/listings/en/harbour-flat.yaml',
    detail: { locales: ['de'] },
    commitSha: 'bbb222',
  });
  await seedEvent({
    id: 'e3',
    at: at + 2000,
    kind: 'entry-rename',
    subject: gone,
    commitSha: 'c1',
  });
  await seedEvent({
    id: 'e4',
    at: at + 3000,
    kind: 'entry-delete',
    subject: 'src/content/pages/en/about.yaml',
    commitSha: 'ddd444',
  });

  const rows = await deletedEntries('default', db, 'listings');

  expect(rows.map((r) => r.id)).toEqual(['e2', 'e1']);
  expect(rows[0]?.detail).toEqual({ locales: ['de'] });
});

// An entry that was never published is deleted without a commit, so there is nothing to put back
// and no row to offer it on.
test('a delete that made no commit is not in the deleted list', async () => {
  await seedEvent({
    id: 'e1',
    at: 1_800_000_000_000,
    kind: 'entry-delete',
    subject: 'src/content/listings/en/mill-house.yaml',
  });

  expect(await deletedEntries('default', db, 'listings')).toEqual([]);
});

// Git records the installation rather than the person, so this lookup is the only thing that
// can put a name against a version the admin committed.
test('commit authors are the people the log recorded against those commits', async () => {
  await seedUser('u1', 'Anna Weber', 'anna@example.com');
  await seedUser('u2', '', 'martin@example.com');
  await seedEvent({ id: 'e1', at: 1, userId: 'u1', kind: 'publish', commitSha: 'aaa111' });
  await seedEvent({ id: 'e2', at: 2, userId: 'u1', kind: 'hold-released', commitSha: 'aaa111' });
  await seedEvent({ id: 'e3', at: 3, userId: 'u2', kind: 'entry-rename', commitSha: 'bbb222' });
  await seedEvent({ id: 'e4', at: 4, userId: null, kind: 'publish', commitSha: 'ccc333' });

  // The name and never the email: this list is not narrowed to the person reading it, so an
  // email here would be a way to find out who else has an account.
  expect(await commitAuthors('default', db, ['aaa111', 'bbb222', 'ccc333', 'ddd444'])).toEqual({
    aaa111: 'Anna Weber',
  });
});

test('the entries a publish carried are one row each, newest first', async () => {
  await seedUser('u1', 'Anna Berg', 'anna@example.com');
  await seedEvent({
    id: 'a1',
    at: 1000,
    userId: 'u1',
    kind: 'publish',
    detail: { files: 3, entries: ['listings/mill-house', 'pages/home'] },
  });
  await seedEvent({
    id: 'a2',
    at: 2000,
    userId: 'u1',
    kind: 'publish',
    detail: { files: 1, entries: ['pages/home'] },
  });

  expect(await publishedEntries('default', db)).toEqual([
    { entry: 'pages/home', at: 2000, by: 'Anna Berg' },
    { entry: 'listings/mill-house', at: 1000, by: 'Anna Berg' },
  ]);
});

// Rows the log already holds were written before a publish recorded what it carried.
test('an older row names its one entry through the file it was about', async () => {
  await seedEvent({
    id: 'a1',
    at: 1000,
    kind: 'publish',
    subject: 'src/content/listings/de/mill-house.yaml',
    detail: { files: 1 },
  });
  await seedEvent({ id: 'a2', at: 2000, kind: 'publish', detail: { files: 4 } });

  expect(await publishedEntries('default', db)).toEqual([
    { entry: 'listings/mill-house', at: 1000, by: null },
  ]);
});

test('nothing but a publish is a page somebody edited', async () => {
  await seedEvent({
    id: 'a1',
    at: 1000,
    kind: 'entry-delete',
    subject: 'src/content/listings/en/mill-house.yaml',
    detail: { entries: ['listings/mill-house'] },
  });

  expect(await publishedEntries('default', db)).toEqual([]);
});
