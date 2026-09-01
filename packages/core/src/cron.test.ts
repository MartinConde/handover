import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/d1';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { JOB_NAMES, runDue, runJob } from './cron.js';
import type { Db } from './db.js';
import type { R2Store } from './media.js';
import * as tables from './tables.js';

// The same harness the other D1 files use: a real database behind the real generated schema,
// since what this file is about is the two tables a tick reads and writes.
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

const store: R2Store = {
  accountId: 'acc',
  bucket: 'site-media',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
};

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** A bucket holding exactly these keys, listed the way R2's S3 API lists one. */
const listing = (keys: string[]) =>
  (async () =>
    new Response(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${store.bucket}</Name>${keys
        .map((key) => `<Contents><Key>${key}</Key><Size>1024</Size></Contents>`)
        .join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`,
    )) as unknown as typeof globalThis.fetch;

const cronRows = () =>
  db
    .select()
    .from(tables.cronState)
    .then((rows) => rows.map((r) => ({ job: r.job, lastRun: r.lastRun })));

const kinds = () =>
  db
    .select()
    .from(tables.activity)
    .then((rows) => rows.map((r) => `${r.kind} ${JSON.stringify(r.detail)}`).sort());

test('a job the table has never seen is due, so the first tick runs them all', async () => {
  const report = await runDue('default', { db, store, fetch: listing([]), now: NOW });

  expect(report).toEqual({ reconcile: 0, retention: 0, orphans: 0, hidden: 0 });
  expect(await cronRows()).toEqual([
    { job: 'reconcile', lastRun: NOW },
    { job: 'retention', lastRun: NOW },
    { job: 'orphans', lastRun: NOW },
    { job: 'hidden', lastRun: NOW },
  ]);
});

test('a job whose interval has not passed is skipped and its stamp is left alone', async () => {
  await runDue('default', { db, store, fetch: listing([]), now: NOW });
  const report = await runDue('default', { db, store, fetch: listing([]), now: NOW + 30 * 60_000 });

  expect(report).toEqual({});
  expect(await cronRows()).toEqual([
    { job: 'reconcile', lastRun: NOW },
    { job: 'retention', lastRun: NOW },
    { job: 'orphans', lastRun: NOW },
    { job: 'hidden', lastRun: NOW },
  ]);
});

test('an hour later the hourly job runs again and the daily one does not', async () => {
  await runDue('default', { db, store, fetch: listing([]), now: NOW });
  const later = NOW + 61 * 60_000;
  const report = await runDue('default', { db, store, fetch: listing([]), now: later });

  expect(report).toEqual({ reconcile: 0 });
  expect(await cronRows()).toEqual([
    { job: 'reconcile', lastRun: later },
    { job: 'retention', lastRun: NOW },
    { job: 'orphans', lastRun: NOW },
    { job: 'hidden', lastRun: NOW },
  ]);
});

test('a tick that did nothing writes no activity row', async () => {
  await runDue('default', { db, store, fetch: listing([]), now: NOW });

  expect(await kinds()).toEqual([]);
});

test('work done is logged as cron-<job> with its count', async () => {
  await db.insert(tables.activity).values({
    id: 'old',
    siteId: 'default',
    at: NOW - 200 * DAY,
    kind: 'login',
  });
  const orphan = `media/${'b'.repeat(64)}.webp`;

  const report = await runDue('default', { db, store, fetch: listing([orphan]), now: NOW });

  expect(report).toEqual({ reconcile: 1, retention: 1, orphans: 0, hidden: 0 });
  expect(await kinds()).toEqual(['cron-reconcile {"done":1}', 'cron-retention {"done":1}']);
});

test('a job that throws is logged, stamped, and does not stop the next one', async () => {
  const refused = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch;

  const report = await runDue('default', { db, store, fetch: refused, now: NOW });

  expect(report).toEqual({
    reconcile: 'R2 LIST site-media failed: 403',
    retention: 0,
    orphans: 0,
    hidden: 0,
  });
  expect(await kinds()).toEqual(['cron-reconcile {"error":"R2 LIST site-media failed: 403"}']);
  expect(await cronRows()).toEqual([
    { job: 'reconcile', lastRun: NOW },
    { job: 'retention', lastRun: NOW },
    { job: 'orphans', lastRun: NOW },
    { job: 'hidden', lastRun: NOW },
  ]);
});

/** The same database, except that writing a stamp fails: a D1 that is refusing writes. */
const stampFails = (real: Db): Db =>
  Object.create(real, {
    insert: {
      value: (table: unknown) =>
        table === tables.cronState
          ? {
              values: () => ({
                onConflictDoUpdate: () => Promise.reject(new Error('d1 is not taking writes')),
              }),
            }
          : real.insert(table as Parameters<Db['insert']>[0]),
    },
  }) as Db;

test('a stamp that cannot be written does not stop the job after it', async () => {
  const deps = { db: stampFails(db), store, fetch: listing([]), now: NOW };

  expect(await runDue('default', deps)).toEqual({
    reconcile: 0,
    retention: 0,
    orphans: 0,
    hidden: 0,
  });
});

test('a name nothing is registered under is refused', async () => {
  await expect(runJob('default', 'sitemap', { db, store, now: NOW })).rejects.toThrow(
    'there is no cron job called sitemap: this site runs reconcile, retention, orphans, hidden',
  );
  expect(JOB_NAMES).toEqual(['reconcile', 'retention', 'orphans', 'hidden']);
});

// The sweep needs the repository, and the dispatcher is the only thing that hands it over.
test('the orphan sweep is given the repository the tick was called with', async () => {
  await db.insert(tables.drafts).values({
    siteId: 'default',
    path: 'src/content/listings/en/gone.yaml',
    contents: 'title: "Gone"\n',
    baseSha: 'commit-A',
    baseBlob: 'blob-of-the-file-that-was-there',
    updatedAt: NOW - 2 * DAY,
  });
  const git = { getHead: async () => 'commit-B', getFile: async () => undefined } as never;

  const report = await runDue('default', { db, store, git, fetch: listing([]), now: NOW });

  expect(report.orphans).toBe(1);
  expect(await db.select().from(tables.drafts)).toEqual([]);
});

// The hidden check's answer is read later by the drawer, so its row carries the list and not
// only the count — the one job whose "how many" is not the whole of what it did.
test('the hidden job writes what it found into its activity row', async () => {
  const path = 'src/content/listings/en/old-barn.yaml';
  const since = new Date(NOW - 100 * DAY).toISOString();
  const git = {
    getHead: async () => 'commit-B',
    getFile: async () => undefined,
    contentFiles: async () => [{ path, contents: '_status: "hidden"\ntitle: "Barn"\n' }],
    fileCommits: async () => [{ sha: 'h1', date: since, message: 'Hide' }],
  } as never;

  const report = await runDue('default', { db, store, git, fetch: listing([]), now: NOW });

  expect(report.hidden).toBe(1);
  expect(await kinds()).toEqual([
    `cron-hidden {"done":1,"entries":[{"path":"${path}","since":"${since}"}]}`,
  ]);
});
