import { expect, test } from 'vitest';
import { type Change, diffEntry } from './diff.js';
import type { Form } from './schema.js';

// A listing as a translated site has it: the price is the same in every language, the notes
// live in the source language alone, and the picture splits — only its `alt` is retyped.
const listing: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['summary'], label: 'Summary', type: 'text', required: false },
    { path: ['body'], label: 'Body', type: 'richtext', required: false, tier: 'full' },
    { path: ['price'], label: 'Price', type: 'number', required: true, i18n: 'duplicate' },
    { path: ['image'], label: 'Image', type: 'image', required: false, preset: { max: 2400 } },
  ],
  blocks: {},
};

const changesIn = (groups: ReturnType<typeof diffEntry>, locale?: string): Change[] =>
  groups.find((g) => g.locale === locale)?.changes ?? [];

test('a value every language shares is lifted out of them', () => {
  const en = { title: 'Mill House', price: 450000 };
  const de = { title: 'Mühlenhaus', price: 450000 };

  const groups = diffEntry(
    'default',
    listing,
    { en, de },
    { en: { ...en, price: 435000 }, de: { ...de, price: 435000 } },
  );

  expect(changesIn(groups)).toEqual([
    { path: 'price', label: 'Price', kind: 'value', before: '450000', after: '435000' },
  ]);
  expect(changesIn(groups, 'en')).toEqual([]);
  expect(changesIn(groups, 'de')).toEqual([]);
});

test('a value the languages share is caught in whichever file it moved in', () => {
  const en = { title: 'Mill House', price: 450000 };
  const de = { title: 'Mühlenhaus', price: 450000 };

  const groups = diffEntry('default', listing, { en, de }, { en, de: { ...de, price: 435000 } });

  expect(changesIn(groups)).toEqual([
    { path: 'price', label: 'Price', kind: 'value', before: '450000', after: '435000' },
  ]);
});

test('an entry in one language has no shared group, because nothing is doubled', () => {
  const en = { title: 'Mill House', price: 450000 };

  const groups = diffEntry('default', listing, { en }, { en: { ...en, price: 435000 } });

  expect(groups.map((g) => g.locale)).toEqual(['en']);
  expect(changesIn(groups, 'en')).toEqual([
    { path: 'price', label: 'Price', kind: 'value', before: '450000', after: '435000' },
  ]);
});

test('a text field is diffed word by word, not replaced whole', () => {
  const groups = diffEntry(
    'default',
    listing,
    { en: { summary: 'A cottage above the harbour' } },
    { en: { summary: 'A whitewashed cottage above the fish market' } },
  );

  expect(changesIn(groups, 'en')).toEqual([
    {
      path: 'summary',
      label: 'Summary',
      kind: 'words',
      parts: [
        { text: 'A ' },
        { text: 'whitewashed ', mark: 'ins' },
        { text: 'cottage above the ' },
        { text: 'harbour', mark: 'del' },
        { text: 'fish market', mark: 'ins' },
      ],
    },
  ]);
});

test('a rich text body says that it changed and nothing more', () => {
  const groups = diffEntry(
    'default',
    listing,
    { en: { body: '# One\n\nA paragraph.' } },
    { en: { body: '# One\n\nA longer paragraph.' } },
  );

  expect(changesIn(groups, 'en')).toEqual([{ path: 'body', label: 'Body', kind: 'whole' }]);
});

test('only the properties a translator retypes are per-language', () => {
  const before = { image: { src: 'media/a.webp', alt: 'The front', width: 2400 } };
  const after = { image: { src: 'media/b.webp', alt: 'The garden', width: 1800 } };

  const groups = diffEntry(
    'default',
    listing,
    { en: before, de: before },
    { en: after, de: after },
  );

  expect(changesIn(groups)).toEqual([
    {
      path: 'image.src',
      label: 'Image · Src',
      kind: 'value',
      before: 'media/a.webp',
      after: 'media/b.webp',
    },
    { path: 'image.width', label: 'Image · Width', kind: 'value', before: '2400', after: '1800' },
  ]);
  expect(changesIn(groups, 'en')).toEqual([
    {
      path: 'image.alt',
      label: 'Image · Alt',
      kind: 'value',
      before: 'The front',
      after: 'The garden',
    },
  ]);
});

test('a language nothing happened in gets a group with no changes, so silence is not the answer', () => {
  const en = { title: 'Mill House' };
  const de = { title: 'Mühlenhaus' };

  const groups = diffEntry('default', listing, { en, de }, { en: { title: 'The Mill House' }, de });

  expect(groups.map((g) => g.locale)).toEqual([undefined, 'en', 'de']);
  expect(changesIn(groups, 'de')).toEqual([]);
});

test('the marks a file carries are not a change anybody made', () => {
  const en = { _version: 1, title: 'Mill House' };
  const after = {
    _version: 1,
    _machine: ['title'],
    _locales: ['en'],
    _i18n: { sourceLocale: 'de', sourceBlob: 'abc', sourceHash: 'def', translatedAt: 'now' },
    title: 'Mill House',
  };

  expect(diffEntry('default', listing, { en }, { en: after })).toEqual([
    { locale: 'en', changes: [] },
  ]);
});

// Blocks — the four row shapes, keyed by `_id` the way the rest of the walk keys them.
const page: Form = {
  fields: [
    {
      path: ['blocks'],
      label: 'Blocks',
      type: 'blocks',
      required: true,
      types: ['hero', 'cta'],
    },
  ],
  blocks: {
    hero: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
    cta: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
  },
};

const hero = { _type: 'hero', _id: 'aaaa1111', heading: 'Seaview Cottage' };
const cta = { _type: 'cta', _id: 'bbbb2222', heading: 'Newsletter signup' };
const quote = { _type: 'hero', _id: 'cccc3333', heading: 'Gallery' };

test('a block that moved says it moved, not that it was deleted and added again', () => {
  const groups = diffEntry(
    'default',
    page,
    { en: { blocks: [hero, cta, quote] } },
    { en: { blocks: [quote, hero, cta] } },
  );

  expect(changesIn(groups, 'en')).toEqual([
    {
      path: 'blocks[_id=cccc3333]',
      label: 'Gallery',
      kind: 'row',
      type: 'Hero',
      at: 'moved-up',
      above: 'Seaview Cottage',
      changes: [],
    },
  ]);
});

test('a block that arrived and one that went are named by what they say', () => {
  const groups = diffEntry(
    'default',
    page,
    { en: { blocks: [hero, quote] } },
    { en: { blocks: [hero, cta] } },
  );

  expect(changesIn(groups, 'en')).toEqual([
    {
      path: 'blocks[_id=bbbb2222]',
      label: 'Newsletter signup',
      kind: 'row',
      type: 'Cta',
      at: 'added',
      changes: [],
    },
    {
      path: 'blocks[_id=cccc3333]',
      label: 'Gallery',
      kind: 'row',
      type: 'Hero',
      at: 'removed',
      changes: [],
    },
  ]);
});

test('a block that stayed where it was carries what changed inside it', () => {
  const groups = diffEntry(
    'default',
    page,
    { en: { blocks: [hero] } },
    { en: { blocks: [{ ...hero, heading: 'Seaview Cottage, Devon' }] } },
  );

  expect(changesIn(groups, 'en')).toEqual([
    {
      path: 'blocks[_id=aaaa1111]',
      label: 'Seaview Cottage, Devon',
      kind: 'row',
      type: 'Hero',
      at: 'same',
      changes: [
        {
          path: 'blocks[_id=aaaa1111].heading',
          label: 'Heading',
          kind: 'words',
          parts: [{ text: 'Seaview Cottage' }, { text: ', Devon', mark: 'ins' }],
        },
      ],
    },
  ]);
});

// An array of rows without `_id` — a template's list, paired by position, so nothing moves.
const team: Form = {
  fields: [
    {
      path: ['people'],
      label: 'People',
      type: 'array',
      required: false,
      item: [{ path: ['name'], label: 'Name', type: 'text', required: true }],
    },
  ],
  blocks: {},
};

test('rows without an id pair by position, so the second row is what changed', () => {
  const groups = diffEntry(
    'default',
    team,
    { en: { people: [{ name: 'Anna' }, { name: 'Martin' }] } },
    { en: { people: [{ name: 'Anna' }, { name: 'Marta' }] } },
  );

  expect(changesIn(groups, 'en')).toEqual([
    {
      path: 'people[1]',
      label: 'Marta',
      kind: 'row',
      at: 'same',
      changes: [
        {
          path: 'people[1].name',
          label: 'Name',
          kind: 'words',
          parts: [
            { text: 'Martin', mark: 'del' },
            { text: 'Marta', mark: 'ins' },
          ],
        },
      ],
    },
  ]);
});

// The remaining leaf types, so every one the form can produce has a decided shape.
const everything: Form = {
  fields: [
    { path: ['when'], label: 'When', type: 'date', required: false },
    { path: ['live'], label: 'Live', type: 'boolean', required: false },
    { path: ['status'], label: 'Status', type: 'select', required: false, options: ['a', 'b'] },
    { path: ['agent'], label: 'Agent', type: 'reference', required: false, collection: 'team' },
    { path: ['link'], label: 'Link', type: 'link', required: false },
    { path: ['brochure'], label: 'Brochure', type: 'file', required: false, accept: [] },
    { path: ['video'], label: 'Video', type: 'embed', required: false },
    { path: ['seo'], label: 'SEO', type: 'seo', required: false },
    {
      path: ['address'],
      label: 'Address',
      type: 'group',
      required: false,
      fields: [{ path: ['street'], label: 'Street', type: 'text', required: false }],
    },
    { path: ['odd'], label: 'Odd', type: 'unsupported' },
  ],
  blocks: {},
};

test('every other field type has a shape, including the one the schema cannot read', () => {
  const before = {
    when: '2026-01-01',
    live: false,
    status: 'a',
    agent: 'anna',
    link: { href: '/one', label: 'One' },
    brochure: { src: 'media/a.pdf', name: 'Details' },
    video: { url: 'https://v/1', title: 'Tour' },
    seo: { title: 'One', description: 'First' },
    address: { street: 'Quay Road' },
    odd: [[1]],
  };
  const after = {
    when: '2026-02-01',
    live: true,
    status: 'b',
    agent: 'martin',
    link: { href: '/two', label: 'Two' },
    brochure: { src: 'media/b.pdf', name: 'Facts' },
    video: { url: 'https://v/2', title: 'Walk' },
    seo: { title: 'Two', description: 'Second' },
    address: { street: 'Harbour Road' },
    odd: [[2]],
  };

  expect(changesIn(diffEntry('default', everything, { en: before }, { en: after }), 'en')).toEqual([
    { path: 'when', label: 'When', kind: 'value', before: '2026-01-01', after: '2026-02-01' },
    { path: 'live', label: 'Live', kind: 'value', before: 'false', after: 'true' },
    { path: 'status', label: 'Status', kind: 'value', before: 'a', after: 'b' },
    { path: 'agent', label: 'Agent', kind: 'value', before: 'anna', after: 'martin' },
    { path: 'link.href', label: 'Link · Href', kind: 'value', before: '/one', after: '/two' },
    { path: 'link.label', label: 'Link · Label', kind: 'value', before: 'One', after: 'Two' },
    {
      path: 'brochure.src',
      label: 'Brochure · Src',
      kind: 'value',
      before: 'media/a.pdf',
      after: 'media/b.pdf',
    },
    {
      path: 'brochure.name',
      label: 'Brochure · Name',
      kind: 'value',
      before: 'Details',
      after: 'Facts',
    },
    {
      path: 'video.url',
      label: 'Video · Url',
      kind: 'value',
      before: 'https://v/1',
      after: 'https://v/2',
    },
    { path: 'video.title', label: 'Video · Title', kind: 'value', before: 'Tour', after: 'Walk' },
    { path: 'seo.title', label: 'SEO · Title', kind: 'value', before: 'One', after: 'Two' },
    {
      path: 'seo.description',
      label: 'SEO · Description',
      kind: 'value',
      before: 'First',
      after: 'Second',
    },
    {
      path: 'address.street',
      label: 'Address · Street',
      kind: 'words',
      parts: [{ text: 'Quay', mark: 'del' }, { text: 'Harbour', mark: 'ins' }, { text: ' Road' }],
    },
    { path: 'odd', label: 'Odd', kind: 'whole' },
  ]);
});

test('a field that arrived and one that went say so with one side missing', () => {
  const groups = diffEntry(
    'default',
    listing,
    { en: { title: 'Mill House', summary: 'A cottage' } },
    { en: { title: 'Mill House', body: '# One' } },
  );

  expect(changesIn(groups, 'en')).toEqual([
    {
      path: 'summary',
      label: 'Summary',
      kind: 'words',
      parts: [{ text: 'A cottage', mark: 'del' }],
    },
    { path: 'body', label: 'Body', kind: 'whole' },
  ]);
});

test('two files that say the same thing produce no changes at all', () => {
  const en = { title: 'Mill House', price: 450000, image: { src: 'media/a.webp', alt: 'Front' } };
  const de = { title: 'Mühlenhaus', price: 450000, image: { src: 'media/a.webp', alt: 'Vorn' } };

  expect(diffEntry('default', listing, { en, de }, { en, de })).toEqual([
    { changes: [] },
    { locale: 'en', changes: [] },
    { locale: 'de', changes: [] },
  ]);
});

test('a list of words is read as a sentence, not as the brackets the file writes it in', () => {
  const tags: Form = {
    fields: [
      {
        path: ['tags'],
        label: 'Tags',
        type: 'array',
        required: false,
        item: [{ path: [], label: '', type: 'text', required: true }],
      },
    ],
    blocks: {},
  };

  const groups = diffEntry(
    'default',
    tags,
    { en: { tags: ['sea', 'view', 'devon'] } },
    { en: { tags: ['sea', 'harbour', 'devon'] } },
  );

  expect(changesIn(groups, 'en')).toEqual([
    {
      path: 'tags',
      label: 'Tags',
      kind: 'words',
      parts: [
        { text: 'sea, ' },
        { text: 'view', mark: 'del' },
        { text: 'harbour', mark: 'ins' },
        { text: ', devon' },
      ],
    },
  ]);
});

test('a property inside a structured field is named by every step down to it', () => {
  const form: Form = {
    fields: [{ path: ['seo'], label: 'SEO', type: 'seo', required: false }],
    blocks: {},
  };

  const groups = diffEntry(
    'default',
    form,
    { en: { seo: { image: { alt: 'The front' } } } },
    { en: { seo: { image: { alt: 'The quay' } } } },
  );

  expect(changesIn(groups, 'en')).toEqual([
    {
      path: 'seo.image.alt',
      label: 'SEO · Image · Alt',
      kind: 'value',
      before: 'The front',
      after: 'The quay',
    },
  ]);
});

// A language that was there and is not any more is one event, not one deletion per field:
// "the German version was removed" is what happened, and the shared group must not read the
// missing file as every shared value having gone either.
test('a language present before and absent after is one removal, not a deletion per field', () => {
  const en = { title: 'Mill House', price: 450000 };
  const de = { title: 'Mühlenhaus', summary: 'Am Fluss', price: 450000 };

  const groups = diffEntry('default', listing, { en, de }, { en });

  expect(groups).toEqual([
    { changes: [] },
    { locale: 'en', changes: [] },
    { locale: 'de', removed: true, changes: [] },
  ]);
});

// A row with nothing to say for itself is named by where it stood, never by its `_id`: the id
// is the file's bookkeeping and reads as noise to the person who deleted the row.
test('a removed row with no words of its own is named by its place, not its id', () => {
  const opening: Form = {
    fields: [
      {
        path: ['hours'],
        label: 'Hours',
        type: 'array',
        required: false,
        item: [{ path: ['open'], label: 'Open', type: 'number', required: true }],
      },
    ],
    blocks: {},
  };
  const first = { _id: 'k3nf9a2p', open: 9 };
  const second = { _id: 'q8zt1m4c', open: 10 };

  const groups = diffEntry(
    'default',
    opening,
    { en: { hours: [first, second] } },
    { en: { hours: [first] } },
  );

  expect(changesIn(groups, 'en')).toEqual([
    { path: 'hours[_id=q8zt1m4c]', label: 'Row 2', kind: 'row', at: 'removed', changes: [] },
  ]);
});
