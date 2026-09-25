import type { Miniflare } from 'miniflare';
import { beforeAll, expect, test } from 'vitest';
import type { RedirectRule } from '../content/redirects.js';
import {
  afterRead,
  bilingual,
  draftDb,
  FILE,
  fakeRepo,
  git,
  indexOf,
  listed,
  migrateTestD1,
  newTestD1,
  OTHER,
  OTHER_FILE,
  only,
  PAGE_EN,
  PATH,
  page,
  RENAMED,
  VALUES,
} from '../db.fixture.js';
import type { openDb } from '../db.js';
import { blobSha } from '../publishing/git.js';
import { publishDrafts } from '../publishing/publish.js';
import { drafts } from '../tables.js';
import {
  draftFiles,
  overlayRows,
  recordDelete,
  recordOffer,
  recordRenames,
  sweepOrphans,
} from './committed.js';
import { createDraft, loadDraft, pendingDrafts, saveDraft } from './drafts.js';
import { claimLock } from './locks.js';

const mf = newTestD1();
let binding: Awaited<ReturnType<Miniflare['getD1Database']>>;
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  await migrateTestD1(binding);
});
const fresh = draftDb(() => binding);

test('a rename shows the new name in the list before the build that carries it', async () => {
  const db = await fresh();
  const index = indexOf({ [PATH]: FILE, [OTHER]: OTHER_FILE });

  await recordRenames(
    'default',
    db,
    [{ from: PATH, to: RENAMED, contents: FILE }],
    'commit-rename',
  );

  expect(await listed(db, index)).toEqual([
    ['barn', 'The Barn'],
    ['the-old-mill', 'The Mill House'],
  ]);
});

test('a rename carries the unpublished edits rather than the committed bytes', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, title: 'The Old Mill' });

  await recordRenames(
    'default',
    db,
    [{ from: PATH, to: RENAMED, contents: FILE }],
    'commit-rename',
  );

  expect(await listed(db, indexOf({ [PATH]: FILE }))).toEqual([['the-old-mill', 'The Old Mill']]);
  const [row] = await pendingDrafts('default', db);
  expect(row?.path).toBe(RENAMED);
  expect(row?.baseSha).toBe('commit-rename');
  // The rename commit moved the loaded bytes untouched, so the base blob still describes them.
  expect(row?.baseBlob).toBe(await blobSha(FILE));
});

test('one rename batch moves repository, edited, and draft-only locales without reviving deletions', async () => {
  const db = await fresh();
  const de = 'src/content/listings/de/mill-house.yaml';
  const deTo = 'src/content/listings/de/the-old-mill.yaml';
  const deFile = '_version: 1\ntitle: "Das Muehlenhaus"\n';
  const fr = 'src/content/listings/fr/mill-house.yaml';
  const frTo = 'src/content/listings/fr/the-old-mill.yaml';
  const it = 'src/content/listings/it/mill-house.yaml';
  const itTo = 'src/content/listings/it/the-old-mill.yaml';
  const redirect: RedirectRule = {
    _id: 'aaaaaaaa',
    from: '/de/alte-muehle',
    to: '/de/mill-house',
    status: 301,
    reason: 'slug-change',
    createdAt: '2026-09-10T12:00:00Z',
  };
  await db.insert(drafts).values([
    {
      siteId: 'default',
      path: de,
      revision: 'de-revision',
      contents: '_version: 1\ntitle: "Bearbeitete Muehle"\n',
      baseSha: 'commit-old',
      baseBlob: await blobSha(deFile),
      updatedAt: 10,
      heldBy: 'anna',
      heldAt: 9,
      pendingRedirects: [redirect],
    },
    {
      siteId: 'default',
      path: fr,
      revision: 'fr-revision',
      contents: '_version: 1\n_i18n:\n  sourceLocale: "en"\ntitle: "Moulin"\n',
      baseSha: 'commit-old',
      baseBlob: '',
      updatedAt: 20,
    },
    {
      siteId: 'default',
      path: it,
      revision: 'it-deleted',
      contents: '',
      baseSha: 'commit-delete',
      baseBlob: '',
      updatedAt: 30,
      publishedSha: 'commit-delete',
    },
  ]);

  await recordRenames(
    'default',
    db,
    [
      { from: PATH, to: RENAMED, contents: FILE },
      { from: de, to: deTo, contents: deFile },
      { from: fr, to: frTo },
      { from: it, to: itTo },
    ],
    'commit-rename',
    'u2',
  );

  const rows = new Map((await db.select().from(drafts)).map((row) => [row.path, row]));
  expect([...rows.keys()].sort()).toEqual([PATH, RENAMED, de, deTo, frTo, it].sort());
  expect(rows.get(RENAMED)).toMatchObject({
    contents: FILE,
    baseSha: 'commit-rename',
    baseBlob: await blobSha(FILE),
    publishedSha: 'commit-rename',
  });
  expect(rows.get(deTo)).toMatchObject({
    revision: 'de-revision',
    contents: '_version: 1\ntitle: "Bearbeitete Muehle"\n',
    baseSha: 'commit-rename',
    baseBlob: await blobSha(deFile),
    heldBy: 'anna',
    heldAt: 9,
    pendingRedirects: [redirect],
    updatedBy: 'u2',
  });
  expect(rows.get(frTo)).toMatchObject({
    revision: 'fr-revision',
    baseSha: 'commit-rename',
    baseBlob: '',
    publishedSha: null,
    updatedBy: 'u2',
  });
  expect(rows.get(fr)).toBeUndefined();
  expect(rows.get(it)).toMatchObject({ revision: 'it-deleted', publishedSha: 'commit-delete' });
  expect(rows.get(itTo)).toBeUndefined();
});

// A rename is the last thing that happened to the entry, so it names the renamer.
test('a rename stamps who renamed onto the draft it carries over', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, title: 'The Old Mill' }, undefined, 'u1');

  await recordRenames(
    'default',
    db,
    [{ from: PATH, to: RENAMED, contents: FILE }],
    'commit-rename',
    'u2',
  );

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
  await recordRenames(
    'default',
    db,
    [{ from: PATH, to: RENAMED, contents: FILE }],
    'commit-rename',
  );

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
    { offered: ['en'], locales: ['en', 'de'] },
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
  baseBlob: '766d5be5170f6a0caa58cc9cb09aaef0d003e862',
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

test('an unpublished edit survives when its repository file is deleted', async () => {
  const db = await fresh();
  await db
    .insert(drafts)
    .values(orphanRow(ORPHAN, { contents: 'title: "Saved work"\n', updatedAt: NOW - 7 * DAY }));

  expect(await sweepOrphans('default', db, git, NOW)).toBe(0);
  expect((await loadDraft('default', db, ORPHAN))?.contents).toBe('title: "Saved work"\n');
});

test('a held draft survives when its repository file is deleted', async () => {
  const db = await fresh();
  await db.insert(drafts).values(orphanRow(ORPHAN, { heldBy: 'anna', heldAt: NOW - DAY }));

  expect(await sweepOrphans('default', db, git, NOW)).toBe(0);
  expect(await paths(db)).toEqual([ORPHAN]);
});

test('a save made while orphan candidates are checked wins the sweep', async () => {
  const db = await fresh();
  await db.insert(drafts).values(orphanRow(ORPHAN));
  const repo = {
    getHead: async () => 'commit-B',
    getFile: async () => {
      await saveDraft('default', db, git, ORPHAN, { title: 'Saved during cleanup' });
      return undefined;
    },
  };

  expect(await sweepOrphans('default', db, repo, NOW)).toBe(0);
  expect((await loadDraft('default', db, ORPHAN))?.contents).toBe(
    '_version: 1\ntitle: "Saved during cleanup"\n',
  );
});

test('a lock acquired while orphan candidates are checked wins the sweep', async () => {
  const db = await fresh();
  await db.insert(drafts).values(orphanRow(ORPHAN));
  const repo = {
    getHead: async () => 'commit-B',
    getFile: async () => {
      await claimLock('default', db, 'listings/gone', 'anna', 'tab', NOW);
      return undefined;
    },
  };

  expect(await sweepOrphans('default', db, repo, NOW)).toBe(0);
  expect(await paths(db)).toEqual([ORPHAN]);
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

test('overlay cleanup cannot delete a recreated entry after reading its deletion marker', async () => {
  const db = await fresh();
  await recordDelete('default', db, PATH, 'removed');
  const raced = afterRead(
    binding,
    (q) => q.includes('from "drafts"'),
    async () => {
      await createDraft('default', db, git, PATH, { title: 'Recreated' });
    },
  );
  await overlayRows('default', raced, indexOf({}));
  expect((await loadDraft('default', db, PATH))?.contents).toContain('Recreated');
});

test('overlay cleanup chunks large sets of settled deletion markers', async () => {
  const db = await fresh();
  const statements = Array.from({ length: 40 }, (_, i) =>
    db.insert(drafts).values({
      siteId: 'default',
      path: `src/content/listings/en/deleted-${i}.yaml`,
      revision: `deleted-${i}`,
      contents: '',
      baseSha: 'delete-commit',
      baseBlob: '',
      updatedAt: i,
      publishedSha: 'delete-commit',
    }),
  );
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);

  expect(await overlayRows('default', db, indexOf({}))).toEqual([]);
  expect(await db.select().from(drafts)).toEqual([]);
});
