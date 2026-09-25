import type { Miniflare } from 'miniflare';
import { beforeAll, expect, test } from 'vitest';
import { logActivity } from './activity.js';
import {
  afterRead,
  draftDb,
  FILE,
  fakeHistory,
  indexOf,
  listed,
  MILL_DE_FILE,
  migrateTestD1,
  newTestD1,
  OTHER,
  OTHER_FILE,
  only,
  PATH,
  RENAMED,
  seedPublishedRows,
  VALUES,
} from './db.fixtures.js';
import {
  createDraft,
  loadDraft,
  pendingDrafts,
  recordDelete,
  recordOffer,
  saveDraft,
} from './db.js';
import { entryKey } from './entries.js';
import { offeredEntry, parseEntry, stringifyEntry } from './entry-format.js';
import { claimLock } from './locks.js';
import { publishDrafts } from './publish.js';
import { clearPublished, RevertConflictError, restoreCommit, revertCommit } from './revert.js';
import * as tables from './tables.js';
import { drafts } from './tables.js';

const mf = newTestD1();
let binding: Awaited<ReturnType<Miniflare['getD1Database']>>;
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  await migrateTestD1(binding);
});
const fresh = draftDb(() => binding);

// A restore that touched git alone would leave the open draft saying German is off.
const MILL_DE = 'src/content/listings/de/mill-house.yaml';
const OFFER = { offered: ['en'], locales: ['en', 'de'] };
const withoutGerman = (contents: string) =>
  stringifyEntry('default', offeredEntry('default', parseEntry('default', contents), OFFER));

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

test('reverting a large publish chunks its draft lookup without splitting finalization', async () => {
  const db = await fresh();
  const repo = fakeHistory({});
  const files = Array.from({ length: 100 }, (_, i) => ({
    path: `src/content/listings/en/entry-${i}.yaml`,
    contents: `_version: 1\ntitle: "Entry ${i}"\n`,
  }));
  const published = await repo.publish(files, {
    base_sha: 'commit-0',
    message: 'Publish a large collection',
  });
  await logActivity('default', db, {
    kind: 'publish',
    commitSha: published.commit_sha,
    detail: { paths: files.map((file) => file.path) },
  });

  const reverted = await revertCommit('default', db, repo, published.commit_sha);

  expect(reverted.paths.toSorted()).toEqual(files.map((file) => file.path).toSorted());
  expect(await db.select().from(drafts)).toHaveLength(100);
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

test.each([19, 20, 61])(
  'published cleanup stays within D1 limits for %i locale files',
  async (count) => {
    const db = await fresh();
    const { paths, publishedSha } = await seedPublishedRows(db, count);

    expect((await clearPublished('default', db, publishedSha)).toSorted()).toEqual(
      paths.toSorted(),
    );
    expect(await db.select().from(drafts)).toEqual([]);
  },
);

test('a later deployed commit clears an earlier published overlay', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  const published = await publishDrafts('default', db, repo);
  const deployed = repo.push([{ path: PATH, contents: FILE.replace('rooms: 3', 'rooms: 5') }]);

  expect((await only(db))?.publishedSha).toBe(published?.commit_sha);
  expect(await clearPublished('default', db, deployed, repo)).toEqual([PATH]);
  expect(await only(db)).toBe(undefined);
});

test('matching deployed content can clear an overlay from a divergent history', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  const published = await publishDrafts('default', db, repo);
  const contents = repo.at(published?.commit_sha ?? '')[PATH] ?? '';
  const divergent = await repo.publish([{ path: PATH, contents }], {
    base_sha: 'commit-0',
    message: 'Same content on another history',
  });

  expect(await clearPublished('default', db, divergent.commit_sha, repo)).toEqual([PATH]);
  expect(await only(db)).toBeUndefined();
});

test('a rollback with different content keeps a newer published overlay', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  await publishDrafts('default', db, repo);

  expect(await clearPublished('default', db, 'commit-0', repo)).toEqual([]);
  expect((await only(db))?.publishedSha).toBe('commit-1');
});

test('a lock defers descendant cleanup until a later poll', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PATH]: FILE, [OTHER]: OTHER_FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  await publishDrafts('default', db, repo);
  const deployed = repo.push([
    { path: OTHER, contents: OTHER_FILE.replace('rooms: 1', 'rooms: 2') },
  ]);
  await claimLock('default', db, 'listings/mill-house', 'anna', 'tab');

  expect(await clearPublished('default', db, deployed, repo)).toEqual([]);
  await db.delete(tables.locks);
  expect(await clearPublished('default', db, deployed, repo)).toEqual([PATH]);
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

test('cleanup rechecks the revision when a newer save arrives after selecting candidates', async () => {
  const db = await fresh(),
    repo = fakeHistory({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  const published = await publishDrafts('default', db, repo);
  const raced = afterRead(
    binding,
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
    binding,
    (q) => q.includes('from "locks"'),
    async () => {
      await claimLock('default', db, 'listings/mill-house', 'editing', 'tab');
    },
  );
  await clearPublished('default', raced, published?.commit_sha ?? '');
  expect(await loadDraft('default', db, PATH)).toBeDefined();
  await db.delete(tables.locks);
});

test('chunked cleanup preserves a newer save and lock that arrive between chunks', async () => {
  const db = await fresh();
  const { publishedSha } = await seedPublishedRows(db, 20);
  let savedPath = '';
  let lockedPath = '';
  const raced = afterRead(
    binding,
    (q) => q.startsWith('delete from "drafts"'),
    async () => {
      const remaining = await db.select({ path: drafts.path }).from(drafts);
      savedPath = remaining[0]?.path ?? '';
      lockedPath = remaining.find((row) => entryKey(row.path) !== entryKey(savedPath))?.path ?? '';
      if (!savedPath || !lockedPath) throw new Error('Expected a second cleanup chunk');
      await binding
        .prepare(
          `UPDATE drafts SET revision = 'newer-save', contents = '_version: 1\ntitle: "Newer"\n', published_sha = NULL WHERE site_id = 'default' AND path = ?`,
        )
        .bind(savedPath)
        .run();
      await claimLock('default', db, entryKey(lockedPath) ?? '', 'editing', 'tab');
    },
  );

  const removed = await clearPublished('default', raced, publishedSha);

  expect(removed).toHaveLength(18);
  expect((await loadDraft('default', db, savedPath))?.revision).toBe('newer-save');
  expect(await loadDraft('default', db, lockedPath)).toBeDefined();
  await db.delete(tables.locks);
});
