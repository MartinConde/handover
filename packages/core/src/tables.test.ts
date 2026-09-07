import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as tables from './tables.js';

const mf = new Miniflare({
  modules: true,
  script: 'export default {}',
  d1Databases: { DB: ':memory:', UPGRADE: 'upgrade-memory' },
});
afterAll(() => mf.dispose());

// The same generator the client repo's `drizzle-kit generate` runs, against a real D1.
let binding: Awaited<ReturnType<typeof mf.getD1Database>>;
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  const ddl = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson({ ...tables }),
  );
  await binding.batch(ddl.map((sql) => binding.prepare(sql)));
});

const names = async (type: 'table' | 'index') =>
  (
    (await binding.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).bind(type).all())
      .results as { name: string }[]
  )
    .map((r) => r.name)
    .filter((n) => !/^(sqlite_|_cf_)/.test(n))
    .toSorted();

const columns = async (table: string) =>
  ((await binding.prepare(`PRAGMA table_info(${table})`).all()).results as { name: string }[]).map(
    (c) => c.name,
  );

test('the migration creates every table and index the docs specify', async () => {
  expect(await names('table')).toEqual([
    'account',
    'activity',
    'cron_state',
    'drafts',
    'locks',
    'media',
    'path_reservations',
    'rate_limit',
    'session',
    'settings',
    'user',
    'verification',
  ]);
  expect(await names('index')).toContain('activity_site_at');
});

// One migration only, so a plugin turned on later has no table to arrive in.
test('the auth tables carry the whole plugin set', async () => {
  expect(await columns('user')).toEqual(
    expect.arrayContaining(['role', 'banned', 'ban_reason', 'ban_expires']),
  );
  expect(await columns('session')).toEqual(expect.arrayContaining(['impersonated_by']));
});

test('the generated migration creates the columns the drafts table is specified with', async () => {
  type Column = { name: string; notnull: number; pk: number };
  const cols: Column[] = (await binding.prepare('PRAGMA table_info(drafts)').all()).results;
  expect(cols.map((c) => [c.name, c.notnull, c.pk])).toEqual([
    ['site_id', 1, 1],
    ['path', 1, 2],
    ['contents', 1, 0],
    ['revision', 1, 0],
    ['base_sha', 1, 0],
    ['base_blob', 1, 0],
    ['updated_at', 1, 0],
    ['updated_by', 0, 0],
    ['held_by', 0, 0],
    ['held_at', 0, 0],
    ['pending_redirects', 0, 0],
    ['published_sha', 0, 0],
  ]);
});

test('upgrading existing drafts preserves content and supplies a usable legacy revision', async () => {
  const current = await generateSQLiteDrizzleJson({ ...tables });
  const previous = structuredClone(current);
  delete previous.tables.path_reservations;
  const oldDrafts = previous.tables.drafts;
  if (!oldDrafts) throw new Error('Missing drafts schema');
  delete oldDrafts.columns.revision;
  const upgrade = await mf.getD1Database('UPGRADE');
  const oldSql = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), previous);
  await upgrade.batch(oldSql.map((sql) => upgrade.prepare(sql)));
  await upgrade
    .prepare(
      "insert into drafts (site_id,path,contents,base_sha,base_blob,updated_at) values ('default','src/content/pages/en/home.yaml','Keep my edits','old','blob',1)",
    )
    .run();
  const migration = await generateSQLiteMigration(previous, current);
  await upgrade.batch(migration.map((sql) => upgrade.prepare(sql)));
  expect(await upgrade.prepare('select contents,revision from drafts').first()).toEqual({
    contents: 'Keep my edits',
    revision: 'legacy',
  });
});
