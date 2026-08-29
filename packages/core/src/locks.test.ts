import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/d1';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { Db } from './db.js';
import {
  claimLock,
  heldEntries,
  LOCK_TTL,
  lockHolder,
  lockHolders,
  releaseLocks,
  takeLock,
} from './locks.js';
import * as tables from './tables.js';

// The same harness `activity.test.ts` uses: a real D1 behind the real generated schema, since
// what this file is about is a conditional upsert and an expiry rather than arithmetic.
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
  await seedUser('u1', 'Anna Berg');
  await seedUser('u2', 'Martin');
});

async function seedUser(id: string, name: string) {
  await binding
    .prepare(
      `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'editor', 0, 0)`,
    )
    .bind(id, name, `${id}@example.com`)
    .run();
}

const NOW = 1755864000000;

test('an entry nobody is editing is taken, and the expiry is one lifetime out', async () => {
  expect(await claimLock('default', db, 'listings/seaview-cottage', 'u1', 'tab', NOW)).toBe(
    NOW + LOCK_TTL,
  );
  expect(await lockHolder('default', db, 'listings/seaview-cottage', NOW)).toEqual({
    userId: 'u1',
    tab: 'tab',
    name: 'Anna Berg',
    expiresAt: NOW + LOCK_TTL,
  });
});

test('a beat from the holder pushes their own lock further out', async () => {
  await claimLock('default', db, 'listings/seaview-cottage', 'u1', 'tab', NOW);
  expect(
    await claimLock('default', db, 'listings/seaview-cottage', 'u1', 'tab', NOW + 45_000),
  ).toBe(NOW + 45_000 + LOCK_TTL);
});

test('a second editor is refused, and reads who is editing it', async () => {
  await claimLock('default', db, 'listings/seaview-cottage', 'u1', 'tab', NOW);
  expect(
    await claimLock('default', db, 'listings/seaview-cottage', 'u2', 'tab', NOW + 1000),
  ).toBeUndefined();
  expect((await lockHolder('default', db, 'listings/seaview-cottage', NOW + 1000))?.userId).toBe(
    'u1',
  );
});

test('a lock is held up to its expiry and taken from the moment it passes', async () => {
  await claimLock('default', db, 'listings/seaview-cottage', 'u1', 'tab', NOW);
  const expiry = NOW + LOCK_TTL;
  expect(
    await claimLock('default', db, 'listings/seaview-cottage', 'u2', 'tab', expiry - 1),
  ).toBeUndefined();
  expect(await lockHolder('default', db, 'listings/seaview-cottage', expiry)).toBeUndefined();
  expect(await claimLock('default', db, 'listings/seaview-cottage', 'u2', 'tab', expiry)).toBe(
    expiry + LOCK_TTL,
  );
});

test('what somebody is editing leaves out the entries their beat has run out on', async () => {
  await claimLock('default', db, 'listings/seaview-cottage', 'u1', 'tab', NOW);
  await claimLock('default', db, 'pages/home', 'u1', 'tab', NOW);
  await claimLock('default', db, 'pages/about', 'u2', 'tab', NOW - LOCK_TTL);
  expect(await heldEntries('default', db, NOW)).toEqual({
    u1: ['listings/seaview-cottage', 'pages/home'],
  });
});

// The list's badge: every entry somebody is in, by name, with the ones whose beat ran out gone.
test('who is editing what names each held entry by the person on it', async () => {
  await claimLock('default', db, 'listings/seaview-cottage', 'u1', 'tab', NOW);
  await claimLock('default', db, 'globals/site', 'u2', 'tab', NOW);
  await claimLock('default', db, 'pages/about', 'u2', 'tab', NOW - LOCK_TTL);
  expect(await lockHolders('default', db, NOW)).toEqual({
    'listings/seaview-cottage': { id: 'u1', name: 'Anna Berg' },
    'globals/site': { id: 'u2', name: 'Martin' },
  });
});

test('removing a member lets go of their entries and leaves everyone else holding theirs', async () => {
  await claimLock('default', db, 'listings/seaview-cottage', 'u1', 'tab', NOW);
  await claimLock('default', db, 'pages/home', 'u2', 'tab', NOW);
  await releaseLocks('default', db, 'u1');
  expect(await lockHolder('default', db, 'listings/seaview-cottage', NOW)).toBeUndefined();
  expect((await lockHolder('default', db, 'pages/home', NOW))?.userId).toBe('u2');
});

// The lock is per tab: one person with the entry open twice is two holders, and the second is
// told so rather than writing over the first.
test('a second tab of the same person is refused, and reads its own name as the holder', async () => {
  await claimLock('default', db, 'listings/seaview-cottage', 'u1', 'tab-a', NOW);
  expect(
    await claimLock('default', db, 'listings/seaview-cottage', 'u1', 'tab-b', NOW + 1000),
  ).toBeUndefined();
  expect(await lockHolder('default', db, 'listings/seaview-cottage', NOW + 1000)).toEqual({
    userId: 'u1',
    tab: 'tab-a',
    name: 'Anna Berg',
    expiresAt: NOW + LOCK_TTL,
  });
});

test('Take over moves the lock to the tab that asked', async () => {
  await claimLock('default', db, 'listings/seaview-cottage', 'u1', 'tab-a', NOW);
  await takeLock('default', db, 'listings/seaview-cottage', 'u1', 'tab-b', NOW + 1000);
  expect((await lockHolder('default', db, 'listings/seaview-cottage', NOW + 1000))?.tab).toBe(
    'tab-b',
  );
});

test('Take over transfers a lock somebody else is holding, with a fresh lifetime', async () => {
  await claimLock('default', db, 'listings/seaview-cottage', 'u1', 'tab', NOW);
  expect(await takeLock('default', db, 'listings/seaview-cottage', 'u2', 'tab', NOW + 1000)).toBe(
    NOW + 1000 + LOCK_TTL,
  );
  expect(await lockHolder('default', db, 'listings/seaview-cottage', NOW + 1000)).toMatchObject({
    userId: 'u2',
    expiresAt: NOW + 1000 + LOCK_TTL,
  });
});
