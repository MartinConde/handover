import { expect, test } from 'vitest';
import { parse } from 'yaml';
import type { GitClient, PublishFile } from './git.js';
import { deleteEntry, duplicateEntry, redirectsText, renameEntry } from './lifecycle.js';

// An in-memory repo: serves files, records every publish call and every read that named a
// commit rather than the branch.
function fakeGit(files: Record<string, string>) {
  const published: { files: PublishFile[]; message: string; base_sha: string }[] = [];
  const read: { path: string; at?: string }[] = [];
  const git: GitClient = {
    request: () => Promise.reject(new Error('not used')),
    getHead: async () => 'commit-A',
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

  expect(result).toEqual({ commit_sha: 'commit-B' });
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

// The URL a language serves the entry at is the one that moved, and on a collection with
// localized slugs the file name is not it: renaming the file leaves that language's address
// exactly where it was, so there is nothing to redirect.
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

  await deleteEntry('default', git, listings, 'seaview', '/', { now });

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

// A delete is the one place the address still has to be read: the file goes, so the URL it
// answered to is the only record of where the visitors were going.
test('delete redirects the address a language served, not the file name', async () => {
  const { git, published } = fakeGit({
    'src/content/pages/de/seaview.yaml': '_version: 1\nslug: "meerblick"\n',
  });
  const pages = { collection: 'pages', route: '/[slug]', i18n, localizedSlugs: true };

  await deleteEntry('default', git, pages, 'seaview', '/', { now });

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

test('delete with no redirect target touches only the entry files', async () => {
  const { git, published } = fakeGit({ 'src/content/listings/en/seaview.yaml': '_version: 1\n' });

  await deleteEntry('default', git, listings, 'seaview', undefined, { now });

  expect(published[0]?.files).toEqual([
    { path: 'src/content/listings/en/seaview.yaml', contents: null },
  ]);
});

test('redirectsText is one "/from /to status" line per rule', () => {
  const rule = { _id: 'aaaaaaaa', status: 301 as const, createdAt: '2026-01-01T00:00:00Z' };
  expect(
    redirectsText('default', [
      { ...rule, from: '/old', to: '/new', reason: 'slug-change', entry: 'pages/new' },
      { ...rule, from: '/brochure', to: 'https://example.com/b.pdf', reason: 'manual' },
    ]),
  ).toBe('/old /new 301\n/brochure https://example.com/b.pdf 301\n');
  expect(redirectsText('default', [])).toBe('');
});

// decap-cms#7371 / payload#14491: duplicating an entry copies the default locale and
// silently drops the rest. The copy has to stay one cross-locale entry, so the same block
// gets the same new `_id` in every locale file.
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

// An address is one entry's own: a copy that kept it would be a second page answering to the
// same URL, which is the thing `POST …/address/:locale` refuses with a 409.
test('duplicate leaves the original address behind and falls back to the new file name', async () => {
  const { git } = fakeGit({
    'src/content/pages/de/seaview.yaml': '_version: 1\nslug: "meerblick"\ntitle: "Meerblick"\n',
  });
  const pages = { collection: 'pages', route: '/[slug]', i18n, localizedSlugs: true };

  const copies = await duplicateEntry('default', git, pages, 'seaview', 'seaview-copy');

  expect(copies[0]?.contents).toBe('_version: 1\ntitle: "Meerblick"\n');
});

// A file from before Handover has no `_version`, and every write stamps it — not the editor's
// save alone (F3 in 02-i18n.md).
test('duplicate stamps the version onto a file that has none', async () => {
  const { git } = fakeGit({ 'src/content/listings/en/seaview.yaml': 'title: "Seaview"\n' });

  const copies = await duplicateEntry('default', git, listings, 'seaview', 'seaview-copy');

  expect(copies[0]?.contents).toBe('_version: 1\ntitle: "Seaview"\n');
});

// A commit made of files read from the branch is a commit that can carry bytes from before
// somebody else's push and put them back, without the ref update having anything to refuse.
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
