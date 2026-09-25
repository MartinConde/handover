import type { Miniflare } from 'miniflare';
import { beforeAll, expect, test, vi } from 'vitest';
import { parseEntry, stringifyEntry } from '../content/entry-format.js';
import { staleLocales } from '../content/provenance.js';
import type { RedirectRule } from '../content/redirects.js';
import {
  ADDRESSED,
  bilingual,
  block,
  draftDb,
  FILE,
  fakeHistory,
  fakeRepo,
  GERMAN,
  HIDE_DE,
  HIDE_EN,
  LISTING_DE,
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
  ruleFor,
  SYNC,
  VALUES,
} from '../db.fixtures.js';
import { openDb } from '../db.js';
import {
  createDraft,
  discardDraft,
  heldDrafts,
  holdEntry,
  loadDraft,
  pendingDrafts,
  saveDraft,
  saveTranslated,
} from '../drafts/drafts.js';
import { setEntryAddress, setEntryStatus } from '../drafts/entry-settings.js';
import * as tables from '../tables.js';
import { drafts } from '../tables.js';
import { blobSha, RefMovedError } from './git.js';
import {
  beginOperation,
  OperationFinalizationError,
  operationMessage,
  recoverOperationCommit,
} from './operations.js';
import { commitScope, DraftConflictError, publishDrafts, readyDrafts } from './publish.js';

const mf = newTestD1();
let binding: Awaited<ReturnType<Miniflare['getD1Database']>>;
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  await migrateTestD1(binding);
});
const fresh = draftDb(() => binding);

const REDIRECTS = 'src/content/redirects.yaml';

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
const stale = (repo: ReturnType<typeof bilingual>) =>
  staleLocales(
    'default',
    PAGE_FORM,
    {
      en: parseEntry('default', repo.read(PAGE_EN)),
      de: parseEntry('default', repo.read(PAGE_DE)),
    },
    'en',
  );

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

test('a publish retry finalizes the same durable commit after its D1 batch failed', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  let fail = true;
  const flakyBinding = new Proxy(binding, {
    get(target, key) {
      if (key !== 'batch') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args: Parameters<typeof binding.batch>) => {
        if (fail) {
          fail = false;
          throw new Error('finalization unavailable');
        }
        return target.batch(...args);
      };
    },
  });
  const flaky = openDb('default', flakyBinding);

  const failed = await publishDrafts('default', flaky, repo, undefined, undefined, undefined, {
    userId: 'u1',
  }).catch((error) => error);

  expect(failed).toBeInstanceOf(OperationFinalizationError);
  expect(repo.publish).toHaveBeenCalledTimes(1);
  expect((await pendingDrafts('default', db)).map((row) => row.path)).toEqual([PATH]);
  expect((await db.select().from(tables.operations))[0]).toMatchObject({
    kind: 'publish',
    state: 'committed',
    commitSha: failed.commitSha,
  });

  const retried = await publishDrafts('default', db, repo, undefined, undefined, undefined, {
    userId: 'u1',
  });

  expect(retried).toMatchObject({ commit_sha: failed.commitSha, paths: [PATH] });
  expect(repo.publish).toHaveBeenCalledTimes(1);
  expect(await pendingDrafts('default', db)).toEqual([]);
  expect((await db.select().from(tables.operations))[0]?.state).toBe('finalized');
  expect((await commitScope('default', db, failed.commitSha)).allows(PATH)).toBe(true);
});

test('a publish retry recovers a commit whose Git response was lost', async () => {
  const db = await fresh();
  const history = fakeHistory({ [PATH]: FILE });
  await saveDraft('default', db, history, PATH, { ...VALUES, rooms: 4 });
  const write = history.publish;
  let lose = true;
  history.publish = vi.fn(async (...args: Parameters<typeof write>) => {
    const committed = await write(...args);
    if (lose) {
      lose = false;
      throw new Error('the response was lost');
    }
    return committed;
  });

  await expect(
    publishDrafts('default', db, history, undefined, undefined, undefined, { userId: 'u1' }),
  ).rejects.toThrow('the response was lost');
  expect((await db.select().from(tables.operations))[0]?.state).toBe('intent');
  const committed = await history.getHead();
  history.push([{ path: OTHER, contents: OTHER_FILE.replace('rooms: 1', 'rooms: 2') }]);

  const recovered = await publishDrafts('default', db, history, undefined, undefined, undefined, {
    userId: 'u1',
  });

  expect(recovered?.commit_sha).toBe(committed);
  expect(await history.getHead()).not.toBe(committed);
  expect(history.publish).toHaveBeenCalledTimes(1);
  expect((await db.select().from(tables.operations))[0]?.state).toBe('finalized');
  expect(await pendingDrafts('default', db)).toEqual([]);
});

test('operation recovery refuses a real branch move and a tagged out-of-scope commit', async () => {
  const db = await fresh();
  const moved = fakeHistory({ [PATH]: FILE, [OTHER]: OTHER_FILE });
  const operation = await beginOperation('default', db, {
    retryKey: 'publish:refused-move',
    kind: 'publish',
    paths: [PATH],
    revisions: { [PATH]: 'revision' },
    baseSha: await moved.getHead(),
  });
  moved.push([{ path: OTHER, contents: OTHER_FILE.replace('rooms: 1', 'rooms: 2') }]);

  await expect(recoverOperationCommit('default', db, moved, operation)).rejects.toBeInstanceOf(
    RefMovedError,
  );

  const scoped = await fresh();
  const outside = fakeHistory({ [PATH]: FILE, [OTHER]: OTHER_FILE });
  const guarded = await beginOperation('default', scoped, {
    retryKey: 'publish:refused-scope',
    kind: 'publish',
    paths: [PATH],
    revisions: { [PATH]: 'revision' },
    baseSha: await outside.getHead(),
  });
  await outside.publish([{ path: OTHER, contents: OTHER_FILE }], {
    base_sha: await outside.getHead(),
    message: operationMessage('Wrong path', guarded.id),
  });

  await expect(recoverOperationCommit('default', scoped, outside, guarded)).rejects.toThrow(
    'outside its recorded operation scope',
  );
});

test('finalizing a committed publish rebases rather than losing a newer draft', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  let fail = true;
  const flaky = openDb(
    'default',
    new Proxy(binding, {
      get(target, key) {
        if (key !== 'batch') {
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (...args: Parameters<typeof binding.batch>) => {
          if (fail) {
            fail = false;
            throw new Error('finalization unavailable');
          }
          return target.batch(...args);
        };
      },
    }),
  );
  const failed = (await publishDrafts('default', flaky, repo, undefined, undefined, undefined, {
    userId: 'u1',
  }).catch((error) => error)) as OperationFinalizationError;
  expect(failed).toBeInstanceOf(OperationFinalizationError);
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 5 });

  const retried = await publishDrafts('default', db, repo, undefined, undefined, undefined, {
    userId: 'u1',
  });

  expect(retried?.commit_sha).toBe(failed.commitSha);
  expect(repo.publish).toHaveBeenCalledTimes(1);
  const row = await loadDraft('default', db, PATH);
  expect(row?.contents).toContain('rooms: 5');
  expect(row?.baseSha).toBe(failed.commitSha);
  expect(row?.publishedSha).toBeNull();
  expect((await pendingDrafts('default', db)).map((draft) => draft.path)).toEqual([PATH]);
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

test('a machine fill keeps the source snapshot it saw when the source moves before publish', async () => {
  const db = await fresh();
  const repo = bilingual();
  const source = {
    locale: 'en',
    contents: repo.read(PAGE_EN),
    blob_sha: await blobSha(repo.read(PAGE_EN)),
  };
  await saveTranslated(
    'default',
    db,
    repo,
    PAGE_DE,
    { 'blocks[_id=k3nf9a2p].heading': 'Zieh an die Küste!' },
    undefined,
    undefined,
    { form: PAGE_FORM, source },
  );
  const savedMark = mark((await loadDraft('default', db, PAGE_DE))?.contents ?? '');
  repo.write(PAGE_EN, page('Home', 'Move to the water', 'Ready to move?'));

  await publishDrafts('default', db, repo, sourceOf);

  expect(mark(repo.read(PAGE_DE))).toEqual(savedMark);
  expect(await stale(repo)).toEqual(['de']);
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

// A new translation left out of a publish is still the entry's, held with it until it goes too.
test('a draft left out of a publish keeps its words, its revision and its hold', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });
  await createDraft('default', db, repo, LISTING_DE, { title: '' });
  await holdEntry('default', db, [PATH, LISTING_DE], 'u1');
  const [german] = (await db.select().from(drafts)).filter((row) => row.path === LISTING_DE);
  const english = (await readyDrafts('default', db, ['listings/mill-house'])).filter(
    (row) => row.path === PATH,
  );

  const result = await publishDrafts('default', db, repo, undefined, undefined, english);

  expect(result?.paths).toEqual([PATH]);
  expect((await db.select().from(drafts)).find((row) => row.path === LISTING_DE)).toEqual(german);
  expect(await heldDrafts('default', db)).toMatchObject({ 'listings/mill-house': { id: 'u1' } });
});

// What an exclusion was judged against: a newer head could hold the file it said was absent.
test('a publish judged against an older commit is refused and records nothing', async () => {
  const db = await fresh();
  const repo = fakeRepo({ [PATH]: FILE });
  await saveDraft('default', db, repo, PATH, { ...VALUES, rooms: 4 });

  await expect(
    publishDrafts('default', db, repo, undefined, undefined, undefined, { baseSha: 'commit-old' }),
  ).rejects.toBeInstanceOf(RefMovedError);

  expect(repo.publish).not.toHaveBeenCalled();
  expect(await db.select().from(tables.operations)).toEqual([]);
  expect((await pendingDrafts('default', db)).map((row) => row.path)).toEqual([PATH]);
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
