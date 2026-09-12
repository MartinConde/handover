import { expect, test } from 'vitest';
import { parse } from 'yaml';
import type { GitClient, PublishFile } from './git.js';
import {
  collapseRedirects,
  deleteEntry,
  duplicateEntry,
  editRedirects,
  type RedirectRule,
  readRedirects,
  redirectError,
  redirectRule,
  redirectsText,
  renamedFrom,
  renameEntry,
  revertRedirects,
} from './lifecycle.js';

// Records every publish call and every read, with the commit it named.
function fakeGit(files: Record<string, string>) {
  const published: { files: PublishFile[]; message: string; base_sha: string }[] = [];
  const read: { path: string; at?: string }[] = [];
  const git: GitClient = {
    request: () => Promise.reject(new Error('not used')),
    getHead: async () => 'commit-A',
    getCommit: () => Promise.reject(new Error('not used')),
    getBlob: () => Promise.reject(new Error('not used')),
    contentFiles: () => Promise.reject(new Error('not used')),
    compareCommits: () => Promise.reject(new Error('not used')),
    fileCommits: () => Promise.reject(new Error('not used')),
    getFile: async (path, at) => {
      read.push({ path, at });
      const contents = files[path];
      return contents === undefined ? undefined : { contents, blob_sha: `sha-of-${path}` };
    },
    publish: async (list, opts) => {
      published.push({ files: list, ...opts });
      return { commit_sha: 'commit-B' };
    },
  };
  return { git, published, read };
}

const i18n = { locales: ['en', 'de', 'fr'], defaultLocale: 'en' };
const listings = { collection: 'listings', route: '/listings/[slug]', i18n };
const now = () => Date.parse('2026-08-22T09:30:00Z');
// The front page under each language's own segment: what "the overview" resolves to per locale.
const index = (locale: string) => (locale === i18n.defaultLocale ? '/' : `/${locale}/`);
const redirects = (files: PublishFile[]) =>
  parse(files.find((f) => f.path === 'src/content/redirects.yaml')?.contents ?? '');
const ANY_ID = expect.stringMatching(/^[0-9a-z]{8}$/);

test('rename moves every locale file and appends a rule per language in one commit', async () => {
  const { git, published } = fakeGit({
    'src/content/listings/en/seaview.yaml': '_version: 1\ntitle: "Seaview"\n',
    'src/content/listings/de/seaview.yaml': '_version: 1\ntitle: "Meerblick"\n',
    'src/content/redirects.yaml':
      '_version: 1\nrules:\n  - _id: "aaaaaaaa"\n    from: "/old"\n    to: "/new"\n    status: 301\n    reason: "manual"\n    createdAt: "2026-01-01T00:00:00Z"\n',
  });

  const result = await renameEntry('default', git, listings, 'seaview', 'seaview-cottage', { now });

  expect(result).toEqual({
    commit_sha: 'commit-B',
    files: [
      { locale: 'en', contents: '_version: 1\ntitle: "Seaview"\n' },
      { locale: 'de', contents: '_version: 1\ntitle: "Meerblick"\n' },
    ],
  });
  expect(published).toHaveLength(1);
  expect(published[0]?.message).toBe('Rename listings/seaview to seaview-cottage');
  expect(published[0]?.base_sha).toBe('commit-A');
  expect(published[0]?.files).toEqual([
    { path: 'src/content/listings/en/seaview.yaml', contents: null },
    {
      path: 'src/content/listings/en/seaview-cottage.yaml',
      contents: '_version: 1\ntitle: "Seaview"\n',
    },
    { path: 'src/content/listings/de/seaview.yaml', contents: null },
    {
      path: 'src/content/listings/de/seaview-cottage.yaml',
      contents: '_version: 1\ntitle: "Meerblick"\n',
    },
    { path: 'src/content/redirects.yaml', contents: expect.any(String) },
  ]);
  expect(redirects(published[0]?.files ?? [])).toEqual({
    _version: 1,
    rules: [
      {
        _id: 'aaaaaaaa',
        from: '/old',
        to: '/new',
        status: 301,
        reason: 'manual',
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        _id: ANY_ID,
        from: '/listings/seaview',
        to: '/listings/seaview-cottage',
        status: 301,
        reason: 'slug-change',
        entry: 'listings/seaview-cottage',
        createdAt: '2026-08-22T09:30:00Z',
      },
      {
        _id: ANY_ID,
        from: '/de/listings/seaview',
        to: '/de/listings/seaview-cottage',
        status: 301,
        reason: 'slug-change',
        entry: 'listings/seaview-cottage',
        createdAt: '2026-08-22T09:30:00Z',
      },
    ],
  });
});

// With localized slugs the file name is not the address, so renaming it moves nothing.
test('rename writes no rule for a language whose address is its own', async () => {
  const { git, published } = fakeGit({
    'src/content/pages/en/seaview.yaml': '_version: 1\ntitle: "Seaview"\n',
    'src/content/pages/de/seaview.yaml': '_version: 1\nslug: "meerblick"\ntitle: "Meerblick"\n',
  });
  const pages = { collection: 'pages', route: '/[slug]', i18n, localizedSlugs: true };

  await renameEntry('default', git, pages, 'seaview', 'seaview-cottage', { now });

  expect(redirects(published[0]?.files ?? []).rules).toEqual([
    {
      _id: ANY_ID,
      from: '/seaview',
      to: '/seaview-cottage',
      status: 301,
      reason: 'slug-change',
      entry: 'pages/seaview-cottage',
      createdAt: '2026-08-22T09:30:00Z',
    },
  ]);
});

test('rename creates redirects.yaml when the repo has none', async () => {
  const { git, published } = fakeGit({ 'src/content/listings/en/a.yaml': '_version: 1\n' });

  await renameEntry('default', git, listings, 'a', 'b', { now });

  expect(published[0]?.files.find((f) => f.path === 'src/content/redirects.yaml')?.contents).toBe(
    `_version: 1\nrules:\n  - _id: "${redirects(published[0]?.files ?? []).rules[0]._id}"\n    from: "/listings/a"\n    to: "/listings/b"\n    status: 301\n    reason: "slug-change"\n    entry: "listings/b"\n    createdAt: "2026-08-22T09:30:00Z"\n`,
  );
});

test('rename collapses a chain so an old URL points at the newest name', async () => {
  const { git, published } = fakeGit({
    'src/content/listings/en/b.yaml': '_version: 1\n',
    'src/content/redirects.yaml':
      '_version: 1\nrules:\n  - _id: "aaaaaaaa"\n    from: "/listings/a"\n    to: "/listings/b"\n    status: 301\n    reason: "slug-change"\n    entry: "listings/b"\n    createdAt: "2026-01-01T00:00:00Z"\n',
  });

  await renameEntry('default', git, listings, 'b', 'c', { now });

  expect(redirects(published[0]?.files ?? []).rules).toEqual([
    {
      _id: 'aaaaaaaa',
      from: '/listings/a',
      to: '/listings/c',
      status: 301,
      reason: 'slug-change',
      entry: 'listings/c',
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      _id: ANY_ID,
      from: '/listings/b',
      to: '/listings/c',
      status: 301,
      reason: 'slug-change',
      entry: 'listings/c',
      createdAt: '2026-08-22T09:30:00Z',
    },
  ]);
});

test('renaming back drops the rule that would redirect a URL to itself', async () => {
  const { git, published } = fakeGit({
    'src/content/listings/en/b.yaml': '_version: 1\n',
    'src/content/redirects.yaml':
      '_version: 1\nrules:\n  - _id: "aaaaaaaa"\n    from: "/listings/a"\n    to: "/listings/b"\n    status: 301\n    reason: "slug-change"\n    entry: "listings/b"\n    createdAt: "2026-01-01T00:00:00Z"\n',
  });

  await renameEntry('default', git, listings, 'b', 'a', { now });

  expect(redirects(published[0]?.files ?? []).rules).toEqual([
    {
      _id: ANY_ID,
      from: '/listings/b',
      to: '/listings/a',
      status: 301,
      reason: 'slug-change',
      entry: 'listings/a',
      createdAt: '2026-08-22T09:30:00Z',
    },
  ]);
});

test('rename of a collection without a route writes no redirect', async () => {
  const { git, published } = fakeGit({ 'src/content/globals/en/a.yaml': '_version: 1\n' });

  await renameEntry(
    'default',
    git,
    { collection: 'globals', i18n: { locales: ['en'], defaultLocale: 'en' } },
    'a',
    'b',
    { now },
  );

  expect(published[0]?.files.map((f) => f.path)).toEqual([
    'src/content/globals/en/a.yaml',
    'src/content/globals/en/b.yaml',
  ]);
});

test('rename refuses an entry that exists in no locale', async () => {
  const { git, published } = fakeGit({});

  await expect(renameEntry('default', git, listings, 'ghost', 'x', { now })).rejects.toThrow(
    'listings/ghost has no file in any of en, de, fr',
  );
  expect(published).toHaveLength(0);
});

test('delete removes every locale file and sends each language to its own index', async () => {
  const { git, published } = fakeGit({
    'src/content/listings/en/seaview.yaml': '_version: 1\n',
    'src/content/listings/fr/seaview.yaml': '_version: 1\n',
  });

  await deleteEntry('default', git, listings, 'seaview', index, { now });

  expect(published).toHaveLength(1);
  expect(published[0]?.message).toBe('Delete listings/seaview');
  expect(published[0]?.files).toEqual([
    { path: 'src/content/listings/en/seaview.yaml', contents: null },
    { path: 'src/content/listings/fr/seaview.yaml', contents: null },
    { path: 'src/content/redirects.yaml', contents: expect.any(String) },
  ]);
  expect(redirects(published[0]?.files ?? []).rules).toEqual([
    {
      _id: ANY_ID,
      from: '/listings/seaview',
      to: '/',
      status: 301,
      reason: 'deleted',
      createdAt: '2026-08-22T09:30:00Z',
    },
    {
      _id: ANY_ID,
      from: '/fr/listings/seaview',
      to: '/fr/',
      status: 301,
      reason: 'deleted',
      createdAt: '2026-08-22T09:30:00Z',
    },
  ]);
});

// The file goes, so the URL it answered to is the only record of where visitors were going.
test('delete redirects the address a language served, not the file name', async () => {
  const { git, published } = fakeGit({
    'src/content/pages/de/seaview.yaml': '_version: 1\nslug: "meerblick"\n',
  });
  const pages = { collection: 'pages', route: '/[slug]', i18n, localizedSlugs: true };

  await deleteEntry('default', git, pages, 'seaview', index, { now });

  expect(redirects(published[0]?.files ?? []).rules).toEqual([
    {
      _id: ANY_ID,
      from: '/de/meerblick',
      to: '/de/',
      status: 301,
      reason: 'deleted',
      createdAt: '2026-08-22T09:30:00Z',
    },
  ]);
});

test('delete sends each language to the target it was given, and none where it was given none', async () => {
  const { git, published } = fakeGit({
    'src/content/listings/en/seaview.yaml': '_version: 1\n',
    'src/content/listings/de/seaview.yaml': '_version: 1\n',
    'src/content/listings/fr/seaview.yaml': '_version: 1\n',
  });
  // One page picked in the dialog, resolved per language; none where the language has no page.
  const picked: Record<string, string> = {
    en: '/listings/harbour-flat',
    de: '/de/listings/hafenwohnung',
  };

  await deleteEntry('default', git, listings, 'seaview', (locale) => picked[locale], { now });

  expect(redirects(published[0]?.files ?? []).rules).toEqual([
    {
      _id: ANY_ID,
      from: '/listings/seaview',
      to: '/listings/harbour-flat',
      status: 301,
      reason: 'deleted',
      createdAt: '2026-08-22T09:30:00Z',
    },
    {
      _id: ANY_ID,
      from: '/de/listings/seaview',
      to: '/de/listings/hafenwohnung',
      status: 301,
      reason: 'deleted',
      createdAt: '2026-08-22T09:30:00Z',
    },
  ]);
});
test('delete with no redirect target touches only the entry files', async () => {
  const { git, published } = fakeGit({ 'src/content/listings/en/seaview.yaml': '_version: 1\n' });

  await deleteEntry('default', git, listings, 'seaview', undefined, { now });

  expect(published[0]?.files).toEqual([
    { path: 'src/content/listings/en/seaview.yaml', contents: null },
  ]);
});

// The asset server matches exactly, so both forms of `from` are written and `to` lands in one hop.
test("redirectsText writes each from both ways and to in the site's own form", () => {
  const rule = { _id: 'aaaaaaaa', status: 301 as const, createdAt: '2026-01-01T00:00:00Z' };
  const rules = [
    { ...rule, from: '/old', to: '/new', reason: 'slug-change' as const, entry: 'pages/new' },
    { ...rule, from: '/brochure', to: 'https://example.com/b.pdf', reason: 'manual' as const },
    { ...rule, from: '/gone/', to: '/', reason: 'deleted' as const },
  ];
  expect(redirectsText('default', rules, true)).toBe(
    '/old /new/ 301\n/old/ /new/ 301\n/brochure https://example.com/b.pdf 301\n/brochure/ https://example.com/b.pdf 301\n/gone / 301\n/gone/ / 301\n',
  );
  expect(redirectsText('default', rules.slice(0, 1), false)).toBe(
    '/old /new 301\n/old/ /new 301\n',
  );
  expect(redirectsText('default', [], true)).toBe('');
});

// decap-cms#7371 / payload#14491: a copy that drops the other locales is no longer one entry.
test('duplicate copies every locale of the entry with one shared id map', async () => {
  const block = (heading: string) =>
    `_version: 1\nblocks:\n  - _type: "hero"\n    _id: "k3nf9a2p"\n    heading: "${heading}"\n`;
  const { git } = fakeGit({
    'src/content/listings/en/seaview.yaml': block('Seaview'),
    'src/content/listings/de/seaview.yaml': block('Meerblick'),
  });

  const copies = await duplicateEntry('default', git, listings, 'seaview', 'seaview-copy');

  expect(copies.map((c) => c.path)).toEqual([
    'src/content/listings/en/seaview-copy.yaml',
    'src/content/listings/de/seaview-copy.yaml',
  ]);
  const ids = copies.map(
    (c) => (parse(c.contents) as { blocks: { _id: string }[] }).blocks[0]?._id,
  );
  expect(ids[0]).toEqual(ANY_ID);
  expect(ids[1]).toBe(ids[0]);
  expect(ids[0]).not.toBe('k3nf9a2p');
});

// A copy that kept the address would be a second page answering to the same URL.
test('duplicate leaves the original address behind and falls back to the new file name', async () => {
  const { git } = fakeGit({
    'src/content/pages/de/seaview.yaml': '_version: 1\nslug: "meerblick"\ntitle: "Meerblick"\n',
  });
  const pages = { collection: 'pages', route: '/[slug]', i18n, localizedSlugs: true };

  const copies = await duplicateEntry('default', git, pages, 'seaview', 'seaview-copy');

  expect(copies[0]?.contents).toBe('_version: 1\ntitle: "Meerblick"\n');
});

// `rowKey` pairs rows across files by `_id`, so two files inventing their own would read as drift.
test('a row that never had an _id gets the same new one in every locale', async () => {
  const block = (heading: string) =>
    `_version: 1\nblocks:\n  - _type: "hero"\n    heading: "${heading}"\n`;
  const { git } = fakeGit({
    'src/content/listings/en/seaview.yaml': block('Seaview'),
    'src/content/listings/de/seaview.yaml': block('Meerblick'),
  });

  const copies = await duplicateEntry('default', git, listings, 'seaview', 'seaview-copy');

  const ids = copies.map(
    (c) => (parse(c.contents) as { blocks: { _id: string }[] }).blocks[0]?._id,
  );
  expect(ids[0]).toEqual(ANY_ID);
  expect(ids[1]).toBe(ids[0]);
});

// The languages the caller hands in are copied from that draft; the rest come from the commit.
test('duplicate copies the bytes the caller hands it over the committed ones', async () => {
  const { git } = fakeGit({
    'src/content/listings/en/seaview.yaml': '_version: 1\ntitle: "Seaview"\n',
    'src/content/listings/de/seaview.yaml': '_version: 1\ntitle: "Meerblick"\n',
  });

  const copies = await duplicateEntry('default', git, listings, 'seaview', 'seaview-copy', {
    en: '_version: 1\ntitle: "Seaview, edited"\n',
  });

  expect(copies[0]?.contents).toBe('_version: 1\ntitle: "Seaview, edited"\n');
  expect(copies[1]?.contents).toBe('_version: 1\ntitle: "Meerblick"\n');
});

// A file from before Handover has no `_version`, and every write stamps it (F3 in 02-i18n.md).
test('duplicate stamps the version onto a file that has none', async () => {
  const { git } = fakeGit({ 'src/content/listings/en/seaview.yaml': 'title: "Seaview"\n' });

  const copies = await duplicateEntry('default', git, listings, 'seaview', 'seaview-copy');

  expect(copies[0]?.contents).toBe('_version: 1\ntitle: "Seaview"\n');
});

// Files read from the branch could put back bytes from before somebody else's push unnoticed.
test('a rename reads every file it moves at the commit it is made against', async () => {
  const { git, published, read } = fakeGit({
    'src/content/listings/en/seaview.yaml': '_version: 1\ntitle: "Seaview"\n',
    'src/content/redirects.yaml': '_version: 1\nrules: []\n',
  });

  await renameEntry('default', git, listings, 'seaview', 'seaview-cottage', { now });

  expect(published[0]?.base_sha).toBe('commit-A');
  expect(read.every((r) => r.at === 'commit-A')).toBe(true);
  // redirects.yaml is in the commit too, so the rules it is appended to are that commit's.
  expect(read).toContainEqual({ path: 'src/content/redirects.yaml', at: 'commit-A' });
});

const RULE = { _id: 'aaaaaaaa', status: 301 as const, createdAt: '2026-01-01T00:00:00Z' };
const manual = (from: string, to: string, _id = 'bbbbbbbb') => ({
  ...RULE,
  _id,
  from,
  to,
  reason: 'manual' as const,
});

test('a rule appended re-points the rule that led to its old address', () => {
  const collapsed = collapseRedirects(
    [manual('/a', '/b', 'first')],
    [manual('/b', '/c', 'second')],
  );

  expect(collapsed).toEqual([manual('/a', '/c', 'first'), manual('/b', '/c', 'second')]);
});

test('a rule appended that sends an address back to itself drops the rule that moved it', () => {
  const collapsed = collapseRedirects([manual('/a', '/b', 'first')], [manual('/b', '/a', 'back')]);

  expect(collapsed).toEqual([manual('/b', '/a', 'back')]);
});

test('a rule appended whose destination already forwards lands where that forwards', () => {
  const collapsed = collapseRedirects(
    [manual('/b', '/c', 'first')],
    [manual('/a', '/b', 'second')],
  );

  expect(collapsed).toEqual([manual('/b', '/c', 'first'), manual('/a', '/c', 'second')]);
});

// A hand-edited file may hold a chain, or a loop, the admin would never have written.
test('a rule appended follows a hand-written chain to its end and never round a loop', () => {
  const chain = [manual('/b', '/c', 'first'), manual('/c', '/d', 'second')];

  expect(collapseRedirects(chain, [manual('/a', '/b', 'third')]).at(-1)).toEqual(
    manual('/a', '/d', 'third'),
  );
  expect(
    collapseRedirects([...chain, manual('/d', '/b', 'round')], [manual('/a', '/b', 'in')]).at(-1),
  ).toEqual(manual('/a', '/d', 'in'));
});

// An edit is the same write as an add, made in place.
test('a rule already in the file is re-collapsed where it stands', () => {
  const collapsed = collapseRedirects(
    [manual('/p', '/a', 'lead'), manual('/a', '/b', 'edited'), manual('/x', '/y', 'onward')],
    [manual('/a', '/x', 'edited')],
  );

  expect(collapsed).toEqual([
    manual('/p', '/y', 'lead'),
    manual('/a', '/y', 'edited'),
    manual('/x', '/y', 'onward'),
  ]);
});

// A hidden entry's rule is dropped again by its `entry`, so re-pointing it must keep that link.
test('a re-pointed rule keeps the entry it belongs to when the new rule names none', () => {
  const hidden = {
    ...RULE,
    _id: 'hidden01',
    from: '/listings/mill',
    to: '/listings',
    reason: 'hidden' as const,
    entry: 'listings/mill',
  };

  const collapsed = collapseRedirects([hidden], [manual('/listings', '/homes', 'second')]);

  expect(collapsed[0]).toEqual({ ...hidden, to: '/homes', entry: 'listings/mill' });
});

test('reading redirects from a repository that has never written one is no rules', async () => {
  const { git } = fakeGit({});

  expect(await readRedirects('default', git)).toEqual([]);
});

test('one rule taken out is a commit of redirects.yaml alone', async () => {
  const { git, published } = fakeGit({
    'src/content/redirects.yaml':
      '_version: 1\nrules:\n  - _id: "aaaaaaaa"\n    from: "/old"\n    to: "/new"\n    status: 301\n    reason: "manual"\n    createdAt: "2026-01-01T00:00:00Z"\n  - _id: "bbbbbbbb"\n    from: "/gone"\n    to: "/"\n    status: 302\n    reason: "manual"\n    createdAt: "2026-01-02T00:00:00Z"\n',
  });

  const result = await editRedirects('default', git, 'Delete redirect /gone', (rules) =>
    rules.filter((r) => r._id !== 'bbbbbbbb'),
  );

  expect(result).toEqual({ commit_sha: 'commit-B' });
  expect(published[0]?.message).toBe('Delete redirect /gone');
  expect(published[0]?.files.map((f) => f.path)).toEqual(['src/content/redirects.yaml']);
  expect(redirects(published[0]?.files ?? []).rules).toEqual([
    {
      _id: 'aaaaaaaa',
      from: '/old',
      to: '/new',
      status: 301,
      reason: 'manual',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ]);
});

const site = {
  pages: { '/listings/harbour-flat': 'Harbour Flat' },
  rules: [manual('/summer-offer', '/listings', 'taken')],
};

test('an empty box is asked for rather than corrected', () => {
  expect(redirectError('default', { from: '  ', to: '/listings' }, site)).toEqual({
    field: 'from',
    message: 'An old address is needed.',
  });
  expect(redirectError('default', { from: '/a', to: '' }, site)).toEqual({
    field: 'to',
    message: 'A destination is needed.',
  });
});

test('an old address that is not a path says so with the path it meant', () => {
  expect(redirectError('default', { from: 'summer-offer', to: '/listings' }, site)).toEqual({
    field: 'from',
    message: 'An address has to start with "/" — did you mean "/summer-offer"?',
  });
});

test('an old address given as a full web address is refused as one', () => {
  expect(
    redirectError('default', { from: 'https://example.com/x', to: '/listings' }, site)?.message,
  ).toBe('An old address is a path on this site, like "/summer-offer", not a full web address.');
});

test('an old address that is a real page names the page it would hide', () => {
  expect(
    redirectError('default', { from: '/listings/harbour-flat', to: '/listings' }, site),
  ).toEqual({
    field: 'from',
    message: 'This is a real page. A redirect here would hide Harbour Flat from visitors.',
  });
});

test('a rule that sends an address to itself is refused on the destination', () => {
  expect(redirectError('default', { from: '/a', to: '/a' }, site)).toEqual({
    field: 'to',
    message: 'This sends visitors back where they came from. Pick somewhere else.',
  });
});

test('a second rule from an address that already has one is refused', () => {
  expect(redirectError('default', { from: '/summer-offer', to: '/other' }, site)?.message).toBe(
    'There is already a redirect from this address.',
  );
});

// Editing a rule reads its own `from` back, which is not a clash with itself.
test('a rule keeping its own old address is not refused as a duplicate', () => {
  expect(
    redirectError('default', { from: '/summer-offer', to: '/other' }, site, 'taken'),
  ).toBeUndefined();
});

test('a destination that is neither a path nor a web address is refused', () => {
  expect(redirectError('default', { from: '/a', to: 'listings' }, site)).toEqual({
    field: 'to',
    message:
      'A destination is a path on this site or a full web address — did you mean "/listings"?',
  });
});

test('a path and an absolute destination are both accepted', () => {
  expect(redirectError('default', { from: '/a', to: '/b' }, site)).toBeUndefined();
  expect(
    redirectError('default', { from: '/a', to: 'https://example.com/b.pdf' }, site),
  ).toBeUndefined();
});

test('redirect fields cannot contain whitespace or control characters', () => {
  for (const value of ['/old\n/shadow', '/old\r/shadow', '/old\t/shadow', '/old shadow']) {
    expect(redirectError('default', { from: value, to: '/new' }, site)).toEqual({
      field: 'from',
      message: 'An old address cannot contain spaces or control characters.',
    });
    expect(redirectError('default', { from: '/old', to: value }, site)).toEqual({
      field: 'to',
      message: 'A destination cannot contain spaces or control characters.',
    });
  }
});

test('lifecycle redirects reject unsafe generated targets before they are stored or emitted', () => {
  expect(() =>
    redirectRule(
      'default',
      { from: '/old', to: '/new\n/shadow', status: 301, reason: 'slug-change' },
      Date.parse('2026-01-01T00:00:00Z'),
    ),
  ).toThrow('redirect destination cannot contain whitespace or control characters');

  expect(() =>
    redirectsText(
      'default',
      [manual('/old\n/shadow https://outside.example 302\n/another', '/new', 'unsafe')],
      true,
    ),
  ).toThrow('redirect source cannot contain whitespace or control characters');
});

// The rename commit's message is the one place the old name is written down.
test('renamedFrom reads the old name out of a rename commit of this entry', () => {
  expect(
    renamedFrom('default', 'Rename listings/old-mill to mill-house', 'listings', 'mill-house'),
  ).toBe('old-mill');
  expect(
    renamedFrom('default', 'Rename pages/old-mill to mill-house', 'listings', 'mill-house'),
  ).toBeUndefined();
  expect(
    renamedFrom('default', 'Rename listings/mill-house to barn', 'listings', 'mill-house'),
  ).toBeUndefined();
  expect(
    renamedFrom('default', 'Update listings/en/mill-house', 'listings', 'mill-house'),
  ).toBeUndefined();
});

const undoRules = (before: RedirectRule[], after: RedirectRule[], head: RedirectRule[]) =>
  revertRedirects(
    'default',
    {
      getFile: async (_path, at) => ({
        contents: JSON.stringify({
          rules: at === 'before' ? before : at === 'after' ? after : head,
        }),
        blob_sha: 'blob',
      }),
    },
    { parent: 'before', commit: 'after', head: 'head' },
  );

test('redirect undo restores edits and deletions and keeps later independent rules', async () => {
  const original = manual('/old', '/before', 'original');
  const removed = manual('/deleted', '/target', 'removed1');
  const added = manual('/before', '/after', 'added111');
  const later = manual('/later', '/elsewhere', 'later111');
  const rewritten = { ...original, to: '/after' };
  const file = await undoRules([original, removed], [rewritten, added], [rewritten, added, later]);
  expect(parse(file?.contents ?? '').rules).toEqual([original, later, removed]);
});

test.each(['edit', 'delete', 'addition'])(
  'redirect undo refuses a later overlapping %s',
  async (kind) => {
    const original = manual('/old', '/before', 'original');
    const changed = { ...original, to: '/after' };
    const later = { ...changed, to: '/later' };
    await expect(
      undoRules(kind === 'addition' ? [] : [original], kind === 'delete' ? [] : [changed], [later]),
    ).rejects.toMatchObject({ name: 'RevertConflictError', paths: ['src/content/redirects.yaml'] });
  },
);
