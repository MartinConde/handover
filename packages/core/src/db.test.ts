import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { logActivity } from './activity.js';
import { driftReport, offeredEntry, parseEntry, staleLocales, stringifyEntry } from './content.js';
import {
  clearPublished,
  createDraft,
  DraftConflictError,
  discardDraft,
  draftEditors,
  draftFiles,
  entryConflict,
  heldDrafts,
  holdEntry,
  loadDraft,
  openDb,
  overlayRows,
  pendingDrafts,
  publishDrafts,
  RevertConflictError,
  recordDelete,
  recordOffer,
  recordRename,
  resolveConflict,
  resolveDrift,
  restoreCommit,
  restoreDraft,
  revertCommit,
  saveDraft,
  saveTranslated,
  setEntryAddress,
  setEntryLocales,
  setEntryStatus,
  sweepOrphans,
} from './db.js';
import { type ContentIndex, collectionEntries, entryKey, indexFrom } from './entries.js';
import { blobSha } from './git.js';
import type { RedirectRule } from './lifecycle.js';
import { claimLock } from './locks.js';
import type { Form } from './schema.js';
import * as tables from './tables.js';
import { drafts } from './tables.js';

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

test('a draft row round-trips every column', async () => {
  const db = openDb('default', binding);
  const row = {
    siteId: 'default',
    revision: 'first-revision',
    path: 'src/content/listings/en/seaview-cottage.yaml',
    contents: 'title: "Seaview Cottage"\n',
    baseSha: '9f2c1b4e8a7d6c5b4a39281706f5e4d3c2b1a098',
    baseBlob: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567',
    updatedAt: 1755864000000,
    updatedBy: 'anna',
    heldBy: 'martin',
    heldAt: 1755860000000,
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
  await db.delete(tables.activity);
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

// *Last edited by* on the dashboard; a rename, a restore and a drift answer stamp it too.
test('an autosave records who typed it, and the next person replaces them', async () => {
  const db = await fresh();
  await saveDraft('default', db, git, PATH, VALUES, undefined, 'u1');
  expect((await only(db))?.updatedBy).toBe('u1');

  await saveDraft('default', db, git, PATH, { ...VALUES, rooms: 4 }, undefined, 'u2');
  expect((await only(db))?.updatedBy).toBe('u2');
});

test('a save with nobody signed in leaves the line empty rather than wrong', async () => {
  const db = await fresh();
  await saveDraft('default', db, git, PATH, VALUES);

  expect((await only(db))?.updatedBy).toBe(null);
});

test('an autosave for a path that is not in the repo writes nothing', async () => {
  const db = await fresh();
  expect(await saveDraft('default', db, git, 'src/content/listings/en/gone.yaml', VALUES)).toBe(
    undefined,
  );
  expect(await only(db)).toBe(undefined);
});

// A read with no ref is the branch, which `lag` can hold behind the last publish.
function fakeRepo(files: Record<string, string>) {
  let head = 'commit-A';
  let n = 0;
  const behind: Record<string, string> = {};
  return {
    async getHead() {
      return head;
    },
    async getFile(path: string, ref?: string) {
      const contents = ref ? files[path] : (behind[path] ?? files[path]);
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
    /** What a read of the branch still answers: the API serves one from a cache under its name. */
    lag(path: string, contents: string) {
      behind[path] = contents;
    },
    read(path: string) {
      return files[path] ?? '';
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

test('publishing commits every pending draft in one commit and re-seeds those rows', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [OTHER]: OTHER_FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  await saveDraft('default', db, repo, OTHER, { title: 'The Barn', price: '£10', rooms: 2 });

  const result = await publishDrafts('default', db, repo);

  expect(repo.publish).toHaveBeenCalledTimes(1);
  expect(result?.paths.toSorted()).toEqual([OTHER, PATH].toSorted());
  // The rows stay, re-seeded on the commit; published means nothing is pending.
  expect(await pendingDrafts('default', db)).toEqual([]);
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
  expect(await pendingDrafts('default', db)).toEqual([]);
});

test('a new entry whose path someone else committed first is a conflict', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await createDraft('default', db, repo, NEW, { title: 'Strandhaus Nord', rooms: 0 });
  repo.write(NEW, 'title: "Theirs"\n');

  await expect(publishDrafts('default', db, repo)).rejects.toBeInstanceOf(DraftConflictError);
  expect(repo.publish).not.toHaveBeenCalled();
});

test('the conflict names the file that changed and counts them when there are several', () => {
  expect(new DraftConflictError([PATH]).message).toBe(
    'src/content/listings/en/mill-house.yaml changed in the repository after it was opened',
  );
  expect(new DraftConflictError([PATH, OTHER]).message).toBe(
    '2 files changed in the repository after they were opened — src/content/listings/en/mill-house.yaml, src/content/listings/en/barn.yaml',
  );
});

// The way out of a 409: the entry gives up its draft and is read from the repository again.
test('discarding the conflicted draft lets the rest of the set publish', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [OTHER]: OTHER_FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  await saveDraft('default', db, repo, OTHER, { title: 'The Barn', price: '£10', rooms: 2 });
  const theirs = FILE.replace('rooms: 3', 'rooms: 9');
  repo.write(PATH, theirs);
  await expect(publishDrafts('default', db, repo)).rejects.toBeInstanceOf(DraftConflictError);

  await discardDraft('default', db, PATH);
  const second = await publishDrafts('default', db, repo);

  expect(second?.paths).toEqual([OTHER]);
  // Nothing is left to overlay the file, and the file is still the one they pushed.
  expect(await loadDraft('default', db, PATH)).toBe(undefined);
  await expect(repo.getFile(PATH)).resolves.toMatchObject({ contents: theirs });
});

test('discarding a draft leaves nothing for the next publish to write back', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });

  await discardDraft('default', db, PATH);

  expect(await db.select().from(drafts)).toEqual([]);
  expect(await publishDrafts('default', db, repo)).toBe(undefined);
});

// The index as the last build made it: one build behind whatever a rename or delete commits.
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

// A rename is the last thing that happened to the entry, so it names the renamer.
test('a rename stamps who renamed onto the draft it carries over', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, title: 'The Old Mill' }, undefined, 'u1');

  await recordRename('default', db, PATH, RENAMED, FILE, 'commit-rename', 'u2');

  expect((await only(db))?.updatedBy).toBe('u2');
});

test('a delete takes the entry out of the list and leaves nothing to publish', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [OTHER]: OTHER_FILE });
  const index = indexOf({ [PATH]: FILE, [OTHER]: OTHER_FILE });

  await recordDelete('default', db, PATH, 'commit-delete');

  expect(await listed(db, index)).toEqual([['barn', 'The Barn']]);
  expect(await publishDrafts('default', db, repo)).toBe(undefined);
});

// The row carrying the file's own bytes waits for the build status, not for a title to agree.
test('the row a rename left at the old path is dropped by the build that catches up', async () => {
  const db = await fresh();
  await recordRename('default', db, PATH, RENAMED, FILE, 'commit-rename');

  const built = indexOf({ [RENAMED]: FILE });
  expect(await listed(db, built)).toEqual([['the-old-mill', 'The Mill House']]);
  expect((await db.select().from(drafts)).map((r) => r.path)).toEqual([RENAMED]);
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

// The structure is shared, so a block moved in English moves in German in the same write.
const REDIRECTS = 'src/content/redirects.yaml';
const PAGE_EN = 'src/content/pages/en/home.yaml';
const PAGE_DE = 'src/content/pages/de/home.yaml';
const page = (title: string, first: string, second: string) =>
  [
    '_version: 1',
    `title: "${title}"`,
    'blocks:',
    '  - _type: "hero"',
    '    _id: "k3nf9a2p"',
    `    heading: "${first}"`,
    '  - _type: "cta"',
    '    _id: "q1w2e3r4"',
    `    heading: "${second}"`,
    '',
  ].join('\n');
const PAGE_FORM: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    {
      path: ['blocks'],
      label: 'Blocks',
      type: 'blocks',
      required: true,
      types: ['hero', 'cta', 'quote'],
    },
  ],
  blocks: {
    hero: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
    cta: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
    quote: [{ path: ['body'], label: 'Body', type: 'text', required: true }],
  },
};
const SYNC = { form: PAGE_FORM, locale: 'en', siblings: { de: PAGE_DE } };
const block = (id: string) => ({ _type: id === 'k3nf9a2p' ? 'hero' : 'cta', _id: id });
const MOVED = {
  title: 'Home',
  blocks: [
    { ...block('q1w2e3r4'), heading: 'Ready to move?' },
    { ...block('k3nf9a2p'), heading: 'Move to the coast' },
  ],
};

test('moving a block writes every language of the entry in one write', async () => {
  const db = await fresh();
  const repo = fakeRepo({
    [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?'),
    [PAGE_DE]: page('Startseite', 'Zieh an die Küste', 'Bereit für den Umzug?'),
  });

  await saveDraft('default', db, repo, PAGE_EN, MOVED, SYNC);

  const rows = (await db.select().from(drafts)).toSorted((a, b) => a.path.localeCompare(b.path));
  expect(rows.map((r) => r.path)).toEqual([PAGE_DE, PAGE_EN]);
  expect(rows[0]?.contents).toBe(
    [
      '_version: 1',
      'title: "Startseite"',
      'blocks:',
      '  - _type: "cta"',
      '    _id: "q1w2e3r4"',
      '    heading: "Bereit für den Umzug?"',
      '  - _type: "hero"',
      '    _id: "k3nf9a2p"',
      '    heading: "Zieh an die Küste"',
      '',
    ].join('\n'),
  );
  expect(rows[0]?.updatedAt).toBe(rows[1]?.updatedAt);
  expect(rows[0]?.baseBlob).toBe(
    await blobSha(page('Startseite', 'Zieh an die Küste', 'Bereit für den Umzug?')),
  );
});

test('a save that changes no structure and no shared value leaves the other languages alone', async () => {
  const db = await fresh();
  const repo = fakeRepo({
    [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?'),
    [PAGE_DE]: page('Startseite', 'Zieh an die Küste', 'Bereit für den Umzug?'),
  });

  await saveDraft(
    'default',
    db,
    repo,
    PAGE_EN,
    { ...MOVED, blocks: MOVED.blocks.toReversed() },
    SYNC,
  );

  expect((await db.select().from(drafts)).map((r) => r.path)).toEqual([PAGE_EN]);
});

test('a language the entry does not have yet is not created by a save of another', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?') });

  await saveDraft('default', db, repo, PAGE_EN, MOVED, SYNC);

  expect((await db.select().from(drafts)).map((r) => r.path)).toEqual([PAGE_EN]);
});

test('a saved deletion can restore a sibling locale subtree in the same atomic save', async () => {
  const db = await fresh();
  const repo = fakeRepo({
    [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?'),
    [PAGE_DE]: page('Startseite', 'Zieh an die Küste', 'Bereit für den Umzug?'),
  });
  const deleted = await saveDraft(
    'default',
    db,
    repo,
    PAGE_EN,
    { title: 'Home', blocks: [MOVED.blocks[1]] },
    SYNC,
  );
  expect(deleted).toBeDefined();
  if (!deleted) throw new Error('Expected the deletion to save');

  const restored = await saveDraft(
    'default',
    db,
    repo,
    PAGE_EN,
    MOVED,
    {
      ...SYNC,
      restoration: {
        revisions: deleted.revisions,
        seeds: {
          de: [
            {
              address: 'blocks[_id=q1w2e3r4]',
              value: {
                _type: 'cta',
                _id: 'q1w2e3r4',
                heading: 'Bereit für den Umzug?',
                providerState: { restored: true },
              },
            },
          ],
        },
      },
    },
    undefined,
    deleted.revision,
  );

  const rows = (await db.select().from(drafts)).toSorted((a, b) => a.path.localeCompare(b.path));
  expect(rows.map((row) => row.path)).toEqual([PAGE_DE, PAGE_EN]);
  const germanRow = rows[0];
  if (!germanRow) throw new Error('Expected the German draft');
  expect(parseEntry('default', germanRow.contents)).toEqual({
    _version: 1,
    title: 'Startseite',
    blocks: [
      {
        _type: 'cta',
        _id: 'q1w2e3r4',
        heading: 'Bereit für den Umzug?',
        providerState: { restored: true },
      },
      { _type: 'hero', _id: 'k3nf9a2p', heading: 'Zieh an die Küste' },
    ],
  });
  expect(restored?.revisions).toEqual({ en: expect.any(String), de: expect.any(String) });
});

test('a stale sibling restoration revision rejects the complete locale batch', async () => {
  const db = await fresh();
  const repo = fakeRepo({
    [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?'),
    [PAGE_DE]: page('Startseite', 'Zieh an die Küste', 'Bereit für den Umzug?'),
  });
  const deleted = await saveDraft(
    'default',
    db,
    repo,
    PAGE_EN,
    { title: 'Home', blocks: [MOVED.blocks[1]] },
    SYNC,
  );
  expect(deleted).toBeDefined();
  if (!deleted) throw new Error('Expected the deletion to save');
  await saveDraft(
    'default',
    db,
    repo,
    PAGE_DE,
    { title: 'Neue Startseite', blocks: [{ ...MOVED.blocks[1], heading: 'Neue Küste' }] },
    { form: PAGE_FORM, locale: 'de', siblings: {}, translation: true },
    undefined,
    deleted.revisions.de,
  );
  const before = await db.select().from(drafts);

  await expect(
    saveDraft(
      'default',
      db,
      repo,
      PAGE_EN,
      MOVED,
      {
        ...SYNC,
        restoration: {
          revisions: deleted.revisions,
          seeds: {
            de: [
              {
                address: 'blocks[_id=q1w2e3r4]',
                value: { _type: 'cta', _id: 'q1w2e3r4', heading: 'Bereit für den Umzug?' },
              },
            ],
          },
        },
      },
      undefined,
      deleted.revision,
    ),
  ).rejects.toThrow('This entry changed while you were editing');
  expect(await db.select().from(drafts)).toEqual(before);
});

test('restoration revisions preserve the locale files captured by the client', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?') });
  const opened = await saveDraft('default', db, repo, PAGE_EN, MOVED, SYNC);
  expect(opened).toBeDefined();
  if (!opened) throw new Error('Expected the source draft to open');

  await expect(
    saveDraft(
      'default',
      db,
      repo,
      PAGE_EN,
      { ...MOVED, blocks: [...MOVED.blocks, { _type: 'quote', _id: 'new00001', body: 'Hi' }] },
      {
        ...SYNC,
        restoration: {
          revisions: { ...opened.revisions, de: 'missing-file' },
          seeds: {
            de: [
              {
                address: 'blocks[_id=new00001]',
                value: { _type: 'quote', _id: 'new00001', body: 'Hallo' },
              },
            ],
          },
        },
      },
      undefined,
      opened.revision,
    ),
  ).rejects.toThrow('This entry changed while you were editing');
  expect((await db.select().from(drafts)).map((row) => row.path)).toEqual([PAGE_EN]);
});

// A translation owns only its words; the rest is the file's (decap-cms#6978).
const LISTING_DE = 'src/content/listings/de/mill-house.yaml';
const DE_FORM: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['price'], label: 'Price', type: 'text', required: true, i18n: 'duplicate' },
    { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['hero', 'cta'] },
  ],
  blocks: PAGE_FORM.blocks,
};
const GERMAN = [
  '_version: 1',
  'title: "Das Mühlenhaus"',
  'price: "£950 per week"',
  'blocks:',
  '  - _type: "hero"',
  '    _id: "k3nf9a2p"',
  '    heading: "Zieh an die Küste"',
  '  - _type: "cta"',
  '    _id: "q1w2e3r4"',
  '    heading: "Bereit für den Umzug?"',
  '',
].join('\n');

test("a save of a translation writes that language's words and leaves the rest as it stands", async () => {
  const db = await fresh();
  const repo = fakeRepo({ [LISTING_DE]: GERMAN });

  await saveDraft(
    'default',
    db,
    repo,
    LISTING_DE,
    {
      title: 'Mühlenhaus am Bach',
      price: '£1 per week',
      notes: 'Nur auf Deutsch',
      blocks: [
        { ...block('q1w2e3r4'), heading: 'Bereit für den Umzug?' },
        { ...block('k3nf9a2p'), heading: 'Zieh ans Meer' },
      ],
    },
    { form: DE_FORM, locale: 'de', siblings: {}, translation: true },
  );

  expect((await only(db))?.contents).toBe(
    [
      '_version: 1',
      'title: "Mühlenhaus am Bach"',
      'price: "£950 per week"',
      'blocks:',
      '  - _type: "hero"',
      '    _id: "k3nf9a2p"',
      '    heading: "Zieh ans Meer"',
      '  - _type: "cta"',
      '    _id: "q1w2e3r4"',
      '    heading: "Bereit für den Umzug?"',
      '',
    ].join('\n'),
  );
});

test('publishing an entry commits the languages that moved with it in one commit', async () => {
  const db = await fresh();
  const repo = fakeRepo({
    [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?'),
    [PAGE_DE]: page('Startseite', 'Zieh an die Küste', 'Bereit für den Umzug?'),
  });
  await saveDraft('default', db, repo, PAGE_EN, MOVED, SYNC);

  const result = await publishDrafts('default', db, repo);

  expect(repo.publish).toHaveBeenCalledTimes(1);
  expect(result?.paths.toSorted()).toEqual([PAGE_DE, PAGE_EN]);
  expect(await pendingDrafts('default', db)).toEqual([]);
});

// `_i18n` is the publish writing down which English the German was translated from.
const sourceOf = async (path: string) =>
  path === PAGE_DE ? { locale: 'en', path: PAGE_EN, form: PAGE_FORM } : undefined;
const mark = (contents: string) =>
  (parseEntry('default', contents) as { _i18n?: Record<string, string> })._i18n;
const german = (heading: string) => ({
  title: 'Startseite',
  blocks: [
    { ...block('k3nf9a2p'), heading },
    { ...block('q1w2e3r4'), heading: 'Bereit für den Umzug?' },
  ],
});
const english = (heading: string) => ({
  title: 'Home',
  blocks: [
    { ...block('k3nf9a2p'), heading },
    { ...block('q1w2e3r4'), heading: 'Ready to move?' },
  ],
});
const bilingual = () =>
  fakeRepo({
    [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?'),
    [PAGE_DE]: page('Startseite', 'Zieh an die Küste', 'Bereit für den Umzug?'),
  });
const stale = (repo: ReturnType<typeof bilingual>) =>
  staleLocales('default', PAGE_FORM, {
    en: parseEntry('default', repo.read(PAGE_EN)),
    de: parseEntry('default', repo.read(PAGE_DE)),
  });

test('publishing a translation marks it with the source language as the commit leaves it', async () => {
  const db = await fresh();
  const repo = bilingual();
  await saveDraft('default', db, repo, PAGE_DE, german('Zieh an die Küste!'));

  await publishDrafts('default', db, repo, sourceOf);

  expect(mark(repo.read(PAGE_DE))).toEqual({
    sourceLocale: 'en',
    sourceBlob: await blobSha(repo.read(PAGE_EN)),
    sourceHash: expect.stringMatching(/^[0-9a-f]{16}$/),
    translatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
  });
  expect(mark(repo.read(PAGE_EN))).toBe(undefined);
  expect(await stale(repo)).toEqual([]);
});

test('publishing the source language on its own leaves its translations stale', async () => {
  const db = await fresh();
  const repo = bilingual();
  await saveDraft('default', db, repo, PAGE_DE, german('Zieh an die Küste!'));
  await publishDrafts('default', db, repo, sourceOf);

  await saveDraft('default', db, repo, PAGE_EN, english('Move to the water'), SYNC);
  await publishDrafts('default', db, repo, sourceOf);

  expect(await stale(repo)).toEqual(['de']);
});

test('a structural edit that carries the translation along does not clear it', async () => {
  const db = await fresh();
  const repo = bilingual();
  await saveDraft('default', db, repo, PAGE_DE, german('Zieh an die Küste!'));
  await publishDrafts('default', db, repo, sourceOf);
  await saveDraft('default', db, repo, PAGE_EN, english('Move to the water'), SYNC);
  await publishDrafts('default', db, repo, sourceOf);
  const marked = mark(repo.read(PAGE_DE));

  const moved = english('Move to the water');
  await saveDraft(
    'default',
    db,
    repo,
    PAGE_EN,
    { ...moved, blocks: moved.blocks.toReversed() },
    SYNC,
  );
  await publishDrafts('default', db, repo, sourceOf);

  expect(repo.read(PAGE_DE)).toContain('_type: "cta"\n    _id: "q1w2e3r4"');
  expect(mark(repo.read(PAGE_DE))).toEqual(marked);
  expect(await stale(repo)).toEqual(['de']);
});

// A drift answer moves a block between files, so every file it changes is written together.
const drifted = (title: string, blocks: string[]) =>
  ['_version: 1', `title: "${title}"`, 'blocks:', ...blocks, ''].join('\n');
const HERO = ['  - _type: "hero"', '    _id: "k3nf9a2p"', '    heading: "Hallo"'];
const QUOTE = ['  - _type: "quote"', '    _id: "z9y8x7w6"', '    body: "Ein seltener Fund."'];
const CTA = ['  - _type: "cta"', '    _id: "q1w2e3r4"', '    heading: "Los"'];
const PAGE_PATHS = { en: PAGE_EN, de: PAGE_DE };

test('answering drift writes every language the answer changes in one batch', async () => {
  const db = await fresh();
  const mark = ['    _locales:', '      - "de"'];
  const repo = fakeRepo({
    [PAGE_EN]: drifted('Home', [...HERO, ...CTA.slice(0, 2), ...mark, ...CTA.slice(2)]),
    [PAGE_DE]: drifted('Startseite', [...HERO, ...CTA.slice(0, 2), ...mark, ...CTA.slice(2)]),
  });

  await resolveDrift('default', db, repo, PAGE_FORM, ['en', 'de'], PAGE_PATHS, [
    { path: 'blocks[_id=q1w2e3r4]', locales: ['en', 'de'] },
  ]);

  const rows = (await db.select().from(drafts)).toSorted((a, b) => a.path.localeCompare(b.path));
  expect(rows.map((r) => r.path)).toEqual([PAGE_DE, PAGE_EN]);
  expect(rows[0]?.contents).toBe(drifted('Startseite', [...HERO, ...CTA]));
  expect(rows[1]?.contents).toBe(drifted('Home', [...HERO, ...CTA]));
  expect(rows[0]?.updatedAt).toBe(rows[1]?.updatedAt);
});

test('a drift answer stamps who answered on every file it writes', async () => {
  const db = await fresh();
  const mark = ['    _locales:', '      - "de"'];
  const repo = fakeRepo({
    [PAGE_EN]: drifted('Home', [...HERO, ...CTA.slice(0, 2), ...mark, ...CTA.slice(2)]),
    [PAGE_DE]: drifted('Startseite', [...HERO, ...CTA.slice(0, 2), ...mark, ...CTA.slice(2)]),
  });

  await resolveDrift(
    'default',
    db,
    repo,
    PAGE_FORM,
    ['en', 'de'],
    PAGE_PATHS,
    [{ path: 'blocks[_id=q1w2e3r4]', locales: ['en', 'de'] }],
    'u2',
  );

  expect((await db.select().from(drafts)).map((r) => r.updatedBy)).toEqual(['u2', 'u2']);
});

test('a language the answer leaves alone is not made pending by it', async () => {
  const db = await fresh();
  const repo = fakeRepo({
    [PAGE_EN]: drifted('Home', [...HERO, ...CTA]),
    [PAGE_DE]: drifted('Startseite', [...HERO, ...QUOTE, ...CTA]),
  });

  await resolveDrift('default', db, repo, PAGE_FORM, ['en', 'de'], PAGE_PATHS, [
    { path: 'blocks[_id=z9y8x7w6]', locales: ['de'] },
  ]);

  const rows = await db.select().from(drafts);
  expect(rows.map((r) => r.path)).toEqual([PAGE_DE]);
  expect(rows[0]?.contents).toBe(
    drifted('Startseite', [
      ...HERO,
      ...QUOTE.slice(0, 2),
      '    _locales:',
      '      - "de"',
      ...QUOTE.slice(2),
      ...CTA,
    ]),
  );
});

// A hand-written file has no `_version`; the next write owes it one (content-format.md F3).
test('answering drift stamps the version on the file the answer changes', async () => {
  const db = await fresh();
  const repo = fakeRepo({
    [PAGE_EN]: drifted('Home', [...HERO, ...CTA]).replace('_version: 1\n', ''),
    [PAGE_DE]: drifted('Startseite', [...HERO, ...QUOTE, ...CTA]).replace('_version: 1\n', ''),
  });

  await resolveDrift('default', db, repo, PAGE_FORM, ['en', 'de'], PAGE_PATHS, [
    { path: 'blocks[_id=z9y8x7w6]', locales: ['de'] },
  ]);

  const rows = await db.select().from(drafts);
  expect(rows.map((r) => r.path)).toEqual([PAGE_DE]);
  expect(rows[0]?.contents.startsWith('_version: 1\n')).toBe(true);
});

test('turning a language off stamps the version on a file that has none', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PAGE_EN]: page('Home', 'a', 'b').replace('_version: 1\n', '') });

  await setEntryLocales('default', db, repo, [PAGE_EN], ['en'], ['en', 'de']);

  expect((await only(db))?.contents).toBe(
    page('Home', 'a', 'b').replace('_version: 1\n', '_version: 1\n_locales:\n  - "en"\n'),
  );
});

// The site builds from git alone, so the language mark lives in the entry's files, not D1.
test('turning a language off marks every file the entry has with the ones it keeps', async () => {
  const db = await fresh();
  const repo = bilingual();

  await setEntryLocales('default', db, repo, [PAGE_EN, PAGE_DE], ['en', 'de'], ['en', 'de', 'fr']);

  const rows = (await db.select().from(drafts)).toSorted((a, b) => a.path.localeCompare(b.path));
  expect(rows.map((r) => r.path)).toEqual([PAGE_DE, PAGE_EN]);
  expect(rows[1]?.contents).toBe(
    page('Home', 'Move to the coast', 'Ready to move?').replace(
      '_version: 1\n',
      '_version: 1\n_locales:\n  - "en"\n  - "de"\n',
    ),
  );
  expect(rows[0]?.updatedAt).toBe(rows[1]?.updatedAt);
});

test('turning every language back on takes the mark out again', async () => {
  const db = await fresh();
  const repo = bilingual();
  await setEntryLocales('default', db, repo, [PAGE_EN], ['en'], ['en', 'de']);

  await setEntryLocales('default', db, repo, [PAGE_EN], ['en', 'de'], ['en', 'de']);

  expect((await only(db))?.contents).toBe(page('Home', 'Move to the coast', 'Ready to move?'));
});

// The draft takes the mark and rebases on the commit, or its publish turns the language back on.
test('a file rewritten by a commit carries the mark into the draft somebody had open', async () => {
  const db = await fresh();
  const repo = bilingual();
  await saveDraft('default', db, repo, PAGE_EN, {
    title: 'Home again',
    blocks: [
      { _type: 'hero', _id: 'k3nf9a2p', heading: 'Move to the coast' },
      { _type: 'cta', _id: 'q1w2e3r4', heading: 'Ready to move?' },
    ],
  });
  const committed = page('Home', 'Move to the coast', 'Ready to move?').replace(
    '_version: 1\n',
    '_version: 1\n_locales:\n  - "en"\n',
  );

  await recordOffer(
    'default',
    db,
    PAGE_EN,
    committed,
    { offered: ['en'], locales: ['en', 'de'], gone: ['de'] },
    'commit-Z',
  );

  const row = await only(db);
  expect(row?.contents).toBe(
    page('Home again', 'Move to the coast', 'Ready to move?').replace(
      '_version: 1\n',
      '_version: 1\n_locales:\n  - "en"\n',
    ),
  );
  expect(row?.baseSha).toBe('commit-Z');
  expect(row?.baseBlob).toBe(await blobSha(committed));
});

// A fill is neither a form's values nor the language's own words, so it is its own write.
test('a machine fill writes the values into the draft and names them in the file', async () => {
  const db = await fresh();
  const repo = bilingual();

  const saved = await saveTranslated('default', db, repo, PAGE_DE, {
    title: 'Zuhause',
    'blocks[_id=k3nf9a2p].heading': 'Zieh ans Meer',
  });

  const row = await only(db);
  expect(row?.path).toBe(PAGE_DE);
  expect(row?.contents).toBe(
    page('Zuhause', 'Zieh ans Meer', 'Bereit für den Umzug?').replace(
      '_version: 1\n',
      '_version: 1\n_machine:\n  - "title"\n  - "blocks[_id=k3nf9a2p].heading"\n',
    ),
  );
  expect(saved?.pending).toBe(true);
});

test('a fill of a language with no file writes nothing', async () => {
  const db = await fresh();

  expect(
    await saveTranslated('default', db, bilingual(), 'src/content/pages/fr/home.yaml', {
      title: 'Accueil',
    }),
  ).toBeUndefined();
  expect(await db.select().from(drafts)).toEqual([]);
});

// The redirect an address owes cannot be committed until the entry is published.
const REDIRECT = { from: '/de/home', to: '/de/startseite', entry: 'pages/home' };
// The address goes where the schema puts `slug`, not at the end of the file (F4 in 02-i18n.md).
const ADDRESSED: Form = {
  ...PAGE_FORM,
  fields: [
    { path: ['slug'], label: 'Address', type: 'text', required: false },
    ...PAGE_FORM.fields,
  ],
};

test('an address is written into that language alone, in schema order', async () => {
  const db = await fresh();
  const repo = bilingual();

  await setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, 'startseite', REDIRECT);

  const rows = await db.select().from(drafts);
  expect(rows.map((r) => r.path)).toEqual([PAGE_DE]);
  expect(rows[0]?.contents).toBe(
    page('Startseite', 'Zieh an die Küste', 'Bereit für den Umzug?').replace(
      '_version: 1\n',
      '_version: 1\nslug: "startseite"\n',
    ),
  );
});

test('an address change stamps who made it', async () => {
  const db = await fresh();
  const repo = bilingual();

  await setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, 'startseite', REDIRECT, 'u2');

  expect((await only(db))?.updatedBy).toBe('u2');
});

test('an address stamps the version on a file that has none', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PAGE_DE]: page('Startseite', 'a', 'b').replace('_version: 1\n', '') });

  await setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, 'startseite', undefined);

  expect((await only(db))?.contents).toBe(
    page('Startseite', 'a', 'b').replace('_version: 1\n', '_version: 1\nslug: "startseite"\n'),
  );
});

test('publishing an address change writes one redirect for that language', async () => {
  const db = await fresh();
  const repo = bilingual();
  await setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, 'startseite', REDIRECT);

  await publishDrafts('default', db, repo);

  const rules = (parseEntry('default', repo.read(REDIRECTS)) as { rules: RedirectRule[] }).rules;
  expect(rules).toEqual([
    {
      _id: expect.stringMatching(/^[0-9a-z]{8}$/),
      from: '/de/home',
      to: '/de/startseite',
      status: 301,
      reason: 'slug-change',
      entry: 'pages/home',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:]+Z$/),
    },
  ]);
});

test('an entry with no redirect to owe publishes redirects.yaml untouched', async () => {
  const db = await fresh();
  const repo = bilingual();

  await setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, 'startseite', undefined);
  await publishDrafts('default', db, repo);

  expect(repo.read(REDIRECTS)).toBe('');
});

// A redirect from a URL that never moved is a redirect forever, so the rule has to be gone.
test('an address put back the way it was owes nothing', async () => {
  const db = await fresh();
  const repo = bilingual();
  await setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, 'startseite', REDIRECT);

  await setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, '', undefined);
  await saveDraft('default', db, repo, PAGE_DE, german('Zieh ans Meer'));
  await publishDrafts('default', db, repo);

  expect(repo.read(REDIRECTS)).toBe('');
  expect(repo.read(PAGE_DE)).toBe(page('Startseite', 'Zieh ans Meer', 'Bereit für den Umzug?'));
});

const HIDE_DE = { from: '/de/home', to: '/de/pages' };
const HIDE_EN = { from: '/home', to: '/pages' };
const hidden = (contents: string) =>
  contents.replace('_version: 1\n', '_version: 1\n_status: "hidden"\n');
const ruleFor = async (db: ReturnType<typeof openDb>, path: string) =>
  (await db.select().from(drafts)).find((r) => r.path === path)?.pendingRedirects ?? [];

// `_status` is the entry's, not one language's, so every file carries it.
test('hiding an entry writes _status into every language it has', async () => {
  const db = await fresh();
  const repo = bilingual();

  await setEntryStatus(
    'default',
    db,
    repo,
    PAGE_FORM,
    [
      { path: PAGE_EN, redirect: HIDE_EN },
      { path: PAGE_DE, redirect: HIDE_DE },
    ],
    true,
  );

  const rows = (await db.select().from(drafts)).toSorted((a, b) => a.path.localeCompare(b.path));
  expect(rows.map((r) => r.path)).toEqual([PAGE_DE, PAGE_EN]);
  expect(rows[1]?.contents).toBe(hidden(page('Home', 'Move to the coast', 'Ready to move?')));
  expect(rows[0]?.contents).toBe(
    hidden(page('Startseite', 'Zieh an die Küste', 'Bereit für den Umzug?')),
  );
  expect(rows[0]?.pendingRedirects).toEqual([
    {
      _id: expect.stringMatching(/^[0-9a-z]{8}$/),
      from: '/de/home',
      to: '/de/pages',
      status: 301,
      reason: 'hidden',
      entry: 'pages/home',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:]+Z$/),
    },
  ]);
});

test('unhiding takes the key back out of every file', async () => {
  const db = await fresh();
  const repo = bilingual();
  await setEntryStatus(
    'default',
    db,
    repo,
    PAGE_FORM,
    [{ path: PAGE_EN }, { path: PAGE_DE }],
    true,
  );

  await setEntryStatus(
    'default',
    db,
    repo,
    PAGE_FORM,
    [{ path: PAGE_EN }, { path: PAGE_DE }],
    false,
  );

  const rows = await db.select().from(drafts);
  expect(rows.map((r) => r.contents).toSorted()).toEqual(
    [
      page('Home', 'Move to the coast', 'Ready to move?'),
      page('Startseite', 'Zieh an die Küste', 'Bereit für den Umzug?'),
    ].toSorted(),
  );
});

// The address moved and then the entry was hidden; each owes its own redirect.
test('hiding an entry keeps the redirect a moved address already owes', async () => {
  const db = await fresh();
  const repo = bilingual();
  await setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, 'startseite', REDIRECT);

  await setEntryStatus(
    'default',
    db,
    repo,
    ADDRESSED,
    [{ path: PAGE_DE, redirect: HIDE_DE }],
    true,
  );

  expect((await ruleFor(db, PAGE_DE)).map((r) => [r.reason, r.from, r.to])).toEqual([
    ['slug-change', '/de/home', '/de/startseite'],
    ['hidden', '/de/home', '/de/pages'],
  ]);
});

test('unhiding before the publish takes only the hide back out', async () => {
  const db = await fresh();
  const repo = bilingual();
  await setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, 'startseite', REDIRECT);
  await setEntryStatus(
    'default',
    db,
    repo,
    ADDRESSED,
    [{ path: PAGE_DE, redirect: HIDE_DE }],
    true,
  );

  await setEntryStatus('default', db, repo, ADDRESSED, [{ path: PAGE_DE }], false);

  expect((await ruleFor(db, PAGE_DE)).map((r) => r.reason)).toEqual(['slug-change']);
});

// The hide was published, so its rules are in the file; the unhide commit takes only those out.
test('publishing an unhide takes the committed hide rules out of redirects.yaml', async () => {
  const db = await fresh();
  const repo = bilingual();
  await setEntryStatus(
    'default',
    db,
    repo,
    PAGE_FORM,
    [
      { path: PAGE_EN, redirect: HIDE_EN },
      { path: PAGE_DE, redirect: HIDE_DE },
    ],
    true,
  );
  await publishDrafts('default', db, repo);
  const kept = (parseEntry('default', repo.read(REDIRECTS)) as { rules: RedirectRule[] }).rules;
  expect(kept).toHaveLength(2);

  await setEntryStatus(
    'default',
    db,
    repo,
    PAGE_FORM,
    [{ path: PAGE_EN }, { path: PAGE_DE }],
    false,
  );
  await publishDrafts('default', db, repo);

  expect((parseEntry('default', repo.read(REDIRECTS)) as { rules: RedirectRule[] }).rules).toEqual(
    [],
  );
  expect(repo.read(PAGE_EN)).toBe(page('Home', 'Move to the coast', 'Ready to move?'));
});

// The hide re-pointed an older rule at its target so nobody hops twice; the unhide points it back.
test('publishing an unhide points a rule the hide re-pointed back at the page', async () => {
  const db = await fresh();
  const repo = bilingual();
  const older = {
    _id: 'a1b2c3d4',
    from: '/old-home',
    to: '/home',
    status: 301 as const,
    reason: 'slug-change' as const,
    entry: 'pages/home',
    createdAt: '2026-08-01T09:00:00Z',
  };
  repo.write(REDIRECTS, stringifyEntry('default', { _version: 1, rules: [older] }));
  const rules = () =>
    (parseEntry('default', repo.read(REDIRECTS)) as { rules: RedirectRule[] }).rules;
  await setEntryStatus(
    'default',
    db,
    repo,
    PAGE_FORM,
    [
      { path: PAGE_EN, redirect: HIDE_EN },
      { path: PAGE_DE, redirect: HIDE_DE },
    ],
    true,
  );
  await publishDrafts('default', db, repo);
  expect(rules().find((r) => r._id === 'a1b2c3d4')?.to).toBe('/pages');

  await setEntryStatus(
    'default',
    db,
    repo,
    PAGE_FORM,
    [{ path: PAGE_EN }, { path: PAGE_DE }],
    false,
  );
  await publishDrafts('default', db, repo);

  expect(rules()).toEqual([older]);
});

// A hold is the entry's, the way a lock is, so it holds every language's file.
test('a publish leaves out every language of an entry somebody is holding back', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [LISTING_DE]: GERMAN, [OTHER]: OTHER_FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  await saveDraft('default', db, repo, LISTING_DE, { title: 'Mühlenhaus am Bach' });
  await saveDraft('default', db, repo, OTHER, { title: 'The Barn', price: '£10', rooms: 2 });

  await holdEntry('default', db, [PATH], 'u1');
  const result = await publishDrafts('default', db, repo);

  expect(result?.paths).toEqual([OTHER]);
  expect((await pendingDrafts('default', db)).map((r) => r.path).toSorted()).toEqual(
    [PATH, LISTING_DE].toSorted(),
  );
});

// A draft's `updated_at` is the last keystroke, so the hold's moment is stored beside who set it.
test('the held entries say when each hold was set', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });

  await holdEntry('default', db, [PATH], 'u1', 1755864000000);

  expect(await heldDrafts('default', db)).toEqual({
    'listings/mill-house': { id: 'u1', name: null, since: 1755864000000 },
  });
  await holdEntry('default', db, [PATH], null);
  expect((await db.select().from(drafts)).map((r) => r.heldAt)).toEqual([null]);
});

test('the same set publishes whole once the hold comes off', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [LISTING_DE]: GERMAN });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  await saveDraft('default', db, repo, LISTING_DE, { title: 'Mühlenhaus am Bach' });
  await holdEntry('default', db, [PATH], 'u1');

  await holdEntry('default', db, [PATH, LISTING_DE], null);
  const result = await publishDrafts('default', db, repo);

  expect(result?.paths.toSorted()).toEqual([PATH, LISTING_DE].toSorted());
});

// The unit of selection is the entry, never the file: its languages share a structure.
test('a chosen entry publishes its languages and leaves the rest waiting', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [LISTING_DE]: GERMAN, [OTHER]: OTHER_FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  await saveDraft('default', db, repo, LISTING_DE, { title: 'Mühlenhaus am Bach' });
  await saveDraft('default', db, repo, OTHER, { title: 'The Barn', price: '£10', rooms: 2 });

  const result = await publishDrafts('default', db, repo, undefined, ['listings/mill-house']);

  expect(result?.paths.toSorted()).toEqual([PATH, LISTING_DE].toSorted());
  expect((await pendingDrafts('default', db)).map((r) => r.path)).toEqual([OTHER]);
});

test('choosing an entry somebody is holding back publishes it and releases the hold', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [LISTING_DE]: GERMAN });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  await saveDraft('default', db, repo, LISTING_DE, { title: 'Mühlenhaus am Bach' });
  await holdEntry('default', db, [PATH, LISTING_DE], 'u1');

  const result = await publishDrafts('default', db, repo, undefined, ['listings/mill-house']);

  expect(result?.paths.toSorted()).toEqual([PATH, LISTING_DE].toSorted());
  expect(result?.released).toEqual(['listings/mill-house']);
  expect((await db.select().from(drafts)).map((r) => r.heldBy)).toEqual([null, null]);
});

test('the entries left out of a publish keep their redirect rules', async () => {
  const db = await fresh();
  const repo = bilingual();
  await setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, 'startseite', REDIRECT);

  const result = await publishDrafts('default', db, repo, undefined, ['pages/other']);

  expect(result).toBe(undefined);
  expect(repo.read(REDIRECTS)).toBe('');
  expect((await pendingDrafts('default', db)).map((r) => r.path)).toEqual([PAGE_DE]);
});

// A translation is stamped going into the commit, so the row is re-seeded from the marked bytes.
test('a published translation is re-seeded on the bytes the commit wrote', async () => {
  const db = await fresh();
  const repo = bilingual();
  await saveDraft('default', db, repo, PAGE_DE, german('Zieh an die Küste!'));

  const result = await publishDrafts('default', db, repo, sourceOf);

  const row = await only(db);
  expect(row?.contents).toBe(repo.read(PAGE_DE));
  expect(row?.baseBlob).toBe(await blobSha(repo.read(PAGE_DE)));
  expect(row?.baseSha).toBe(result?.commit_sha);
  expect(row?.publishedSha).toBe(result?.commit_sha);
  expect(await pendingDrafts('default', db)).toEqual([]);
});

// The row outlives the commit, so the rule it carried has to go or it is written twice.
test('an address change published once is not written a second time', async () => {
  const db = await fresh();
  const repo = bilingual();
  await setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, 'startseite', REDIRECT);
  await publishDrafts('default', db, repo);

  await saveDraft('default', db, repo, PAGE_DE, german('Zieh ans Meer'));
  await publishDrafts('default', db, repo);

  const rules = (parseEntry('default', repo.read(REDIRECTS)) as { rules: RedirectRule[] }).rules;
  expect(rules.map((r) => r.from)).toEqual(['/de/home']);
});

// The branch is served from a cache, so a base_sha taken beside a lagging blob would miss a commit.
test('a branch read that has not caught up cannot make a publish miss a commit', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  const theirs = FILE.replace('rooms: 3', 'rooms: 9');
  repo.write(PATH, theirs);
  repo.lag(PATH, FILE);

  await expect(publishDrafts('default', db, repo)).rejects.toBeInstanceOf(DraftConflictError);
  expect(repo.publish).not.toHaveBeenCalled();
  expect(repo.read(PATH)).toBe(theirs);
});

test('a draft records the base blob of the commit it recorded the base sha of', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  repo.lag(PATH, FILE.replace('rooms: 3', 'rooms: 1'));

  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });

  const row = await only(db);
  expect(row?.baseSha).toBe('commit-A');
  expect(row?.baseBlob).toBe(await blobSha(FILE));
  // And nothing is pending against a file nobody has: the publish that follows goes through.
  expect((await publishDrafts('default', db, repo))?.paths).toEqual([PATH]);
});

// An inverse reads the same path at three commits, so the fake above cannot stand in for one.
function fakeHistory(initial: Record<string, string>) {
  const trees: Record<string, Record<string, string>> = { 'commit-0': { ...initial } };
  const commits: Record<string, { parent?: string; message: string; paths: string[] }> = {};
  let head = 'commit-0';
  let n = 0;
  const commit = (
    list: { path: string; contents: string | null }[],
    base: string,
    message: string,
  ) => {
    const tree = { ...trees[base] };
    for (const f of list) {
      if (f.contents === null) delete tree[f.path];
      else tree[f.path] = f.contents;
    }
    head = `commit-${++n}`;
    trees[head] = tree;
    commits[head] = { parent: base, message, paths: list.map((f) => f.path) };
    return head;
  };
  return {
    async getHead() {
      return head;
    },
    async getFile(path: string, ref?: string) {
      const contents = trees[ref ?? head]?.[path];
      return contents === undefined ? undefined : { contents, blob_sha: await blobSha(contents) };
    },
    async getCommit(sha: string) {
      const found = commits[sha];
      if (!found) throw new Error(`no commit ${sha}`);
      return { sha, ...found };
    },
    publish: vi.fn(async (list, opts: { base_sha: string; message: string }) => ({
      commit_sha: commit(list, opts.base_sha, opts.message),
    })),
    /** A commit nobody here made: what moves a file on after a publish. */
    push(list: { path: string; contents: string | null }[]) {
      return commit(list, head, 'Someone else');
    },
    at(sha: string) {
      return trees[sha] ?? {};
    },
    now() {
      return trees[head] ?? {};
    },
  };
}

test('reverting a publish puts the files back and leaves the changes unpublished', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PATH]: FILE, [OTHER]: OTHER_FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  const published = await publishDrafts('default', db, repo);

  await logActivity('default', db, {
    kind: 'publish',
    subject: PATH,
    commitSha: published?.commit_sha,
    detail: { entries: ['listings/mill-house'] },
  });
  const result = await revertCommit('default', db, repo, published?.commit_sha ?? '');

  expect(repo.now()[PATH]).toBe(FILE);
  expect(result.paths).toEqual([PATH]);
  // The confirmation promises the changes stay: the row is in the drawer again, on the revert.
  const pending = await pendingDrafts('default', db);
  expect(pending.map((r) => r.path)).toEqual([PATH]);
  expect(pending[0]?.baseSha).toBe(result.commit_sha);
  expect(pending[0]?.contents).toBe(FILE.replace('rooms: 3', 'rooms: 4'));
});

test('reverting a publish that created a file removes it', async () => {
  const db = await fresh();
  const repo = fakeHistory({});
  await createDraft('default', db, repo, PATH, VALUES);
  const published = await publishDrafts('default', db, repo);

  await logActivity('default', db, {
    kind: 'publish',
    subject: PATH,
    commitSha: published?.commit_sha,
    detail: { entries: ['listings/mill-house'] },
  });
  await revertCommit('default', db, repo, published?.commit_sha ?? '');

  expect(repo.now()[PATH]).toBe(undefined);
  // Still pending, so publishing again writes the file back.
  expect((await pendingDrafts('default', db)).map((r) => r.path)).toEqual([PATH]);
});

test('reverting a rename brings the old name back and takes the new one away', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PATH]: FILE });
  const renamed = await repo.publish(
    [
      { path: PATH, contents: null },
      { path: RENAMED, contents: FILE },
    ],
    { base_sha: 'commit-0', message: 'Rename the Mill House' },
  );

  await logActivity('default', db, {
    kind: 'entry-rename',
    subject: PATH,
    commitSha: renamed?.commit_sha,
    detail: { entries: [entryKey(PATH) ?? '', entryKey(RENAMED) ?? ''] },
  });
  await revertCommit('default', db, repo, renamed.commit_sha);

  expect(repo.now()[PATH]).toBe(FILE);
  expect(repo.now()[RENAMED]).toBe(undefined);
});

test('reverting is refused when a file has changed since that commit', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  const published = await publishDrafts('default', db, repo);
  repo.push([{ path: PATH, contents: `${FILE}note: "hand edited"\n` }]);
  const before = repo.now()[PATH];

  await logActivity('default', db, {
    kind: 'publish',
    subject: PATH,
    commitSha: published?.commit_sha,
    detail: { entries: ['listings/mill-house'] },
  });
  await expect(revertCommit('default', db, repo, published?.commit_sha ?? '')).rejects.toThrow(
    new RevertConflictError([PATH]),
  );
  expect(repo.now()[PATH]).toBe(before);
});

// The trees API has no three-way merge, so the inverse of an append is composed.
test('reverting recomputes redirects.yaml rather than restoring it', async () => {
  const db = await fresh();
  const REDIRECTS = 'src/content/redirects.yaml';
  const rules = (...ids: string[]) =>
    `_version: 1\nrules:\n${ids
      .map((id) => `  - _id: "${id}"\n    from: "/${id}"\n    to: "/new-${id}"\n`)
      .join('')}`;
  const [one, two, three] = ['aaaa1111', 'bbbb2222', 'cccc3333'];
  const repo = fakeHistory({ [REDIRECTS]: rules(one) });
  const published = await repo.publish([{ path: REDIRECTS, contents: rules(one, two) }], {
    base_sha: 'commit-0',
    message: 'Update prices',
  });
  repo.push([{ path: REDIRECTS, contents: rules(one, two, three) }]);

  await logActivity('default', db, {
    kind: 'redirect-added',
    subject: PATH,
    commitSha: published?.commit_sha,
    detail: {},
  });
  await revertCommit('default', db, repo, published.commit_sha);

  const left = repo.now()[REDIRECTS] ?? '';
  expect(left).toContain(one);
  expect(left).toContain(three);
  expect(left).not.toContain(two);
});

// A restore that touched git alone would leave the open draft saying German is off.
const MILL_DE = 'src/content/listings/de/mill-house.yaml';
const MILL_DE_FILE = '_version: 1\ntitle: "Die Muehle"\nprice: "950 GBP pro Woche"\nrooms: 3\n';
const OFFER = { offered: ['en'], locales: ['en', 'de'], gone: ['de'] };
const withoutGerman = (contents: string) =>
  stringifyEntry('default', offeredEntry('default', parseEntry('default', contents), OFFER));

test('restoring a turn-off re-offers the language in the draft that was open', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PATH]: FILE, [MILL_DE]: MILL_DE_FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  // What `offering` commits and then records: the German file gone, the English one marked.
  const kept = withoutGerman(FILE);
  const off = await repo.publish(
    [
      { path: MILL_DE, contents: null },
      { path: PATH, contents: kept },
    ],
    { base_sha: 'commit-0', message: 'Turn off de for listings/mill-house' },
  );
  await recordDelete('default', db, MILL_DE, off.commit_sha);
  await recordOffer('default', db, PATH, kept, OFFER, off.commit_sha);

  await logActivity('default', db, {
    kind: 'locale-off',
    subject: PATH,
    commitSha: off?.commit_sha,
    detail: { entries: ['listings/mill-house'] },
  });
  await restoreCommit('default', db, repo, off.commit_sha);

  const row = (await db.select().from(drafts)).find((r) => r.path === PATH);
  const entry = parseEntry('default', row?.contents ?? '') as Record<string, unknown>;
  // Absent is what says every language is offered, so the mark goes rather than being rewritten.
  expect(entry._locales).toBe(undefined);
  expect(entry.rooms).toBe(4);
});

// F15: a file put back before the build settles the delete row would stay hidden for good.
test('restoring a delete takes away the row that was hiding the path', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PATH]: FILE });
  const index = indexOf({ [PATH]: FILE });
  const deleted = await repo.publish([{ path: PATH, contents: null }], {
    base_sha: 'commit-0',
    message: 'Delete listings/mill-house',
  });
  await recordDelete('default', db, PATH, deleted.commit_sha);
  expect(await listed(db, index)).toEqual([]);

  await logActivity('default', db, {
    kind: 'entry-delete',
    subject: PATH,
    commitSha: deleted?.commit_sha,
    detail: { entries: ['listings/mill-house'] },
  });
  await restoreCommit('default', db, repo, deleted.commit_sha);

  expect(repo.now()[PATH]).toBe(FILE);
  expect(await only(db)).toBe(undefined);
  expect(await listed(db, index)).toEqual([['mill-house', 'The Mill House']]);
});

test('a published row is cleared once the build carrying it is live', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  const published = await publishDrafts('default', db, repo);

  expect(await clearPublished('default', db, published?.commit_sha ?? '')).toEqual([PATH]);
  expect(await only(db)).toBe(undefined);
});

// The row is also what an open tab publishes against, so green alone does not clear it.
test('a published row whose entry somebody is editing is kept', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  const published = await publishDrafts('default', db, repo);
  await claimLock('default', db, 'listings/mill-house', 'anna', 'tab');

  expect(await clearPublished('default', db, published?.commit_sha ?? '')).toEqual([]);
  expect((await only(db))?.path).toBe(PATH);
});

// Dropping it here would let the deleted entry reappear before the new bundle is serving.
test('a row that says a path has gone is not cleared by the build going live', async () => {
  const db = await fresh();
  await recordDelete('default', db, PATH, 'commit-9');

  expect(await clearPublished('default', db, 'commit-9')).toEqual([]);
  expect((await only(db))?.path).toBe(PATH);
});

// The report is `resolve.ts`'s; proven here is reading the three sides and the row left behind.
const PAGE_FILES = { en: PAGE_EN };

test('a file the repository moved under a draft is one question and one merged change', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?') });
  await saveDraft('default', db, repo, PAGE_EN, {
    title: 'Home again',
    blocks: [
      { _type: 'hero', _id: 'k3nf9a2p', heading: 'Move to the coast' },
      { _type: 'cta', _id: 'q1w2e3r4', heading: 'Ready to move?' },
    ],
  });
  repo.push([{ path: PAGE_EN, contents: page('Homepage', 'Move to the sea', 'Ready to move?') }]);

  const conflict = await entryConflict('default', db, repo, PAGE_FORM, PAGE_FILES);

  expect(conflict?.questions.map((q) => [q.path, q.base])).toEqual([['title', 'Home']]);
  expect(conflict?.merged.map((m) => [m.label, m.side])).toEqual([
    ['Move to the sea · Heading', 'theirs'],
  ]);
  expect(Object.keys(conflict?.conflicted ?? {})).toEqual(['en']);
});

test('an entry the repository has not moved has nothing to resolve', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?') });
  await saveDraft('default', db, repo, PAGE_EN, {
    title: 'Home again',
    blocks: [
      { _type: 'hero', _id: 'k3nf9a2p', heading: 'Move to the coast' },
      { _type: 'cta', _id: 'q1w2e3r4', heading: 'Ready to move?' },
    ],
  });

  expect(await entryConflict('default', db, repo, PAGE_FORM, PAGE_FILES)).toBe(undefined);
});

// Seeded from the merge, the row would read as published and leave the drawer uncommitted.
test('answering a conflict rebases the row on the file at HEAD and keeps it pending', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?') });
  await saveDraft('default', db, repo, PAGE_EN, {
    title: 'Home again',
    blocks: [
      { _type: 'hero', _id: 'k3nf9a2p', heading: 'Move to the coast' },
      { _type: 'cta', _id: 'q1w2e3r4', heading: 'Ready to move?' },
    ],
  });
  const theirs = page('Homepage', 'Move to the sea', 'Ready to move?');
  const head = repo.push([{ path: PAGE_EN, contents: theirs }]);

  const conflict = await entryConflict('default', db, repo, PAGE_FORM, PAGE_FILES);
  if (!conflict) throw new Error('the push above is what makes this a conflict');
  await resolveConflict('default', db, PAGE_FORM, conflict, [
    { path: 'title', locale: 'en', side: 'ours' },
  ]);

  const row = await only(db);
  expect(row?.contents).toBe(page('Home again', 'Move to the sea', 'Ready to move?'));
  expect(row?.baseSha).toBe(head);
  expect(row?.baseBlob).toBe(await blobSha(theirs));
  expect((await pendingDrafts('default', db)).map((r) => r.path)).toEqual([PAGE_EN]);
});

test('taking theirs everywhere leaves a row the drawer no longer has anything to publish for', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?') });
  await saveDraft('default', db, repo, PAGE_EN, {
    title: 'Home again',
    blocks: [
      { _type: 'hero', _id: 'k3nf9a2p', heading: 'Move to the coast' },
      { _type: 'cta', _id: 'q1w2e3r4', heading: 'Ready to move?' },
    ],
  });
  const theirs = page('Homepage', 'Move to the coast', 'Ready to move?');
  repo.push([{ path: PAGE_EN, contents: theirs }]);

  const conflict = await entryConflict('default', db, repo, PAGE_FORM, PAGE_FILES);
  if (!conflict) throw new Error('the push above is what makes this a conflict');
  await resolveConflict('default', db, PAGE_FORM, conflict, [
    { path: 'title', locale: 'en', side: 'theirs' },
  ]);

  expect((await only(db))?.contents).toBe(theirs);
  expect(await pendingDrafts('default', db)).toEqual([]);
});

// Preview takes the rows as they stand: a settled row is still what the editor last saw.
test('the draft files are every row as it stands, published ones included', async () => {
  const db = await fresh();
  await saveDraft('default', db, git, PATH, VALUES);
  await db.insert(drafts).values({
    siteId: 'default',
    path: OTHER,
    contents: '',
    baseSha: 'commit-A',
    baseBlob: await blobSha(OTHER_FILE),
    updatedAt: 1,
    publishedSha: 'commit-B',
  });

  const files = (await draftFiles('default', db)).sort((a, b) => a.path.localeCompare(b.path));
  expect(files).toEqual([
    { path: OTHER, contents: '' },
    { path: PATH, contents: expect.stringContaining('The Mill House') },
  ]);
});

// Git and D1 share no transaction, so a rename killed mid-way leaves a row the tree lacks.
const ORPHAN = 'src/content/listings/en/gone.yaml';
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1755864000000;
const orphanRow = (path: string, extra: Record<string, unknown> = {}) => ({
  siteId: 'default',
  path,
  contents: 'title: "Gone"\n',
  baseSha: 'commit-A',
  baseBlob: 'blob-of-the-file-that-was-there',
  updatedAt: NOW - DAY - 1,
  ...extra,
});
const paths = async (db: ReturnType<typeof openDb>) =>
  (await db.select().from(drafts)).map((r) => r.path).sort();

test('a draft row whose file the tree no longer has is swept', async () => {
  const db = await fresh();
  await db.insert(drafts).values(orphanRow(ORPHAN));

  expect(await sweepOrphans('default', db, git, NOW)).toBe(1);
  expect(await paths(db)).toEqual([]);
});

// The normal state of every entry before its first publish: a draft and nothing in git.
test('an entry that has never been published keeps its draft', async () => {
  const db = await fresh();
  await createDraft('default', db, git, ORPHAN, { title: 'Gone' });
  await db.update(drafts).set({ updatedAt: NOW - DAY - 1 });

  expect(await sweepOrphans('default', db, git, NOW)).toBe(0);
  expect(await paths(db)).toEqual([ORPHAN]);
});

// Sweeping the row a delete leaves would put the deleted entry back on the screen.
test('the row a delete left to keep the path off the list stays', async () => {
  const db = await fresh();
  await recordDelete('default', db, ORPHAN, 'commit-B');
  await db.update(drafts).set({ updatedAt: NOW - DAY - 1 });

  expect(await sweepOrphans('default', db, git, NOW)).toBe(0);
  expect(await paths(db)).toEqual([ORPHAN]);
});

test('a draft left open for a week whose file is still there stays', async () => {
  const db = await fresh();
  await db.insert(drafts).values(orphanRow(PATH, { updatedAt: NOW - 7 * DAY }));

  expect(await sweepOrphans('default', db, git, NOW)).toBe(0);
  expect(await paths(db)).toEqual([PATH]);
});

// The age keeps the sweep off a rename that is between its commit and its re-key right now.
test('a row younger than a day is left alone', async () => {
  const db = await fresh();
  await db.insert(drafts).values(orphanRow(ORPHAN, { updatedAt: NOW - DAY + 1000 }));

  expect(await sweepOrphans('default', db, git, NOW)).toBe(0);
  expect(await paths(db)).toEqual([ORPHAN]);
});

// Not testing: reading the version out of GitHub, which is the route's.
const VERSION_FORM: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['price'], label: 'Price', type: 'text', required: false },
    { path: ['rooms'], label: 'Rooms', type: 'number', required: true },
  ],
  blocks: {},
};
const PATH_DE = 'src/content/listings/de/mill-house.yaml';
const FILE_DE = '_version: 1\n_status: "hidden"\ntitle: "Das Mühlenhaus"\nrooms: 3\n';
const OLD_EN = { _version: 1, title: 'The Mill House', price: '£800 per week', rooms: 2 };
const OLD_DE = { _version: 1, title: 'Das Muehlenhaus', rooms: 2 };

test('restoring a version writes its bytes as the draft of every language it has', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [PATH_DE]: FILE_DE });

  const { paths } = await restoreDraft('default', db, repo, VERSION_FORM, [
    { path: PATH, entry: OLD_EN },
    { path: PATH_DE, entry: OLD_DE },
  ]);

  expect(paths.toSorted()).toEqual([PATH_DE, PATH].toSorted());
  const row = (await db.select().from(drafts)).find((r) => r.path === PATH);
  expect(row?.contents).toBe(
    '_version: 1\n_status: "hidden"\ntitle: "The Mill House"\nprice: "£800 per week"\nrooms: 2\n',
  );
});

test('a restore stamps who restored on every language it writes', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [PATH_DE]: FILE_DE });

  await restoreDraft(
    'default',
    db,
    repo,
    VERSION_FORM,
    [
      { path: PATH, entry: OLD_EN },
      { path: PATH_DE, entry: OLD_DE },
    ],
    'u2',
  );

  expect((await db.select().from(drafts)).map((r) => r.updatedBy)).toEqual(['u2', 'u2']);
});

// An old `slug`, `_status` or `_locales` would owe redirect rules a draft write cannot make.
test('a restore keeps the address, the status and the languages the entry has now', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });

  await restoreDraft('default', db, repo, VERSION_FORM, [
    { path: PATH, entry: { ...OLD_EN, slug: 'the-mill', _status: 'live', _locales: ['en'] } },
  ]);

  const entry = parseEntry('default', (await only(db))?.contents ?? '') as Record<string, unknown>;
  expect(entry._status).toBe('hidden');
  expect(entry.slug).toBe(undefined);
  expect(entry._locales).toBe(undefined);
});

// The row keeps the base the file has now, so the commit goes on top of HEAD.
test('publishing a restored version is an ordinary forward commit', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });

  await restoreDraft('default', db, repo, VERSION_FORM, [{ path: PATH, entry: OLD_EN }]);
  const published = await publishDrafts('default', db, repo);

  expect(published?.paths).toEqual([PATH]);
  expect(repo.read(PATH)).toContain('rooms: 2');
});

// The restore makes the drift the editor is asked about before publish; nothing here refuses.
test('restoring one language across a structural change leaves the languages in drift', async () => {
  const db = await fresh();
  const repo = fakeRepo({
    [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?'),
    [PAGE_DE]: page('Startseite', 'Zieh an die Küste', 'Bereit für den Umzug?'),
  });
  const oneBlock = {
    _version: 1,
    title: 'Home',
    blocks: [{ _type: 'hero', _id: 'k3nf9a2p', heading: 'Move to the coast' }],
  };

  await restoreDraft('default', db, repo, PAGE_FORM, [{ path: PAGE_EN, entry: oneBlock }]);

  const rows = await db.select().from(drafts);
  const files = {
    en: parseEntry('default', rows.find((r) => r.path === PAGE_EN)?.contents ?? ''),
    de: parseEntry('default', repo.read(PAGE_DE)),
  };
  expect(driftReport('default', PAGE_FORM, files).map((d) => d.path)).toEqual([
    'blocks[_id=q1w2e3r4]',
  ]);
});

// Recreating the path would skip the rules Create from English and a turn-on commit.
test('a language whose file has gone since is not brought back', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });

  const { paths } = await restoreDraft('default', db, repo, VERSION_FORM, [
    { path: PATH, entry: OLD_EN },
    { path: PATH_DE, entry: OLD_DE },
  ]);

  expect(paths).toEqual([PATH]);
});

// One join, not the member list: the feature doc forbids the dashboard a scan.
test('who typed each draft is read path by path, and a row nobody signed for is left out', async () => {
  const db = await fresh();
  await binding
    .prepare(
      `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
       VALUES ('u1', 'Anna Berg', 'anna@example.com', 1, 'editor', 0, 0)`,
    )
    .run();
  const repo = fakeRepo({ [PATH]: FILE, [OTHER]: OTHER_FILE });
  await saveDraft('default', db, repo, PATH, VALUES, undefined, 'u1');
  await saveDraft('default', db, repo, OTHER, { title: 'The Barn', rooms: 2 });

  expect(await draftEditors('default', db)).toEqual({ [PATH]: 'Anna Berg' });
});

/** Pause a real D1 read after it completes; subsequent SQL still runs against the same DB. */
function afterRead(match: (query: string) => boolean, work: () => Promise<void>) {
  let waiting = true;
  const wrapped = new Proxy(binding, {
    get(target, key) {
      if (key !== 'prepare') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (query: string) => {
        const wrap = (
          statement: ReturnType<typeof binding.prepare>,
        ): ReturnType<typeof binding.prepare> =>
          new Proxy(statement, {
            get(stmt, method) {
              if (method === 'bind') return (...args: unknown[]) => wrap(stmt.bind(...args));
              const value = Reflect.get(stmt, method, stmt);
              if (typeof value !== 'function') return value;
              return async (...args: unknown[]) => {
                const result = await value.apply(stmt, args);
                if (waiting && match(query) && (method === 'raw' || method === 'all')) {
                  waiting = false;
                  await work();
                }
                return result;
              };
            },
          });
        return wrap(target.prepare(query));
      };
    },
  });
  return openDb('default', wrapped);
}

test('cleanup rechecks the revision when a newer save arrives after selecting candidates', async () => {
  const db = await fresh(),
    repo = fakeHistory({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  const published = await publishDrafts('default', db, repo);
  const raced = afterRead(
    (q) => q.includes('from "locks"'),
    async () => {
      await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 5 });
    },
  );
  await clearPublished('default', raced, published?.commit_sha ?? '');
  expect((await loadDraft('default', db, PATH))?.contents).toContain('rooms: 5');
  expect((await loadDraft('default', db, PATH))?.publishedSha).toBeNull();
});

test('cleanup rechecks a lock acquired after its lock read', async () => {
  const db = await fresh(),
    repo = fakeHistory({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  const published = await publishDrafts('default', db, repo);
  const raced = afterRead(
    (q) => q.includes('from "locks"'),
    async () => {
      await claimLock('default', db, 'listings/mill-house', 'editing', 'tab');
    },
  );
  await clearPublished('default', raced, published?.commit_sha ?? '');
  expect(await loadDraft('default', db, PATH)).toBeDefined();
  await db.delete(tables.locks);
});

test('overlay cleanup cannot delete a recreated entry after reading its deletion marker', async () => {
  const db = await fresh();
  await recordDelete('default', db, PATH, 'removed');
  const raced = afterRead(
    (q) => q.includes('from "drafts"'),
    async () => {
      await createDraft('default', db, git, PATH, { title: 'Recreated' });
    },
  );
  await overlayRows('default', raced, indexOf({}));
  expect((await loadDraft('default', db, PATH))?.contents).toContain('Recreated');
});

test('a stale source save rolls back its sibling changes as one batch', async () => {
  const db = await fresh(),
    repo = fakeHistory({ [PATH]: FILE, [LISTING_DE]: MILL_DE_FILE });
  await saveDraft('default', db, repo, PATH, VALUES);
  const revision = (await loadDraft('default', db, PATH))?.revision;
  // Two writers read the same source; their shared price also changes the other language.
  const results = await Promise.allSettled([
    saveDraft(
      'default',
      db,
      repo,
      PATH,
      { ...VALUES, price: 'One' },
      { form: DE_FORM, locale: 'en', siblings: { de: LISTING_DE } },
      undefined,
      revision,
    ),
    saveDraft(
      'default',
      db,
      repo,
      PATH,
      { ...VALUES, price: 'Two' },
      { form: DE_FORM, locale: 'en', siblings: { de: LISTING_DE } },
      undefined,
      revision,
    ),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const en = parseEntry('default', (await loadDraft('default', db, PATH))?.contents ?? '') as {
    price: string;
  };
  const de = parseEntry(
    'default',
    (await loadDraft('default', db, LISTING_DE))?.contents ?? '',
  ) as {
    price: string;
  };
  expect(de.price).toBe(en.price);
});

test('rename reservations exclude creations in every destination locale and release on request', async () => {
  const { reservePaths, releasePaths } = await import('./db.js');
  const db = await fresh();
  const paths = [PATH, LISTING_DE];
  const reservation = await reservePaths('default', db, paths);
  for (const path of paths)
    await expect(createDraft('default', db, git, path, { title: 'Taken' })).rejects.toThrow();
  expect(await db.select().from(drafts)).toEqual([]);
  await releasePaths('default', db, reservation);
  await createDraft('default', db, git, PATH, { title: 'Allowed' });
  await expect(reservePaths('default', db, paths)).rejects.toThrow();
  expect(await db.select().from(tables.pathReservations)).toEqual([]);
  expect((await loadDraft('default', db, PATH))?.contents).toContain('Allowed');
});

test('a new multi-language entry claims all paths or leaves every path untouched', async () => {
  const { createDrafts } = await import('./db.js');
  const db = await fresh();
  await createDraft('default', db, git, LISTING_DE, { title: 'Existing German' });
  await expect(
    createDrafts('default', db, git, [
      { path: PATH, values: { title: 'New English' } },
      { path: LISTING_DE, values: { title: 'New German' } },
    ]),
  ).rejects.toThrow();
  expect(await loadDraft('default', db, PATH)).toBeUndefined();
  expect((await loadDraft('default', db, LISTING_DE))?.contents).toContain('Existing German');
});

test.each(['hide-move', 'move-hide', 'hide-clear'])(
  'pending hide redirects survive address changes: %s',
  async (order) => {
    const db = await fresh();
    const repo = bilingual();
    const hide = () =>
      setEntryStatus('default', db, repo, ADDRESSED, [{ path: PAGE_DE, redirect: HIDE_DE }], true);
    const move = () =>
      setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, 'startseite', REDIRECT);
    if (order === 'move-hide') {
      await move();
      await hide();
    } else {
      await hide();
      await move();
    }
    if (order === 'hide-clear')
      await setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, '', undefined);
    expect(await ruleFor(db, PAGE_DE)).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'hidden', ...HIDE_DE })]),
    );
    await publishDrafts('default', db, repo);
    const rules = (parseEntry('default', repo.read(REDIRECTS)) as { rules: RedirectRule[] }).rules;
    expect(rules.map(({ from, to }) => ({ from, to }))).toEqual([HIDE_DE]);
  },
);

test('a sibling change after reading a conflict aborts the complete resolution batch', async () => {
  const db = await fresh();
  const sibling = PAGE_EN.replace('/en/', '/de/');
  const original = page('Home', 'Hero', 'CTA');
  const repo = fakeHistory({ [PAGE_EN]: original, [sibling]: original });
  await saveDraft('default', db, repo, PAGE_EN, { title: 'Ours' });
  await saveDraft('default', db, repo, sibling, { title: 'German' });
  repo.push([{ path: PAGE_EN, contents: page('Theirs', 'Hero', 'CTA') }]);
  const report = await entryConflict('default', db, repo, PAGE_FORM, { en: PAGE_EN, de: sibling });
  if (!report) throw new Error('Expected a conflict');
  await saveDraft('default', db, repo, sibling, { title: 'New German' });
  const before = await draftFiles('default', db);
  await expect(
    resolveConflict(
      'default',
      db,
      PAGE_FORM,
      report,
      report.questions.map((q) => ({ path: q.path, locale: q.locale, side: 'theirs' })),
    ),
  ).rejects.toThrow();
  expect(await draftFiles('default', db)).toEqual(before);
});
