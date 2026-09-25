import type { Miniflare } from 'miniflare';
import { beforeAll, expect, test } from 'vitest';
import { parseEntry, stringifyEntry } from '../content/entry-format.js';
import type { Form } from '../content/schema.js';
import {
  draftDb,
  fakeHistory,
  fakeRepo,
  MOVED,
  migrateTestD1,
  newTestD1,
  only,
  PAGE_DE,
  PAGE_EN,
  PAGE_FORM,
  page,
} from '../db.fixtures.js';
import { blobSha } from '../publishing/git.js';
import { drafts } from '../tables.js';
import { draftFiles } from './committed.js';
import { entryConflict, resolveConflict, resolveDrift } from './conflicts.js';
import { loadDraft, pendingDrafts, saveDraft } from './drafts.js';

const mf = newTestD1();
let binding: Awaited<ReturnType<Miniflare['getD1Database']>>;
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  await migrateTestD1(binding);
});
const fresh = draftDb(() => binding);

// A drift answer moves a block between files, so every file it changes is written together.
const drifted = (title: string, blocks: string[]) =>
  ['_version: 1', `title: "${title}"`, 'blocks:', ...blocks, ''].join('\n');
const HERO = ['  - _type: "hero"', '    _id: "k3nf9a2p"', '    heading: "Hallo"'];
const QUOTE = ['  - _type: "quote"', '    _id: "z9y8x7w6"', '    body: "Ein seltener Fund."'];
const CTA = ['  - _type: "cta"', '    _id: "q1w2e3r4"', '    heading: "Los"'];
const PAGE_PATHS = { en: PAGE_EN, de: PAGE_DE };

// The report is `resolve.ts`'s; proven here is reading the three sides and the row left behind.
const PAGE_FILES = { en: PAGE_EN };

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

test('resolving a stored conflict keeps the draft menu change named by the report', async () => {
  const db = await fresh();
  const path = 'src/content/globals/en/navigation.yaml';
  const form: Form = {
    fields: [
      { path: ['title'], label: 'Title', type: 'text', required: true },
      { path: ['menus'], label: 'Menus', type: 'menus', required: true, i18n: 'duplicate' },
    ],
    blocks: {},
  };
  const item = (label: string) => ({
    _id: 'home0001',
    label,
    link: { type: 'url', href: '/' },
  });
  const entry = (title: string, label: string) => ({
    _version: 1,
    title,
    menus: [{ _id: 'menu0001', key: 'header', items: [item(label)] }],
  });
  const base = stringifyEntry('default', entry('Navigation', 'Home'));
  const repo = fakeHistory({ [path]: base });
  await saveDraft('default', db, repo, path, entry('Navigation', 'Welcome'));
  repo.push([{ path, contents: stringifyEntry('default', entry('Main navigation', 'Home')) }]);

  const conflict = await entryConflict('default', db, repo, form, { en: path });
  if (!conflict) throw new Error('the repository edit above is what makes this a conflict');
  expect(conflict.merged.map((change) => [change.change.path, change.side])).toEqual([
    ['menus[_id=menu0001].items[_id=home0001].label', 'ours'],
    ['title', 'theirs'],
  ]);

  await resolveConflict('default', db, form, conflict, []);

  expect(parseEntry('default', (await loadDraft('default', db, path))?.contents ?? '')).toEqual(
    entry('Main navigation', 'Welcome'),
  );
});

test('conflict resolution refuses duplicate identities before rebasing the draft', async () => {
  const db = await fresh();
  const repo = fakeHistory({ [PAGE_EN]: page('Home', 'Move to the coast', 'Ready to move?') });
  await saveDraft('default', db, repo, PAGE_EN, MOVED);
  const before = await loadDraft('default', db, PAGE_EN);
  if (!before) throw new Error('Expected the draft to be open');
  const duplicate = {
    _version: 1,
    title: 'Home',
    blocks: MOVED.blocks,
    opaque: [
      { _id: 'same0001', heading: 'One' },
      { _id: 'same0001', heading: 'Two' },
    ],
  };

  await expect(
    resolveConflict(
      'default',
      db,
      PAGE_FORM,
      {
        head: 'commit-B',
        sides: { en: { base: duplicate, ours: duplicate, theirs: duplicate } },
        conflicted: {
          en: { path: PAGE_EN, blob: 'new-blob', revision: before.revision },
        },
        questions: [],
        merged: [],
      },
      [],
    ),
  ).rejects.toThrow(
    'opaque[1]._id: duplicate row identity "same0001"; already used at opaque[0]._id',
  );
  expect(await loadDraft('default', db, PAGE_EN)).toEqual(before);
});

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
