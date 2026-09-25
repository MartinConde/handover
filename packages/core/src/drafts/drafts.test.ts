import type { Miniflare } from 'miniflare';
import { beforeAll, expect, test } from 'vitest';
import { parseEntry } from '../content/entry-format.js';
import type { Form } from '../content/schema.js';
import {
  afterVersion,
  BLOB,
  bilingual,
  block,
  draftDb,
  FILE,
  fakeHistory,
  fakeRepo,
  GERMAN,
  git,
  LISTING_DE,
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
  SYNC,
  VALUES,
} from '../db.fixture.js';
import { blobSha } from '../publishing/git.js';
import { publishDrafts } from '../publishing/publish.js';
import { drafts } from '../tables.js';
import {
  createDraft,
  draftEditors,
  heldDrafts,
  holdEntry,
  loadDraft,
  openDraft,
  pendingDrafts,
  saveDraft,
  saveTranslated,
} from './drafts.js';

const mf = newTestD1();
let binding: Awaited<ReturnType<Miniflare['getD1Database']>>;
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  await migrateTestD1(binding);
});
const fresh = draftDb(() => binding);

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

test('moving a block writes every language of the entry in one write', async () => {
  const db = await fresh();
  const repo = bilingual();

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
  const repo = bilingual();

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
  const repo = bilingual();
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
  const repo = bilingual();
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
    afterVersion(
      page('Zuhause', 'Zieh ans Meer', 'Bereit für den Umzug?'),
      '_machine:\n  - "title"\n  - "blocks[_id=k3nf9a2p].heading"\n',
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
