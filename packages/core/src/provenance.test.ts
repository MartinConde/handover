import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { article, listing, localeFile } from './content.fixtures.js';
import { parseEntry, stringifyEntry } from './entry-format.js';
import {
  answeredCount,
  answeredPaths,
  answeredWork,
  changeSource,
  entrySource,
  markTranslation,
  provenance,
  referenceText,
  sourceOnlyConflicts,
  staleLocales,
  translatableText,
} from './provenance.js';
import type { Form } from './schema.js';
import { fieldAddress } from './translate.js';

const answeredText = (
  _siteId: string,
  form: Form,
  source: unknown,
  target: unknown,
  locale: string,
) =>
  answeredCount(
    answeredPaths('default', form, source),
    answeredPaths('default', form, target),
    locale,
  );

const blobSha = (text: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest('hex');

// `notes` is the source locale's alone and the German file holds only translations.
const millHouse: Form = {
  fields: [
    ...listing.fields,
    { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['hero'] },
  ],
  blocks: article.blocks,
};

// DE has the shared blocks plus `compliance` marked `_locales: [de]` and an unmarked `quote`.
const page: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    {
      path: ['blocks'],
      label: 'Blocks',
      type: 'blocks',
      required: true,
      types: ['hero', 'cta', 'compliance', 'quote'],
    },
  ],
  blocks: {
    hero: [
      { path: ['heading'], label: 'Heading', type: 'text', required: true },
      { path: ['image'], label: 'Image', type: 'image', required: false, preset: { max: 2400 } },
    ],
    cta: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
    compliance: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
    quote: [{ path: ['body'], label: 'Body', type: 'text', required: true }],
  },
};

const driftFile = (locale: string) =>
  readFileSync(join(import.meta.dirname, '../test/drift', locale, 'home.yaml'), 'utf8');
const drifted = (locale: string) =>
  parseEntry('default', driftFile(locale)) as Record<string, unknown>;

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

// Mirrors the six-language `structured` fixture in packages/ui, as plain data.
const harbourForm: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['summary'], label: 'Summary', type: 'richtext', required: false, tier: 'full' },
    {
      path: ['details'],
      label: 'Details',
      type: 'group',
      required: false,
      i18n: 'duplicate',
      fields: [
        { path: ['sleeps'], label: 'Sleeps', type: 'number', required: false },
        { path: ['caption'], label: 'Caption', type: 'text', required: false, i18n: true },
      ],
    },
    {
      path: ['rooms'],
      label: 'Rooms',
      type: 'array',
      required: false,
      item: [{ path: ['name'], label: 'Name', type: 'text', required: true }],
    },
    {
      path: ['features'],
      label: 'Features',
      type: 'array',
      required: false,
      item: [{ path: [], label: '', type: 'text', required: true }],
    },
    { path: ['photo'], label: 'Photo', type: 'image', required: false, preset: {} },
    { path: ['brochure'], label: 'Brochure', type: 'file', required: false, accept: [] },
    { path: ['video'], label: 'Video', type: 'embed', required: false },
    { path: ['seo'], label: 'SEO', type: 'seo', required: false },
    { path: ['body'], label: 'Body', type: 'blocks', required: false, types: ['cta'] },
  ],
  blocks: {
    cta: [
      { path: ['heading'], label: 'Heading', type: 'text', required: true },
      { path: ['button'], label: 'Button', type: 'link', required: false },
    ],
  },
};
const harbourEn = {
  title: 'Harbour House',
  summary: '**Quiet** rooms above the harbour.',
  details: { sleeps: 6, caption: 'Sleeps six' },
  rooms: [
    { _id: 'room0001', name: 'Harbour room' },
    { _id: 'room0002', name: 'Garden room' },
  ],
  features: ['Sea view', 'Log burner'],
  photo: { src: 'media/harbour.webp', alt: 'The harbour at dusk' },
  brochure: { src: 'files/brochure.pdf', name: 'Harbour House brochure.pdf' },
  video: { provider: 'youtube', id: 'dQw4w9WgXcQ', title: 'Walk through the house' },
  seo: {
    title: 'Harbour House holiday let',
    description: 'A quiet house above the harbour.',
    image: { src: 'media/harbour.webp', alt: 'The harbour at dusk' },
  },
  body: [
    {
      _type: 'cta',
      _id: 'cta00001',
      heading: 'Book your stay',
      button: { type: 'url', href: 'https://example.com/book', label: 'Book now' },
    },
  ],
};
const harbourDe = {
  title: 'Haus am Hafen',
  summary: '**Ruhige** Zimmer über dem Hafen.',
  details: { sleeps: 6, caption: 'Für sechs Personen' },
  rooms: [
    { _id: 'room0002', name: 'Gartenzimmer' },
    { _id: 'room0001', name: 'Hafenzimmer' },
  ],
  features: ['Meerblick', 'Kaminofen'],
  photo: { src: 'media/harbour.webp', alt: 'Der Hafen in der Dämmerung' },
  brochure: { src: 'files/brochure.pdf', name: 'Haus am Hafen Broschüre.pdf' },
  video: { provider: 'youtube', id: 'dQw4w9WgXcQ', title: 'Rundgang durch das Haus' },
  seo: {
    title: 'Ferienhaus am Hafen',
    description: 'Ein ruhiges Haus über dem Hafen.',
    image: { src: 'media/harbour.webp', alt: 'Der Hafen in der Dämmerung' },
  },
  body: [
    {
      _type: 'cta',
      _id: 'cta00001',
      heading: 'Jetzt buchen',
      button: { type: 'url', href: 'https://example.com/book', label: 'Buchen' },
    },
  ],
};
// What creating a translation writes: the structure and shared values, no words.
const harbourCreated = {
  details: { sleeps: 6 },
  rooms: [{ _id: 'room0001' }, { _id: 'room0002' }],
  photo: { src: 'media/harbour.webp' },
  brochure: { src: 'files/brochure.pdf' },
  video: { provider: 'youtube', id: 'dQw4w9WgXcQ' },
  seo: { image: { src: 'media/harbour.webp' } },
  body: [
    { _type: 'cta', _id: 'cta00001', button: { type: 'url', href: 'https://example.com/book' } },
  ],
};

// Title, summary, caption, two room names, two features, photo alt, brochure name, video title,
// SEO title, description and image alt, the block heading and its button label.
test('every translated text and structured prop of the source is owed once', () => {
  expect(answeredText('default', harbourForm, harbourEn, harbourDe, 'de')).toEqual({
    written: 15,
    of: 15,
  });
});

test('a created translation with no words answers none of the source', () => {
  expect(answeredText('default', harbourForm, harbourEn, harbourCreated, 'de')).toEqual({
    written: 0,
    of: 15,
  });
});

test('a moved row is matched by its id, not its position', () => {
  const de = {
    ...harbourCreated,
    rooms: [{ _id: 'room0002' }, { _id: 'room0001', name: 'Hafenzimmer' }],
    body: [{ _type: 'cta', _id: 'cta00001', heading: 'Jetzt buchen' }],
  };
  const en = { ...harbourEn, rooms: [{ _id: 'room0001', name: 'Harbour room' }] };

  expect(answeredText('default', harbourForm, en, de, 'de')).toEqual({ written: 2, of: 14 });
});

test('a list of plain values has no ids, so its rows pair by position', () => {
  const de = { ...harbourCreated, features: ['Meerblick'] };

  expect(answeredText('default', harbourForm, harbourEn, de, 'de')).toEqual({
    written: 1,
    of: 15,
  });
});

test('source text that is empty or only whitespace is not owed', () => {
  const en = {
    ...harbourEn,
    title: '   ',
    summary: '',
    photo: { src: 'media/harbour.webp', alt: '' },
    seo: { title: 'Harbour House holiday let' },
  };

  expect(answeredText('default', harbourForm, en, harbourDe, 'de')).toEqual({
    written: 10,
    of: 10,
  });
});

test('a translation of only whitespace is not an answer', () => {
  const de = { ...harbourDe, title: ' \t ', seo: { ...harbourDe.seo, title: ' ' } };

  expect(answeredText('default', harbourForm, harbourEn, de, 'de')).toEqual({
    written: 13,
    of: 15,
  });
});

test('words only the translation has do not count toward the source', () => {
  const de = {
    ...harbourDe,
    subtitle: 'Nur auf Deutsch',
    rooms: [...harbourDe.rooms, { _id: 'room0003', name: 'Dachzimmer' }],
  };

  expect(answeredText('default', harbourForm, harbourEn, de, 'de')).toEqual({
    written: 15,
    of: 15,
  });
});

// What the rich-text editor stores once its words are deleted, read from TipTap's own output.
test.each([
  ['an empty document', ''],
  ['empty paragraphs', '\n\n'],
  ['an empty bullet list', '- '],
  ['an empty numbered list', '1. '],
  ['an empty quote', '>'],
  ['an empty heading', '## '],
  ['a non-breaking space', '&nbsp;'],
  ['a line break alone', '<br>'],
])('rich text holding %s is not an answer', (_, empty) => {
  const de = { ...harbourDe, summary: empty };

  expect(answeredText('default', harbourForm, harbourEn, de, 'de')).toEqual({
    written: 14,
    of: 15,
  });
});

test.each([
  ['a word in a list item', '- Ruhig'],
  ['link text', '[Buchen](https://example.com/book)'],
  ['a quoted line', '> Ruhig'],
  ['a single emphasised word', '*ruhig*'],
])('rich text holding %s is an answer', (_, words) => {
  const de = { ...harbourCreated, summary: words };

  expect(answeredText('default', harbourForm, harbourEn, de, 'de')).toEqual({
    written: 1,
    of: 15,
  });
});

test('shared, source-only and non-text values are never owed', () => {
  const form: Form = {
    fields: [
      { path: ['title'], label: 'Title', type: 'text', required: true },
      { path: ['price'], label: 'Price', type: 'text', required: true, i18n: 'duplicate' },
      { path: ['notes'], label: 'Notes', type: 'text', required: false, i18n: false },
      { path: ['sleeps'], label: 'Sleeps', type: 'number', required: false },
      { path: ['kind'], label: 'Kind', type: 'select', required: false, options: ['a', 'b'] },
      { path: ['open'], label: 'Open', type: 'date', required: false },
      { path: ['dogs'], label: 'Dogs', type: 'boolean', required: false },
      { path: ['host'], label: 'Host', type: 'reference', required: false, collection: 'people' },
      { path: ['map'], label: 'Map', type: 'unsupported' },
      { path: ['nav'], label: 'Menus', type: 'menus', required: false },
      {
        path: ['cta'],
        label: 'Call to action',
        type: 'link',
        required: false,
        i18n: 'duplicate',
      },
    ],
    blocks: {},
  };
  const en = {
    title: 'Harbour House',
    price: '€180',
    notes: 'Key box',
    sleeps: 6,
    kind: 'a',
    open: '2026-05-01',
    dogs: true,
    host: 'people/ana',
    map: { lat: 1, lng: 2 },
    nav: [{ key: 'main', items: [{ label: 'Home', link: '/' }] }],
    cta: { type: 'url', href: 'https://example.com', label: 'Book' },
  };

  expect(answeredText('default', form, en, { ...en, title: 'Haus am Hafen' }, 'de')).toEqual({
    written: 1,
    of: 1,
  });
});

test("a field's own i18n outranks the mode of the group or rows around it", () => {
  const form: Form = {
    fields: [
      {
        path: ['facts'],
        label: 'Facts',
        type: 'group',
        required: false,
        i18n: false,
        fields: [
          { path: ['note'], label: 'Note', type: 'text', required: false },
          { path: ['caption'], label: 'Caption', type: 'text', required: false, i18n: true },
        ],
      },
      {
        path: ['body'],
        label: 'Body',
        type: 'blocks',
        required: false,
        types: ['hero'],
        i18n: 'duplicate',
      },
    ],
    blocks: {
      hero: [
        { path: ['code'], label: 'Code', type: 'text', required: false },
        { path: ['heading'], label: 'Heading', type: 'text', required: false, i18n: true },
      ],
    },
  };
  const en = {
    facts: { note: 'Internal', caption: 'Sleeps six' },
    body: [{ _type: 'hero', _id: 'hero0001', code: 'H1', heading: 'Above the harbour' }],
  };

  expect(answeredText('default', form, en, en, 'de')).toEqual({ written: 2, of: 2 });
});

test('a row written only to other languages is not owed by this one', () => {
  const en = {
    ...harbourEn,
    rooms: [
      { _id: 'room0001', name: 'Harbour room' },
      { _id: 'room0002', _locales: ['en', 'fr'], name: 'Garden room' },
    ],
  };

  expect(answeredText('default', harbourForm, en, harbourCreated, 'de')).toEqual({
    written: 0,
    of: 14,
  });
});

test('the work of a language is every owed path, and the ones its file leaves empty', () => {
  const de = { ...harbourCreated, title: 'Haus am Hafen' };

  const work = answeredWork(
    answeredPaths('default', harbourForm, harbourEn),
    answeredPaths('default', harbourForm, de),
    'de',
  );

  expect(work.paths).toEqual(answeredPaths('default', harbourForm, harbourEn).paths);
  expect(work.unanswered[0]).toBe('summary');
  expect(work.unanswered).toHaveLength(14);
  expect(work.unanswered).not.toContain('title');
});

test('a row written only to other languages is no part of this one\u2019s work', () => {
  const en = {
    ...harbourEn,
    rooms: [
      { _id: 'room0001', name: 'Harbour room' },
      { _id: 'room0002', _locales: ['en', 'fr'], name: 'Garden room' },
    ],
  };

  const work = answeredWork(
    answeredPaths('default', harbourForm, en),
    answeredPaths('default', harbourForm, harbourCreated),
    'de',
  );

  expect(work.paths).not.toContain('rooms[_id=room0002].name');
  expect(work.unanswered).not.toContain('rooms[_id=room0002].name');
  expect(work.paths).toHaveLength(14);
});

test('a reference reads out exactly the paths the answered count walks', () => {
  const { values } = referenceText('default', harbourForm, harbourDe, 'de');

  expect(Object.keys(values)).toEqual(answeredPaths('default', harbourForm, harbourDe).paths);
});

test('a reference carries the stored alt, link label and SEO text by core path', () => {
  const { values } = referenceText('default', harbourForm, harbourDe, 'de');

  expect(values['photo.alt']).toBe('Der Hafen in der Dämmerung');
  expect(values['body[_id=cta00001].button.label']).toBe('Buchen');
  expect(values['seo.title']).toBe('Ferienhaus am Hafen');
  expect(values['seo.description']).toBe('Ein ruhiges Haus über dem Hafen.');
  expect(values['seo.image.alt']).toBe('Der Hafen in der Dämmerung');
  expect(values.summary).toBe('**Ruhige** Zimmer über dem Hafen.');
});

test("a row whose _locales leave the reference out is not among the reference's rows", () => {
  const de = {
    ...harbourDe,
    rooms: [
      { _id: 'room0002', _locales: ['en', 'fr'], name: 'Gartenzimmer' },
      { _id: 'room0001', name: 'Hafenzimmer' },
    ],
  };

  expect(referenceText('default', harbourForm, de, 'de').rows).toEqual([
    'rooms[_id=room0001]',
    'features[0]',
    'features[1]',
    'body[_id=cta00001]',
  ]);
});

test('a source with no translated text owes nothing', () => {
  const form: Form = {
    fields: [{ path: ['price'], label: 'Price', type: 'text', required: true, i18n: 'duplicate' }],
    blocks: {},
  };

  expect(answeredText('default', form, { price: '€180' }, { price: '€180' }, 'de')).toEqual({
    written: 0,
    of: 0,
  });
});

const two = { locales: ['en', 'de'], defaultLocale: 'en' };
const three = { locales: ['en', 'de', 'fr'], defaultLocale: 'en' };

test('a one-language site answers its default language and ignores marks', () => {
  const files = { en: { _source: 'de', title: 'Home' }, de: { title: 'Start' } };

  expect(entrySource('default', { locales: ['en'], defaultLocale: 'en' }, files)).toEqual({
    locale: 'en',
    recorded: false,
  });
});

test('an entry with no file has no source', () => {
  expect(entrySource('default', two, { en: undefined })).toBeUndefined();
});

test('two files claiming different sources is a conflict', () => {
  const files = { en: { _source: 'en' }, de: { _source: 'de' }, fr: { title: 'Accueil' } };

  expect(entrySource('default', three, files)).toEqual({
    problem: 'conflict',
    marks: { en: 'en', de: 'de' },
  });
});

test('a source the site does not declare is refused', () => {
  const files = { en: { _source: 'it' }, de: { _source: 'it' } };

  expect(entrySource('default', two, files)).toEqual({
    problem: 'undeclared',
    marks: { en: 'it', de: 'it' },
  });
});

test('a source with no file of its own is refused', () => {
  expect(entrySource('default', three, { en: { _source: 'de' } })).toEqual({
    problem: 'missing',
    marks: { en: 'de' },
  });
});

test('a recorded source is the answer', () => {
  const files = { en: { _source: 'de' }, de: { _source: 'de' } };

  expect(entrySource('default', two, files)).toEqual({ locale: 'de', recorded: true });
});

test('an unmarked file beside a marked one agrees with it', () => {
  const files = { en: { title: 'Notice' }, de: { _source: 'de' }, fr: { title: 'Avis' } };

  expect(entrySource('default', three, files)).toEqual({ locale: 'de', recorded: true });
});

test('an unrecorded entry with one file is written in that language', () => {
  expect(entrySource('default', three, { de: { title: 'Impressum' } })).toEqual({
    locale: 'de',
    recorded: false,
  });
});

test('an unrecorded entry with several files falls back to the default language first', () => {
  const files = { fr: { title: 'Avis' }, de: { title: 'Hinweis' }, en: { title: 'Notice' } };

  expect(entrySource('default', three, files)).toEqual({ locale: 'en', recorded: false });
  expect(entrySource('default', three, { fr: files.fr, de: files.de })).toEqual({
    locale: 'de',
    recorded: false,
  });
});

test('a recorded German source survives reordered locales and a new default language', () => {
  const files = { en: { _source: 'de' }, de: { _source: 'de' }, fr: {} };
  const moved = { locales: ['fr', 'en', 'de'], defaultLocale: 'fr' };

  expect(entrySource('default', moved, files)).toEqual({ locale: 'de', recorded: true });
});

test('undeclared folders take no part in the answer', () => {
  const files = { en: { title: 'Notice' }, it: { _source: 'it' } };

  expect(entrySource('default', two, files)).toEqual({ locale: 'en', recorded: false });
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
