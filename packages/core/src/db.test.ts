import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { drafts, openDb } from './db.js';

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
    await generateSQLiteDrizzleJson({ drafts }),
  );
  await binding.batch(ddl.map((sql) => binding.prepare(sql)));
});

test('the generated migration creates the columns the drafts table is specified with', async () => {
  type Column = { name: string; notnull: number; pk: number };
  const columns: Column[] = (await binding.prepare('PRAGMA table_info(drafts)').all()).results;
  expect(columns.map((c) => [c.name, c.notnull, c.pk])).toEqual([
    ['site_id', 1, 1],
    ['path', 1, 2],
    ['contents', 1, 0],
    ['base_sha', 1, 0],
    ['base_blob', 1, 0],
    ['updated_at', 1, 0],
    ['updated_by', 0, 0],
    ['held_by', 0, 0],
    ['pending_redirects', 0, 0],
    ['published_sha', 0, 0],
  ]);
});

test('a draft row round-trips every column', async () => {
  const db = openDb('default', binding);
  const row = {
    siteId: 'default',
    path: 'src/content/listings/en/seaview-cottage.yaml',
    contents: 'title: "Seaview Cottage"\n',
    baseSha: '9f2c1b4e8a7d6c5b4a39281706f5e4d3c2b1a098',
    baseBlob: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567',
    updatedAt: 1755864000000,
    updatedBy: 'anna',
    heldBy: 'martin',
    pendingRedirects: [
      {
        _id: 'k3n8x1',
        from: '/listings/sea-view-cottage',
        to: '/listings/seaview-cottage',
        status: 301 as const,
        reason: 'slug-change' as const,
        entry: 'listings/seaview-cottage',
        createdAt: '2026-08-22T10:00:00Z',
      },
    ],
    publishedSha: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd',
  };
  await db.insert(drafts).values(row);

  const [read] = await db.select().from(drafts);
  expect(read).toEqual(row);
});
