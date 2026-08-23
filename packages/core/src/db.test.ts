import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import {
  createDraft,
  DraftConflictError,
  discardDraft,
  drafts,
  openDb,
  overlayRows,
  pendingDrafts,
  publishDrafts,
  recordDelete,
  recordRename,
  saveDraft,
} from './db.js';
import { type ContentIndex, collectionEntries, indexFrom } from './entries.js';
import { blobSha } from './git.js';

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

// A file as it sits in the repo, with the two reserved keys no collection schema declares.
const FILE =
  '_version: 1\n_status: "hidden"\ntitle: "The Mill House"\nprice: "£950 per week"\nrooms: 3\n';
const BLOB = '0a682b93c14fc8fe88c614f5a2581c38120d7f69'; // git hash-object of FILE
const PATH = 'src/content/listings/en/mill-house.yaml';
// The form sends the schema's fields only — reserved keys are stripped by `schema.parse`.
const VALUES = { title: 'The Mill House', price: '£950 per week', rooms: 3 };

const git = {
  getHead: async () => 'commit-A',
  getFile: async (path: string) => (path === PATH ? { contents: FILE, blob_sha: BLOB } : undefined),
};

const fresh = async () => {
  const db = openDb('default', binding);
  await db.delete(drafts);
  return db;
};
const only = async (db: ReturnType<typeof openDb>) => (await db.select().from(drafts))[0];

test('the first autosave takes the base sha and blob from git, not from the browser', async () => {
  const db = await fresh();
  await saveDraft('default', db, git, PATH, VALUES);

  const row = await only(db);
  expect(row?.baseSha).toBe('commit-A');
  expect(row?.baseBlob).toBe(BLOB);
});

test('a no-op autosave reproduces the loaded bytes exactly', async () => {
  const db = await fresh();
  const saved = await saveDraft('default', db, git, PATH, VALUES);

  const row = await only(db);
  expect(row?.contents).toBe(FILE);
  expect(await blobSha(row?.contents ?? '')).toBe(row?.baseBlob);
  expect(saved?.pending).toBe(false);
});

test('a later autosave replaces the contents and leaves the base where it was', async () => {
  const db = await fresh();
  await saveDraft('default', db, git, PATH, VALUES);
  const saved = await saveDraft('default', db, git, PATH, { ...VALUES, rooms: 4 });

  const row = await only(db);
  expect(row?.contents).toBe(FILE.replace('rooms: 3', 'rooms: 4'));
  expect(row?.baseSha).toBe('commit-A');
  expect(row?.baseBlob).toBe(BLOB);
  expect(saved?.pending).toBe(true);
  expect((await db.select().from(drafts)).length).toBe(1);
});

test('an autosave for a path that is not in the repo writes nothing', async () => {
  const db = await fresh();
  expect(await saveDraft('default', db, git, 'src/content/listings/en/gone.yaml', VALUES)).toBe(
    undefined,
  );
  expect(await only(db)).toBe(undefined);
});

// A repo in a Map: publish moves the head and the files, so a second publish sees the
// bytes the first one wrote.
function fakeRepo(files: Record<string, string>) {
  let head = 'commit-A';
  let n = 0;
  return {
    async getHead() {
      return head;
    },
    async getFile(path: string) {
      const contents = files[path];
      return contents === undefined ? undefined : { contents, blob_sha: await blobSha(contents) };
    },
    publish: vi.fn(async (list: { path: string; contents: string | null }[]) => {
      for (const f of list) if (f.contents !== null) files[f.path] = f.contents;
      head = `commit-${++n}`;
      return { commit_sha: head };
    }),
    write(path: string, contents: string) {
      files[path] = contents;
    },
  };
}

const OTHER = 'src/content/listings/en/barn.yaml';
const RENAMED = 'src/content/listings/en/the-old-mill.yaml';
const OTHER_FILE = '_version: 1\ntitle: "The Barn"\nrooms: 1\n';

test('a draft that matches the file it was loaded from is not pending', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, VALUES);

  expect(await pendingDrafts('default', db)).toEqual([]);
});

test('publishing commits every pending draft in one commit and clears those rows', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [OTHER]: OTHER_FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  await saveDraft('default', db, repo, OTHER, { title: 'The Barn', price: '£10', rooms: 2 });

  const result = await publishDrafts('default', db, repo);

  expect(repo.publish).toHaveBeenCalledTimes(1);
  expect(result?.paths.toSorted()).toEqual([OTHER, PATH].toSorted());
  expect(await db.select().from(drafts)).toEqual([]);
});

test('publishing refuses the whole set when a file changed in the repo since it was loaded', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [OTHER]: OTHER_FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  await saveDraft('default', db, repo, OTHER, { title: 'The Barn', price: '£10', rooms: 2 });
  repo.write(PATH, FILE.replace('rooms: 3', 'rooms: 9'));

  await expect(publishDrafts('default', db, repo)).rejects.toBeInstanceOf(DraftConflictError);
  expect(repo.publish).not.toHaveBeenCalled();
  expect((await db.select().from(drafts)).length).toBe(2);
});

test('publishing with nothing pending makes no commit', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, VALUES);

  expect(await publishDrafts('default', db, repo)).toBe(undefined);
  expect(repo.publish).not.toHaveBeenCalled();
});

test('editing again after a publish is not a conflict with the publish itself', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  await publishDrafts('default', db, repo);

  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 5 });
  const second = await publishDrafts('default', db, repo);

  expect(second?.paths).toEqual([PATH]);
  await expect(repo.getFile(PATH)).resolves.toMatchObject({
    contents: FILE.replace('rooms: 3', 'rooms: 5'),
  });
});

const NEW = 'src/content/listings/en/strandhaus-nord.yaml';

test('a new entry is a draft against a base blob nothing in the repo can match', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });

  await createDraft('default', db, repo, NEW, { title: 'Strandhaus Nord', rooms: 0 });

  const row = await only(db);
  expect(row?.path).toBe(NEW);
  expect(row?.contents).toBe('title: "Strandhaus Nord"\nrooms: 0\n');
  expect(row?.baseSha).toBe('commit-A');
  expect(row?.baseBlob).toBe('');
  expect((await pendingDrafts('default', db)).map((r) => r.path)).toEqual([NEW]);
});

test('publishing a new entry creates its file in one commit', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await createDraft('default', db, repo, NEW, { title: 'Strandhaus Nord', rooms: 0 });

  const result = await publishDrafts('default', db, repo);

  expect(result?.paths).toEqual([NEW]);
  expect(repo.publish).toHaveBeenCalledTimes(1);
  await expect(repo.getFile(NEW)).resolves.toMatchObject({
    contents: 'title: "Strandhaus Nord"\nrooms: 0\n',
  });
  expect(await db.select().from(drafts)).toEqual([]);
});

test('a new entry whose path someone else committed first is a conflict', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await createDraft('default', db, repo, NEW, { title: 'Strandhaus Nord', rooms: 0 });
  repo.write(NEW, 'title: "Theirs"\n');

  await expect(publishDrafts('default', db, repo)).rejects.toBeInstanceOf(DraftConflictError);
  expect(repo.publish).not.toHaveBeenCalled();
});

test('discarding a draft leaves nothing for the next publish to write back', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });

  await discardDraft('default', db, PATH);

  expect(await db.select().from(drafts)).toEqual([]);
  expect(await publishDrafts('default', db, repo)).toBe(undefined);
});

// The index as the last build made it: the entry list's other half, one build behind
// everything a rename or a delete commits.
const indexOf = (files: Record<string, string>) =>
  indexFrom(
    'default',
    Object.entries(files).map(([path, contents]) => ({ path, contents })),
  );
const listed = async (db: ReturnType<typeof openDb>, index: ContentIndex) =>
  collectionEntries('default', index, 'listings', await overlayRows('default', db, index)).map(
    (e) => [e.id, e.locales.en?.title],
  );

test('a rename shows the new name in the list before the build that carries it', async () => {
  const db = await fresh();
  const index = indexOf({ [PATH]: FILE, [OTHER]: OTHER_FILE });

  await recordRename('default', db, PATH, RENAMED, FILE, 'commit-rename');

  expect(await listed(db, index)).toEqual([
    ['barn', 'The Barn'],
    ['the-old-mill', 'The Mill House'],
  ]);
});

test('a rename carries the unpublished edits rather than the committed bytes', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, title: 'The Old Mill' });

  await recordRename('default', db, PATH, RENAMED, FILE, 'commit-rename');

  expect(await listed(db, indexOf({ [PATH]: FILE }))).toEqual([['the-old-mill', 'The Old Mill']]);
  const [row] = await pendingDrafts('default', db);
  expect(row?.path).toBe(RENAMED);
  expect(row?.baseSha).toBe('commit-rename');
  // The rename commit moved the loaded bytes untouched, so the base blob still describes them.
  expect(row?.baseBlob).toBe(await blobSha(FILE));
});

test('a delete takes the entry out of the list and leaves nothing to publish', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [OTHER]: OTHER_FILE });
  const index = indexOf({ [PATH]: FILE, [OTHER]: OTHER_FILE });

  await recordDelete('default', db, PATH, 'commit-delete');

  expect(await listed(db, index)).toEqual([['barn', 'The Barn']]);
  expect(await publishDrafts('default', db, repo)).toBe(undefined);
});

test('the rows a rename left are dropped by the build that catches up with them', async () => {
  const db = await fresh();
  await recordRename('default', db, PATH, RENAMED, FILE, 'commit-rename');

  const built = indexOf({ [RENAMED]: FILE });
  expect(await listed(db, built)).toEqual([['the-old-mill', 'The Mill House']]);
  expect(await db.select().from(drafts)).toEqual([]);
});

test('an entry can take the name a delete freed', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await recordDelete('default', db, PATH, 'commit-delete');

  await createDraft('default', db, repo, PATH, { title: 'The Mill House', rooms: 3 });

  expect(await listed(db, indexOf({ [PATH]: FILE }))).toEqual([['mill-house', 'The Mill House']]);
  expect((await pendingDrafts('default', db)).map((r) => r.path)).toEqual([PATH]);
});

test('an autosave after a delete takes its base from the file, not from the row', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await recordDelete('default', db, PATH, 'commit-delete');
  repo.write(PATH, FILE); // the file is back: a developer added it again

  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });

  expect((await publishDrafts('default', db, repo))?.paths).toEqual([PATH]);
});
