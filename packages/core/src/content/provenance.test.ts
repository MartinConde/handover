import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { drifted, driftFile, listing, localeFile, millHouse, page } from './content.fixture.js';
import { parseEntry, stringifyEntry } from './entry-format.js';
import { translatableText } from './field-text.js';
import {
  changeSource,
  entrySource,
  markTranslation,
  provenance,
  sourceOnlyConflicts,
  staleLocales,
} from './provenance.js';
import type { Form } from './schema.js';
import { fieldAddress } from './translate.js';

const blobSha = (text: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest('hex');

// A shared price and a source-only note must not count as something to retranslate.
const translate = (en: string, de: string, was?: string) =>
  markTranslation(
    'default',
    millHouse,
    { locale: 'en', contents: en, blob_sha: 'e4a1c9b0'.repeat(5) },
    de,
    was,
  );
const marks = (file: string) =>
  (parseEntry('default', file) as { _i18n: Record<string, string> })._i18n;

test('a translation is marked with the source language it was made from', async () => {
  const de = await translate(localeFile('en'), localeFile('de'), undefined);

  expect(marks(de)).toEqual({
    sourceLocale: 'en',
    sourceBlob: 'e4a1c9b0'.repeat(5),
    sourceHash: expect.stringMatching(/^[0-9a-f]{16}$/),
    translatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
  });
});

test('the source language moving on makes the translation stale', async () => {
  const en = localeFile('en');
  const de = await translate(en, localeFile('de'));
  const moved = en.replace('A restored mill on the Dart.', 'A restored mill above the weir.');

  const files = {
    en: parseEntry('default', moved),
    de: parseEntry('default', de),
  };
  expect(await staleLocales('default', millHouse, files, 'en')).toEqual(['de']);
});

test('a shared value, a hidden one and a requoted file leave the translation current', async () => {
  const en = localeFile('en');
  const de = parseEntry('default', await translate(en, localeFile('de')));
  // Requoting moves `sourceBlob` but not `sourceHash`, which is why there are two of them.
  const same = {
    ...(parseEntry('default', en.replace(/"/g, "'")) as Record<string, unknown>),
    price: 450000,
    notes: 'Completion moved to October.',
  };

  expect(await staleLocales('default', millHouse, { en: same, de }, 'en')).toEqual([]);
});

test('a file nobody has marked is not stale', async () => {
  const files = {
    en: parseEntry('default', localeFile('en')),
    de: parseEntry('default', localeFile('de')),
  };

  expect(await staleLocales('default', millHouse, files, 'en')).toEqual([]);
});

test('a block moved in the source language is not something to retranslate', async () => {
  const en = drifted('en');
  const de = await markTranslation(
    'default',
    page,
    { locale: 'en', contents: driftFile('en'), blob_sha: 'e4a1c9b0'.repeat(5) },
    driftFile('de'),
    undefined,
  );
  const [hero, cta] = en.blocks as Record<string, unknown>[];

  const files = { en: { ...en, blocks: [cta, hero] }, de: parseEntry('default', de) };
  expect(await staleLocales('default', page, files, 'en')).toEqual([]);
});

// A structural or shared-value edit rewrites the German file without anybody translating it.
test('a translation carried along by a structural edit keeps the mark it had', async () => {
  const was = await translate(localeFile('en'), localeFile('de'), undefined);
  const en = localeFile('en').replace('Mill House', 'The Mill House');
  const carried = was.replace('price: 425000', 'price: 450000');

  expect(await translate(en, carried, was)).toBe(carried);
});

test('a translation somebody typed into is marked with the source language as it now is', async () => {
  const was = await translate(localeFile('en'), localeFile('de'), undefined);
  const en = localeFile('en').replace(
    'A restored mill on the Dart.',
    'A restored mill above the weir.',
  );
  const typed = was.replace('Eine restaurierte Mühle am Dart.', 'Eine restaurierte Mühle am Wehr.');

  const marked = await translate(en, typed, was);

  expect(marks(marked).sourceHash).not.toBe(marks(was).sourceHash);
  expect(
    await staleLocales(
      'default',
      millHouse,
      {
        en: parseEntry('default', en),
        de: parseEntry('default', marked),
      },
      'en',
    ),
  ).toEqual([]);
});

test('adding the first translated value refreshes an existing provenance mark', async () => {
  const oldSource = localeFile('en');
  const empty = stringifyEntry('default', { _version: 1 });
  const was = await translate(oldSource, empty, undefined);
  const moved = oldSource.replace('Mill House', 'The Mill House');
  const filled = stringifyEntry('default', {
    ...(parseEntry('default', was) as object),
    title: 'Das Mühlenhaus',
  });

  const marked = await translate(moved, filled, was);

  expect(marks(marked).sourceHash).not.toBe(marks(was).sourceHash);
});

test('deleting the last translated value refreshes its provenance mark', async () => {
  const oldSource = localeFile('en');
  const was = await translate(
    oldSource,
    stringifyEntry('default', { _version: 1, title: 'Das Mühlenhaus' }),
    undefined,
  );
  const moved = oldSource.replace('Mill House', 'The Mill House');
  const withoutTitle = parseEntry('default', was) as Record<string, unknown>;
  delete withoutTitle.title;

  const marked = await translate(moved, stringifyEntry('default', withoutTitle), was);

  expect(marks(marked).sourceHash).not.toBe(marks(was).sourceHash);
});

test('a mark that says nothing about the values is not a claim to be stale', async () => {
  const de = {
    ...(parseEntry('default', localeFile('de')) as object),
    _i18n: { sourceLocale: 'en' },
  };

  expect(
    await staleLocales(
      'default',
      millHouse,
      { en: parseEntry('default', localeFile('en')), de },
      'en',
    ),
  ).toEqual([]);
});

// Made from French while the entry is written in English: nothing says it matches the English.
const fromFrench = (fr: string) =>
  markTranslation(
    'default',
    millHouse,
    { locale: 'fr', contents: fr, blob_sha: 'f7e6d5c4'.repeat(5) },
    localeFile('de'),
    undefined,
  );

test('a translation made from a language other than the source is stale, however current', async () => {
  const fr = localeFile('en');
  const de = parseEntry('default', await fromFrench(fr));

  const files = { en: parseEntry('default', localeFile('en')), fr: parseEntry('default', fr), de };
  expect(await staleLocales('default', millHouse, files, 'en')).toEqual(['de']);
});

test('a translation made from a language that has since gone still reads stale', async () => {
  const de = parseEntry('default', await fromFrench(localeFile('en')));

  expect(
    await staleLocales(
      'default',
      millHouse,
      { en: parseEntry('default', localeFile('en')), de },
      'en',
    ),
  ).toEqual(['de']);
});

test('the source keeps the mark it was once translated with and is never stale', async () => {
  const de = await translate(localeFile('en'), localeFile('de'));
  const moved = localeFile('en').replace('Mill House', 'The Mill House');

  const files = { en: parseEntry('default', moved), de: parseEntry('default', de) };
  expect(await staleLocales('default', millHouse, files, 'de')).toEqual([]);
});

// A field with no editor in the second column is not filled, or nobody can take the badge off.
test('the values offered for translation are the prose the translated form draws', () => {
  expect(translatableText('default', millHouse, parseEntry('default', localeFile('en')))).toEqual([
    { path: 'title', text: 'Mill House' },
    { path: 'summary', text: 'A restored mill on the Dart.' },
    { path: 'blocks[_id=k3nf9a2p].heading', text: 'Wake up to the water' },
  ]);
});

test('a link offers its label and never where it points', () => {
  const form: Form = {
    fields: [
      { path: ['body'], label: 'Body', type: 'richtext', required: false, tier: 'basic' },
      { path: ['cta'], label: 'Call to action', type: 'link', required: false },
    ],
    blocks: {},
  };
  const data = { body: 'A **line**.', cta: { type: 'url', href: 'https://x.test', label: 'Book' } };

  expect(translatableText('default', form, data)).toEqual([
    { path: 'body', text: 'A **line**.' },
    { path: 'cta.label', text: 'Book' },
  ]);
});

// The reported address must match the form's field ids, or a badge sits on the wrong field.
test('a reported path is the one the form derives for the same field', () => {
  const en = parseEntry('default', localeFile('en'));
  const [, , block] = translatableText('default', millHouse, en);

  expect(fieldAddress('default', ['blocks', '0', 'heading'], en)).toBe(block?.path);
});

const one = { locales: ['en'], defaultLocale: 'en' };
const two = { locales: ['en', 'de'], defaultLocale: 'en' };
const three = { locales: ['en', 'de', 'fr'], defaultLocale: 'en' };

test.each([
  {
    name: 'a one-language site answers its default language and ignores marks',
    i18n: one,
    files: { en: { _source: 'de', title: 'Home' }, de: { title: 'Start' } },
    source: { locale: 'en', recorded: false },
  },
  {
    name: 'an entry with no file has no source',
    i18n: two,
    files: { en: undefined },
    source: undefined,
  },
  {
    name: 'two files claiming different sources is a conflict',
    i18n: three,
    files: { en: { _source: 'en' }, de: { _source: 'de' }, fr: { title: 'Accueil' } },
    source: { problem: 'conflict', marks: { en: 'en', de: 'de' } },
  },
  {
    name: 'a source the site does not declare is refused',
    i18n: two,
    files: { en: { _source: 'it' }, de: { _source: 'it' } },
    source: { problem: 'undeclared', marks: { en: 'it', de: 'it' } },
  },
  {
    name: 'a source with no file of its own is refused',
    i18n: three,
    files: { en: { _source: 'de' } },
    source: { problem: 'missing', marks: { en: 'de' } },
  },
  {
    name: 'a recorded source is the answer',
    i18n: two,
    files: { en: { _source: 'de' }, de: { _source: 'de' } },
    source: { locale: 'de', recorded: true },
  },
  {
    name: 'an unmarked file beside a marked one agrees with it',
    i18n: three,
    files: { en: { title: 'Notice' }, de: { _source: 'de' }, fr: { title: 'Avis' } },
    source: { locale: 'de', recorded: true },
  },
  {
    name: 'an unrecorded entry with one file is written in that language',
    i18n: three,
    files: { de: { title: 'Impressum' } },
    source: { locale: 'de', recorded: false },
  },
  {
    name: 'an unrecorded entry with several files falls back to the default language first',
    i18n: three,
    files: { fr: { title: 'Avis' }, de: { title: 'Hinweis' }, en: { title: 'Notice' } },
    source: { locale: 'en', recorded: false },
  },
  {
    name: 'an unrecorded entry without the default language falls back in declared order',
    i18n: three,
    files: { fr: { title: 'Avis' }, de: { title: 'Hinweis' } },
    source: { locale: 'de', recorded: false },
  },
  {
    name: 'a recorded German source survives reordered locales and a new default language',
    i18n: { locales: ['fr', 'en', 'de'], defaultLocale: 'fr' },
    files: { en: { _source: 'de' }, de: { _source: 'de' }, fr: {} },
    source: { locale: 'de', recorded: true },
  },
  {
    name: 'undeclared folders take no part in the answer',
    i18n: two,
    files: { en: { title: 'Notice' }, it: { _source: 'it' } },
    source: { locale: 'en', recorded: false },
  },
])('$name', ({ i18n, files, source }) => {
  expect(entrySource('default', i18n, files)).toEqual(source);
});

// Marks made by the real markTranslation, so every hash here is one the CMS would write.
const markedFrom = async (source: [string, unknown], data: unknown) =>
  parseEntry(
    'default',
    await markTranslation(
      'default',
      listing,
      { locale: source[0], contents: stringifyEntry('default', source[1]), blob_sha: 'old' },
      stringifyEntry('default', data),
      undefined,
    ),
  ) as Record<string, unknown>;
const markOf = (data: unknown) => (data as { _i18n?: Record<string, string> })._i18n;
const change = { blob: 'b10b'.repeat(10), at: '2026-09-18T12:00:00.000Z' };

test('promoting a translation in sync rebases the old source and the translations in sync', async () => {
  const en = { title: 'Mill House', summary: 'A mill.' };
  const de = await markedFrom(['en', en], { title: 'Mühlenhaus', summary: 'Eine Mühle.' });
  const fr = await markedFrom(['en', en], { title: 'Moulin', summary: 'Un moulin.' });
  const it = await markedFrom(['en', { ...en, summary: 'Old.' }], { title: 'Mulino' });
  const deHash = markOf(await markedFrom(['de', de], {}))?.sourceHash;

  const marks = await provenance(
    'default',
    listing,
    { en, de, fr, it },
    { from: 'en', to: 'de', ...change },
  );

  const rebased = { sourceLocale: 'de', sourceBlob: change.blob, sourceHash: deHash };
  expect(marks).toEqual({
    en: { ...rebased, translatedAt: change.at },
    de: undefined,
    fr: { ...rebased, translatedAt: markOf(fr)?.translatedAt },
    it: markOf(it),
  });
});

test('promoting a translation that is behind or unmarked rebases nothing', async () => {
  const en = { title: 'Mill House', summary: 'A mill.' };
  const behind = await markedFrom(['en', { title: 'Mill' }], { title: 'Mühlenhaus' });
  const fr = await markedFrom(['en', en], { title: 'Moulin' });

  for (const de of [behind, { title: 'Mühlenhaus' }]) {
    const marks = await provenance(
      'default',
      listing,
      { en, de, fr },
      { from: 'en', to: 'de', ...change },
    );

    expect(marks).toEqual({ en: undefined, de: undefined, fr: markOf(fr) });
  }
});

test('a translation made from a language in sync with the source is rebased onto the source', async () => {
  const en = { title: 'Mill House', summary: 'A mill.' };
  const de = await markedFrom(['en', en], { title: 'Mühlenhaus', summary: 'Eine Mühle.' });
  const fr = await markedFrom(['de', de], { title: 'Moulin', summary: 'Un moulin.' });
  const enHash = markOf(de)?.sourceHash;

  const marks = await provenance(
    'default',
    listing,
    { en, de, fr },
    { from: 'de', to: 'en', ...change },
  );

  const rebased = { sourceLocale: 'en', sourceBlob: change.blob, sourceHash: enHash };
  expect(marks).toEqual({
    en: undefined,
    de: { ...rebased, translatedAt: markOf(de)?.translatedAt },
    fr: { ...rebased, translatedAt: markOf(fr)?.translatedAt },
  });
});

const at = change.at;

test('a source change to a translation in sync rebases the old source and the translations in sync', async () => {
  const en = { _version: 1, _source: 'en', title: 'Mill House', summary: 'A mill.' };
  const de = await markedFrom(['en', en], {
    _version: 1,
    title: 'Mühlenhaus',
    summary: 'Eine Mühle.',
  });
  const fr = await markedFrom(['en', en], { _version: 1, title: 'Moulin', summary: 'Un moulin.' });
  const it = await markedFrom(['en', { ...en, summary: 'Old.' }], { _version: 1, title: 'Mulino' });

  const out = await changeSource(
    'default',
    listing,
    { en, de, fr, it },
    { from: 'en', to: 'de', at },
  );

  const { _i18n, ...deWords } = de;
  const rebased = {
    sourceLocale: 'de',
    sourceBlob: blobSha(stringifyEntry('default', out.de)),
    sourceHash: markOf(await markedFrom(['de', out.de], {}))?.sourceHash,
  };
  expect(out).toEqual({
    en: { ...en, _source: 'de', _i18n: { ...rebased, translatedAt: at } },
    de: { ...deWords, _source: 'de' },
    fr: { ...fr, _source: 'de', _i18n: { ...rebased, translatedAt: markOf(fr)?.translatedAt } },
    it: { ...it, _source: 'de' },
  });
  expect(await staleLocales('default', listing, out, 'de')).toEqual(['it']);
});

test('a source change to a translation behind or never marked rebases nothing', async () => {
  const en = { _version: 1, title: 'Mill House', summary: 'A mill.' };
  const fr = await markedFrom(['en', en], { _version: 1, title: 'Moulin' });
  const behind = await markedFrom(['en', { title: 'Mill' }], { _version: 1, title: 'Mühlenhaus' });

  for (const de of [behind, { _version: 1, title: 'Mühlenhaus' }]) {
    const out = await changeSource(
      'default',
      listing,
      { en, de, fr },
      { from: 'en', to: 'de', at },
    );

    expect(out).toEqual({
      en: { ...en, _source: 'de' },
      de: { _version: 1, _source: 'de', title: 'Mühlenhaus' },
      fr: { ...fr, _source: 'de' },
    });
    expect(await staleLocales('default', listing, out, 'de')).toEqual(['fr']);
  }
});

// `notes` and each room's `note` are source-only; `size` is every language's.
const rooms: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['notes'], label: 'Notes', type: 'text', required: false, i18n: false },
    { path: ['rooms'], label: 'Rooms', type: 'blocks', required: true, types: ['room'] },
  ],
  blocks: {
    room: [
      { path: ['heading'], label: 'Heading', type: 'text', required: true },
      { path: ['size'], label: 'Size', type: 'number', required: false, i18n: 'duplicate' },
      { path: ['note'], label: 'Note', type: 'text', required: false, i18n: false },
    ],
  },
};
const roomsEn = {
  _version: 1,
  title: 'Mill House',
  notes: 'Keys under the mat',
  rooms: [
    { _type: 'room', _id: 'k1tchen0', heading: 'Kitchen', size: 20, note: 'Tiles' },
    { _type: 'room', _id: 'ha11way0', heading: 'Hall', size: 8, note: 'Draughty' },
  ],
  _machine: ['title'],
};
// Moved rows and an out-of-date size: the German file is paired by `_id`, not by position.
const roomsDe = {
  _version: 1,
  _machine: ['rooms[_id=k1tchen0].heading'],
  title: 'Mühlenhaus',
  rooms: [
    { _type: 'room', _id: 'ha11way0', heading: 'Flur', size: 7 },
    { _type: 'room', _id: 'k1tchen0', heading: 'Küche', size: 18 },
  ],
};

test('the new source takes the shared and source-only values row by row and keeps its words', async () => {
  const out = await changeSource(
    'default',
    rooms,
    { en: roomsEn, de: { ...roomsDe, _i18n: { sourceLocale: 'en' } } },
    { from: 'en', to: 'de', at },
  );

  expect(out.de).toEqual({
    _version: 1,
    _source: 'de',
    _machine: ['rooms[_id=k1tchen0].heading'],
    title: 'Mühlenhaus',
    notes: 'Keys under the mat',
    rooms: [
      { _type: 'room', _id: 'ha11way0', heading: 'Flur', size: 8, note: 'Draughty' },
      { _type: 'room', _id: 'k1tchen0', heading: 'Küche', size: 20, note: 'Tiles' },
    ],
  });
});

test('the old source keeps its source-only values and every file keeps its machine marks', async () => {
  const fr = { _version: 1, _machine: ['title'], title: 'Moulin', rooms: [] };

  const out = await changeSource(
    'default',
    rooms,
    { en: roomsEn, de: roomsDe, fr },
    { from: 'en', to: 'de', at },
  );

  expect(out.en).toEqual({ ...roomsEn, _source: 'de' });
  expect(out.fr).toEqual({ ...fr, _source: 'de' });
});

test('choosing a source for an entry without one stamps every file and takes nothing', async () => {
  const fr = await markedFrom(['en', roomsEn], { _version: 1, _source: 'en', title: 'Moulin' });
  const de = { ...roomsDe, _source: 'de', _i18n: { sourceLocale: 'en' } };

  const out = await changeSource('default', rooms, { en: roomsEn, de, fr }, { to: 'de', at });

  expect(out).toEqual({
    en: { ...roomsEn, _source: 'de' },
    de: { ...roomsDe, _source: 'de' },
    fr: { ...fr, _source: 'de' },
  });
});

test('a source-only value the new source holds and the old one does not is a conflict', () => {
  const de = {
    notes: 'Schlüssel beim Nachbarn',
    rooms: [
      { _type: 'room', _id: 'k1tchen0', note: 'Tiles' },
      { _type: 'room', _id: 'ha11way0', note: 'Zugig' },
    ],
  };
  const agreeing = { notes: '', rooms: [{ _type: 'room', _id: 'k1tchen0', note: 'Tiles' }] };

  expect(sourceOnlyConflicts(rooms, roomsEn, de)).toEqual(['notes', 'rooms[_id=ha11way0].note']);
  expect(sourceOnlyConflicts(rooms, roomsEn, agreeing)).toEqual([]);
});
