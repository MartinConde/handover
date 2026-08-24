import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { parseEntry, staleLocales } from './content.js';
import {
  createDraft,
  DraftConflictError,
  discardDraft,
  drafts,
  loadDraft,
  openDb,
  overlayRows,
  pendingDrafts,
  publishDrafts,
  recordDelete,
  recordOffer,
  recordRename,
  resolveDrift,
  saveDraft,
  saveTranslated,
  setEntryAddress,
  setEntryLocales,
} from './db.js';
import { type ContentIndex, collectionEntries, indexFrom } from './entries.js';
import { blobSha } from './git.js';
import type { RedirectRule } from './lifecycle.js';
import type { Form } from './schema.js';

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

// One entry, two languages. The structure is shared, so a block moved in English is a block
// moved in German — in the same write, or the two files leave the editor out of step.
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

// The other direction: a save of a language the entry is translated into. It owns its own
// words and nothing else — the structure and the shared values are the file's, whatever the
// browser posts back (decap-cms#6978).
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
  expect(await db.select().from(drafts)).toEqual([]);
});

// Staleness. The German file is a translation of the English as it stood when somebody wrote
// it, and `_i18n` is the publish writing down which English that was.
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

// Reconciling drift is the write `saveDraft` cannot make: the answer moves a block between
// the entry's files, and every file it changes has to reach the drafts table together.
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

// Every write stamps `_version`, not the editor's save alone: a file written before Handover,
// or by hand, has none, and `content-format.md` promises the next save gives it one (F3).
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

// Turning a language off is a decision about the entry, so it goes in the files the entry has
// rather than in D1: the site builds from git alone, and no file is written for the language
// that was turned off.
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

// The other half of turning a language off: the commit that removed one language's file also
// wrote the mark into the files that stay, and somebody may have had one of them open. The
// draft keeps their words, takes the mark, and is rebased on the commit — without that it would
// publish the language back on, over a base that has moved.
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

// A machine's answers are their own write: `saveDraft` carries what a form sent back, and a
// fill is neither a form nor the words of the language whose file it lands in.
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

// The address a language serves an entry at. Its own write, like the language mark: it is not
// a form's values, and the redirect it owes cannot be committed until the entry is published —
// until then the old address is the live one.
const REDIRECT = { from: '/de/home', to: '/de/startseite', entry: 'pages/home' };
// `slug` is the first key the page schema declares, and the address goes where the schema puts
// it rather than at the end of the file (F4 in 02-i18n.md).
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

// The row is still published for the words typed after it, so the rule has to be gone rather
// than merely unreachable: a redirect from a URL that never moved is a redirect forever.
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
