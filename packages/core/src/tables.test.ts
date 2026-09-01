import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as tables from './tables.js';

const mf = new Miniflare({
  modules: true,
  script: 'export default {}',
  d1Databases: { DB: ':memory:' },
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
    'rate_limit',
    'session',
    'settings',
    'user',
    'verification',
  ]);
  expect(await names('index')).toContain('activity_site_at');
});

// Phase 3 has one migration, so a plugin turned on later has no table to arrive in. These
// columns are the ones only the admin plugin and database-backed rate limiting produce.
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
