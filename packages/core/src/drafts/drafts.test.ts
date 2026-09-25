import type { Miniflare } from 'miniflare';
import { beforeAll, expect, test } from 'vitest';
import { parseEntry } from '../content/entry-format.js';
import { driftReport } from '../content/locale-sync.js';
import type { RedirectRule } from '../content/redirects.js';
import type { Form } from '../content/schema.js';
import {
  ADDRESSED,
  afterRead,
  BLOB,
  bilingual,
  block,
  draftDb,
  FILE,
  fakeHistory,
  fakeRepo,
  GERMAN,
  git,
  HIDE_DE,
  HIDE_EN,
  indexOf,
  LISTING_DE,
  listed,
  MILL_DE_FILE,
  MOVED,
  migrateTestD1,
  NEW,
  newTestD1,
  OTHER,
  OTHER_FILE,
  only,
  PAGE_DE,
  PAGE_EN,
  PAGE_FORM,
  PATH,
  page,
  REDIRECT,
  RENAMED,
  ruleFor,
  SYNC,
  VALUES,
} from '../db.fixtures.js';
import { openDb } from '../db.js';
import { blobSha } from '../publishing/git.js';
import { publishDrafts } from '../publishing/publish.js';
import { drafts } from '../tables.js';
import {
  createDraft,
  draftEditors,
  draftFiles,
  heldDrafts,
  holdEntry,
  loadDraft,
  openDraft,
  overlayRows,
  pendingDrafts,
  recordDelete,
  recordOffer,
  recordRenames,
  restoreDraft,
  saveDraft,
  saveTranslated,
  setEntryAddress,
  setEntryLocales,
  setEntryStatus,
  sweepOrphans,
} from './drafts.js';
import { claimLock } from './locks.js';

const mf = newTestD1();
let binding: Awaited<ReturnType<Miniflare['getD1Database']>>;
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  await migrateTestD1(binding);
});
const fresh = draftDb(() => binding);

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

test('the first autosave takes the base sha and blob from git, not from the browser', async () => {
  const db = await fresh();
  await saveDraft('default', db, git, PATH, VALUES);

  const row = await only(db);
  expect(row?.baseSha).toBe('commit-A');
  expect(row?.baseBlob).toBe(BLOB);
});

test('opening an invalid repository document does not copy it into the draft store', async () => {
  const db = await fresh();
  const contents = '_version: 1\nopaque:\n  - _id: "bad"\n';

  await expect(
    openDraft('default', db, PATH, 'commit-A', {
      contents,
      blob_sha: await blobSha(contents),
    }),
  ).rejects.toThrow('opaque[0]._id: expected eight characters from 0-9a-z, got "bad"');
  expect(await db.select().from(drafts)).toEqual([]);
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

test('ordinary saves preserve managed values and cannot add one that is absent', async () => {
  const db = await fresh();
  const managedFile = FILE.replace('title:', 'slug: "mill-house"\ntitle:');
  const managedGit = {
    getHead: async () => 'commit-A',
    getFile: async (path: string) =>
      path === PATH ? { contents: managedFile, blob_sha: await blobSha(managedFile) } : undefined,
  };
  const options = {
    form: { fields: [], blocks: {} },
    locale: 'en',
    siblings: {},
    managed: ['slug'],
  };

  await saveDraft('default', db, managedGit, PATH, { ...VALUES, slug: 'taken-address' }, options);
  expect((await only(db))?.contents).toBe(managedFile);
  expect(parseEntry('default', (await only(db))?.contents ?? '')).toMatchObject({
    slug: 'mill-house',
    title: 'The Mill House',
  });

  await fresh();
  await saveDraft('default', db, git, PATH, { ...VALUES, slug: 'injected-address' }, options);
  expect(parseEntry('default', (await only(db))?.contents ?? '')).not.toHaveProperty('slug');
});

test('ordinary fields named slug remain editable when they are not managed', async () => {
  const db = await fresh();
  await saveDraft('default', db, git, PATH, { ...VALUES, slug: 'editor-owned' });

  expect(parseEntry('default', (await only(db))?.contents ?? '')).toMatchObject({
    slug: 'editor-owned',
  });
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

test('a draft that matches the file it was loaded from is not pending', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, VALUES);

  expect(await pendingDrafts('default', db)).toEqual([]);
});

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

test('creating an entry rejects unreadable nested metadata before inserting a draft', async () => {
  const db = await fresh();
  const repo = fakeRepo({});

  await expect(
    createDraft('default', db, repo, NEW, {
      title: '',
      opaque: { rows: [{ _id: 'bad' }] },
    }),
  ).rejects.toThrow('opaque.rows[0]._id: expected eight characters from 0-9a-z, got "bad"');
  expect(await db.select().from(drafts)).toEqual([]);
});

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

const DE_FORM: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['price'], label: 'Price', type: 'text', required: true, i18n: 'duplicate' },
    { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['hero', 'cta'] },
  ],
  blocks: PAGE_FORM.blocks,
};

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

test('a translated save rejects duplicate submitted identities before they can be paired', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [LISTING_DE]: GERMAN });

  await expect(
    saveDraft(
      'default',
      db,
      repo,
      LISTING_DE,
      {
        title: 'Mühlenhaus am Bach',
        blocks: [
          { ...block('k3nf9a2p'), heading: 'Erste Fassung' },
          { ...block('k3nf9a2p'), heading: 'Zweite Fassung' },
        ],
      },
      { form: DE_FORM, locale: 'de', siblings: {}, translation: true },
    ),
  ).rejects.toThrow(
    'blocks[1]._id: duplicate row identity "k3nf9a2p"; already used at blocks[0]._id',
  );
  expect(await loadDraft('default', db, LISTING_DE)).toBeUndefined();
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

const hidden = (contents: string) =>
  contents.replace('_version: 1\n', '_version: 1\n_status: "hidden"\n');

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

test('restoring a version rejects duplicate identities before writing any locale', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [PATH_DE]: FILE_DE });

  await expect(
    restoreDraft('default', db, repo, VERSION_FORM, [
      {
        path: PATH,
        entry: {
          ...OLD_EN,
          opaque: [
            { _id: 'same0001', title: 'One' },
            { _id: 'same0001', title: 'Two' },
          ],
        },
      },
      { path: PATH_DE, entry: OLD_DE },
    ]),
  ).rejects.toThrow(
    'opaque[1]._id: duplicate row identity "same0001"; already used at opaque[0]._id',
  );
  expect(await db.select().from(drafts)).toEqual([]);
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

test('a new multi-language entry claims all paths or leaves every path untouched', async () => {
  const { createDrafts } = await import('./drafts.js');
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
