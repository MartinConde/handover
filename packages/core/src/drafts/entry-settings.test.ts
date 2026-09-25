import type { Miniflare } from 'miniflare';
import { beforeAll, expect, test } from 'vitest';
import { parseEntry } from '../content/entry-format.js';
import { driftReport } from '../content/locale-sync.js';
import type { Form } from '../content/schema.js';
import {
  ADDRESSED,
  afterVersion,
  bilingual,
  draftDb,
  FILE,
  fakeRepo,
  HIDE_DE,
  HIDE_EN,
  LISTING_DE,
  migrateTestD1,
  newTestD1,
  only,
  PAGE_DE,
  PAGE_EN,
  PAGE_FORM,
  PATH,
  page,
  REDIRECT,
  ruleFor,
} from '../db.fixture.js';
import { publishDrafts } from '../publishing/publish.js';
import { drafts } from '../tables.js';
import {
  restoreDraft,
  setEntryAddress,
  setEntryLocales,
  setEntryStatus,
} from './entry-settings.js';

const mf = newTestD1();
let binding: Awaited<ReturnType<Miniflare['getD1Database']>>;
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  await migrateTestD1(binding);
});
const fresh = draftDb(() => binding);

test('turning a language off stamps the version on a file that has none', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PAGE_EN]: page('Home', 'a', 'b').replace('_version: 1\n', '') });

  await setEntryLocales('default', db, repo, [PAGE_EN], ['en'], ['en', 'de']);

  expect((await only(db))?.contents).toBe(
    afterVersion(page('Home', 'a', 'b'), '_locales:\n  - "en"\n'),
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
    afterVersion(
      page('Home', 'Move to the coast', 'Ready to move?'),
      '_locales:\n  - "en"\n  - "de"\n',
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

test('an address is written into that language alone, in schema order', async () => {
  const db = await fresh();
  const repo = bilingual();

  await setEntryAddress('default', db, repo, ADDRESSED, PAGE_DE, 'startseite', REDIRECT);

  const rows = await db.select().from(drafts);
  expect(rows.map((r) => r.path)).toEqual([PAGE_DE]);
  expect(rows[0]?.contents).toBe(
    afterVersion(
      page('Startseite', 'Zieh an die Küste', 'Bereit für den Umzug?'),
      'slug: "startseite"\n',
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
    afterVersion(page('Startseite', 'a', 'b'), 'slug: "startseite"\n'),
  );
});

const hidden = (contents: string) => afterVersion(contents, '_status: "hidden"\n');

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

// Not testing: reading the version out of GitHub, which is the route's.
const VERSION_FORM: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['price'], label: 'Price', type: 'text', required: false },
    { path: ['rooms'], label: 'Rooms', type: 'number', required: true },
  ],
  blocks: {},
};
const FILE_DE = '_version: 1\n_status: "hidden"\ntitle: "Das Mühlenhaus"\nrooms: 3\n';
const OLD_EN = { _version: 1, title: 'The Mill House', price: '£800 per week', rooms: 2 };
const OLD_DE = { _version: 1, title: 'Das Muehlenhaus', rooms: 2 };

test('restoring a version writes its bytes as the draft of every language it has', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [LISTING_DE]: FILE_DE });

  const { paths } = await restoreDraft('default', db, repo, VERSION_FORM, [
    { path: PATH, entry: OLD_EN },
    { path: LISTING_DE, entry: OLD_DE },
  ]);

  expect(paths.toSorted()).toEqual([LISTING_DE, PATH].toSorted());
  const row = (await db.select().from(drafts)).find((r) => r.path === PATH);
  expect(row?.contents).toBe(
    '_version: 1\n_status: "hidden"\ntitle: "The Mill House"\nprice: "£800 per week"\nrooms: 2\n',
  );
});

test('restoring a version rejects duplicate identities before writing any locale', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [LISTING_DE]: FILE_DE });

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
      { path: LISTING_DE, entry: OLD_DE },
    ]),
  ).rejects.toThrow(
    'opaque[1]._id: duplicate row identity "same0001"; already used at opaque[0]._id',
  );
  expect(await db.select().from(drafts)).toEqual([]);
});

test('a restore stamps who restored on every language it writes', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE, [LISTING_DE]: FILE_DE });

  await restoreDraft(
    'default',
    db,
    repo,
    VERSION_FORM,
    [
      { path: PATH, entry: OLD_EN },
      { path: LISTING_DE, entry: OLD_DE },
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
  const repo = bilingual();
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
    { path: LISTING_DE, entry: OLD_DE },
  ]);

  expect(paths).toEqual([PATH]);
});
