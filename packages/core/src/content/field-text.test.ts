import { expect, test } from 'vitest';
import { answeredCount, answeredPaths, answeredWork, referenceText } from './field-text.js';
import type { Form } from './schema.js';

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
