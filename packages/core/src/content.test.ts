import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  applyDrift,
  driftReport,
  markTranslation,
  mergeEntry,
  parseEntry,
  staleLocales,
  staticSource,
  stringifyEntry,
  syncLocale,
  timestampErrors,
} from './content.js';
import type { Form } from './schema.js';

const entries = [
  { id: 'en/mill-house', data: { title: 'Mill House' } },
  { id: 'de/mill-house', data: { title: 'Mühlenhaus' } },
  { id: 'english/not-a-locale', data: { title: 'Trap' } },
];

const source = staticSource<{ listings: { title: string } }>('default', {
  getEntry: async (_c, id) => entries.find((e) => e.id === id),
  getCollection: async () => entries,
});

test('getCollection keeps only entries under the locale folder', async () => {
  const got = await source.getCollection('listings', 'en');
  expect(got).toEqual([{ id: 'en/mill-house', data: { title: 'Mill House' } }]);
});

test('getEntry returns undefined for a missing id', async () => {
  expect(await source.getEntry('listings', 'fr/mill-house')).toBeUndefined();
});

// Publish decides "nothing pending" by blob SHA, so a byte change in the serialiser is a bug.
const goldenDir = join(import.meta.dirname, '../test/golden');
const blobSha = (text: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest('hex');

for (const name of readdirSync(goldenDir)) {
  test(`golden ${name} survives parse → serialise byte for byte`, () => {
    const golden = readFileSync(join(goldenDir, name), 'utf8');
    const out = stringifyEntry('default', parseEntry('default', golden));
    expect(out).toBe(golden);
    expect(blobSha(out)).toBe(blobSha(golden));
  });
}

// The pair session 2.5 compares. DE has two blocks EN has not: `compliance` carries
// `_locales`, so it is DE-only on purpose, and `quote` carries nothing, so it is drift. A
// report that flags every difference passes on one of them and fails on the other.
for (const locale of ['en', 'de']) {
  test(`the drift fixture's ${locale} file is one the serialiser could have written`, () => {
    const file = readFileSync(
      join(import.meta.dirname, '../test/drift', locale, 'home.yaml'),
      'utf8',
    );
    expect(stringifyEntry('default', parseEntry('default', file))).toBe(file);
  });
}

// One fixture per scalar field type: the object a form produces must land in the golden
// file byte for byte and come back equal, so the stored form of each type is pinned.
const scalars: Record<string, unknown> = {
  text: {
    _version: 1,
    title: 'Seaview Cottage',
    summary: 'Two bedrooms, one bathroom.\n\nFive minutes from the beach.',
  },
  number: { _version: 1, bedrooms: 3, area: 82.5, price: 425000 },
  boolean: { _version: 1, featured: true, sold: false },
  date: { _version: 1, availableFrom: '2026-09-01' },
  select: { _version: 1, status: 'sale' },
  richtext: {
    _version: 1,
    body: [
      '## The house',
      '',
      'Two **sunny** bedrooms, one *quiet* bathroom.',
      '',
      '- Sea view',
      '- Walled garden',
      '',
      '1. Book a [viewing](https://example.com/viewings)',
      '2. Make an offer',
      '',
      '### The garden',
      '',
      '> A rare find.',
    ].join('\n'),
  },
  link: {
    _version: 1,
    button: {
      type: 'url',
      href: 'https://example.com/viewings',
      label: 'Book a viewing',
      newTab: true,
    },
    more: { type: 'entry', ref: 'listings/mill-house' },
  },
};

for (const [type, fixture] of Object.entries(scalars)) {
  test(`${type} round-trips through its golden file`, () => {
    const golden = readFileSync(join(goldenDir, `${type}.yaml`), 'utf8');
    const out = stringifyEntry('default', fixture);
    expect(out).toBe(golden);
    expect(parseEntry('default', out)).toEqual(fixture);
  });
}

// Structured types: the shapes are locked before their upload/editor UI exists.
const structured: Record<string, unknown> = {
  image: {
    _version: 1,
    hero: {
      src: 'media/9f3a2c7e.webp',
      alt: 'Front of the house',
      width: 2400,
      height: 1600,
      focal: [0.5, 0.35],
    },
  },
  file: {
    _version: 1,
    brochure: {
      src: 'files/3e8a1b9c.pdf',
      name: 'Seaview Cottage brochure.pdf',
      bytes: 2481033,
      mime: 'application/pdf',
    },
  },
  embed: {
    _version: 1,
    video: { provider: 'youtube', id: 'dQw4w9WgXcQ', title: 'Walkthrough video', start: 42 },
    map: { provider: 'google-maps', id: 'Seaview Cottage, Devon' },
  },
  seo: {
    _version: 1,
    seo: {
      title: 'Move to the coast',
      description: 'Coastal homes in Devon.',
      image: { src: 'media/9f3a2c7e.webp', alt: 'Front of the house', width: 2400, height: 1600 },
      noindex: false,
      canonical: 'https://example.com/listings/seaview-cottage',
    },
  },
  reference: { _version: 1, agent: 'agents/jane-doe' },
};

for (const [type, fixture] of Object.entries(structured)) {
  test(`${type} round-trips through its golden file`, () => {
    const golden = readFileSync(join(goldenDir, `${type}.yaml`), 'utf8');
    const out = stringifyEntry('default', fixture);
    expect(out).toBe(golden);
    expect(parseEntry('default', out)).toEqual(fixture);
  });
}

// Nesting types: a group is a plain object, an array holds groups (each with an `_id`), and
// `blocks` nests three levels deep — blocks → array of groups → blocks — with one `_ref`.
const nesting: Record<string, unknown> = {
  group: {
    _version: 1,
    address: { street: '12 Harbour Lane', town: 'Salcombe', postcode: 'TQ8 8AA' },
  },
  array: {
    _version: 1,
    rooms: [
      { _id: 'b7c2d9e1', name: 'Kitchen', area: 18.5 },
      { _id: 'f4a8c3d6', name: 'Master bedroom', area: 22 },
    ],
    tags: ['coastal', 'garden'],
  },
  blocks: {
    _version: 1,
    title: 'Home',
    blocks: [
      {
        _type: 'hero',
        _id: 'k3nf9a2p',
        heading: 'Move to the coast',
        image: { src: 'media/9f3a2c7e.webp', alt: 'Front of the house', width: 2400, height: 1600 },
      },
      {
        _type: 'columns',
        _id: 'a1b2c3d4',
        _label: 'Two columns',
        columns: [
          {
            _id: 'e5f6g7h8',
            blocks: [
              {
                _type: 'textSection',
                _id: 'i9j0k1l2',
                body: 'First paragraph.\n\nSecond paragraph.',
              },
            ],
          },
          {
            _id: 'm3n4o5p6',
            blocks: [{ _type: 'cta', _id: 'q7r8s9t0', _ref: 'globals/cta-newsletter' }],
          },
        ],
      },
    ],
  },
};

for (const [type, fixture] of Object.entries(nesting)) {
  test(`${type} round-trips through its golden file`, () => {
    const golden = readFileSync(join(goldenDir, `${type}.yaml`), 'utf8');
    const out = stringifyEntry('default', fixture);
    expect(out).toBe(golden);
    expect(parseEntry('default', out)).toEqual(fixture);
  });
}

test('a date is stored as a quoted string, never a YAML timestamp or a Date', () => {
  expect(parseEntry('default', 'availableFrom: 2026-09-01\n')).toEqual({
    availableFrom: '2026-09-01',
  });
  expect(() => stringifyEntry('default', { availableFrom: new Date('2026-09-01') })).toThrow(
    'Date object at availableFrom',
  );
});

test('reserved keys come first in fixed order, then fields in schema order', () => {
  const out = stringifyEntry('default', {
    title: 'Home',
    _id: 'k3nf9a2p',
    _version: 1,
    blocks: [{ heading: 'Hi', _id: 'x', _type: 'cta' }],
  });
  expect(out).toBe(
    '_version: 1\n_id: "k3nf9a2p"\ntitle: "Home"\nblocks:\n  - _type: "cta"\n    _id: "x"\n    heading: "Hi"\n',
  );
});

test('null and undefined values are omitted, never written', () => {
  expect(stringifyEntry('default', { title: 'Home', body: null, seo: { title: undefined } })).toBe(
    'title: "Home"\nseo: {}\n',
  );
});

test('strings are normalised so the literal block never falls back to quotes', () => {
  const out = stringifyEntry('default', { body: 'line one\u0007  \r\n\r\nline two \n\n\n' });
  expect(out).toBe('body: |-\n  line one\n\n  line two\n');
  expect(parseEntry('default', out)).toEqual({ body: 'line one\n\nline two' });
});

test('an array directly inside an array is rejected at serialise time', () => {
  expect(() => stringifyEntry('default', { blocks: [{ _id: 'a', columns: [['x']] }] })).toThrow(
    'blocks[0].columns[0]',
  );
});

// Collection-level shapes: a global, the navigation global, redirects.yaml and a template.
// A template carries no `_id`s — they are generated when an entry is created from it.
const conventions: Record<string, unknown> = {
  'globals-site': {
    _version: 1,
    name: 'Coastal Homes',
    logo: { src: 'media/2b7c9e1a.svg', alt: 'Coastal Homes', width: 320, height: 80 },
    contact: { phone: '+44 1548 000000', email: 'hello@example.com' },
    social: [{ _id: 's1a2b3c4', network: 'instagram', href: 'https://instagram.com/coastalhomes' }],
    footerText: 'Coastal homes in Devon since 2009.',
    defaultSeo: { title: 'Coastal Homes', description: 'Coastal homes in Devon.' },
  },
  navigation: {
    _version: 1,
    menus: [
      {
        _id: '7h2kq9sd',
        key: 'header',
        items: [
          {
            _id: 'a1b2c3d4',
            label: 'Listings',
            link: { type: 'entry', ref: 'listings/seaview-cottage' },
            children: [
              {
                _id: 'e5f6g7h8',
                label: 'For sale',
                link: { type: 'url', href: '/listings?status=sale' },
                newTab: false,
              },
            ],
          },
          {
            _id: 'i9j0k1l2',
            _locales: ['de'],
            label: 'Impressum',
            link: { type: 'page', ref: 'pages/impressum' },
          },
        ],
      },
      {
        _id: 'x3y4z5w6',
        key: 'footer',
        items: [
          {
            _id: 'c7d8e9f0',
            label: 'Contact',
            link: { type: 'url', href: 'mailto:hello@example.com' },
            newTab: true,
          },
        ],
      },
    ],
  },
  redirects: {
    _version: 1,
    rules: [
      {
        _id: 'm4n5o6p7',
        from: '/listings/seaview-cottage',
        to: '/listings/seaview-cottage-devon',
        status: 301,
        reason: 'slug-change',
        entry: 'listings/seaview-cottage-devon',
        createdAt: '2026-08-20T10:14:00Z',
      },
      {
        _id: 'q8r9s0t1',
        from: '/brochure',
        to: 'https://example.com/files/brochure.pdf',
        status: 301,
        reason: 'manual',
        createdAt: '2026-08-21T08:00:00Z',
      },
    ],
  },
  template: {
    _version: 1,
    title: 'New page',
    blocks: [
      { _type: 'hero', heading: 'Move to the coast' },
      { _type: 'textSection', body: 'First paragraph.' },
    ],
  },
};

for (const [type, fixture] of Object.entries(conventions)) {
  test(`${type} round-trips through its golden file`, () => {
    const golden = readFileSync(join(goldenDir, `${type}.yaml`), 'utf8');
    const out = stringifyEntry('default', fixture);
    expect(out).toBe(golden);
    expect(parseEntry('default', out)).toEqual(fixture);
  });
}

test('a save stamps _version: 1 on an entry that has none', () => {
  expect(mergeEntry('default', { title: 'Old' }, { title: 'New' })).toEqual({
    _version: 1,
    title: 'New',
  });
});

test('a save keeps the _version the entry already has', () => {
  expect(mergeEntry('default', { _version: 3, title: 'Old' }, { title: 'New' })).toEqual({
    _version: 3,
    title: 'New',
  });
});

// decap-cms#6978: fields configured to duplicate are stripped from a translated document on
// save, because the German form never showed them and so never sent them back. `price` and
// `bedrooms` are duplicate, `image.src` / `width` / `height` are duplicate and `image.alt` is
// translatable — the nested case is the one clients notice, since it makes them retype URLs.
// The form a translated locale draws: `price` and `bedrooms` are the same in every language,
// `image` splits — its `src`, `width` and `height` are the file's, only `alt` is translated.
const listing: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['summary'], label: 'Summary', type: 'text', required: false },
    { path: ['price'], label: 'Price', type: 'number', required: true, i18n: 'duplicate' },
    { path: ['bedrooms'], label: 'Bedrooms', type: 'number', required: true, i18n: 'duplicate' },
    { path: ['notes'], label: 'Notes', type: 'text', required: false, i18n: false },
    { path: ['image'], label: 'Image', type: 'image', required: false },
  ],
  blocks: {},
};

test('a save of a translated entry keeps the fields its form does not show', () => {
  const de = {
    _version: 1,
    title: 'Mühlenhaus',
    price: 425000,
    bedrooms: 3,
    image: {
      src: 'media/9f3a2c7e.webp',
      alt: 'Vorderseite des Hauses',
      width: 2400,
      height: 1600,
    },
  };
  const values = { title: 'Mühlenhaus am Fluss', image: { alt: 'Das Haus vom Fluss aus' } };

  expect(mergeEntry('default', de, values, listing)).toEqual({
    _version: 1,
    title: 'Mühlenhaus am Fluss',
    price: 425000,
    bedrooms: 3,
    image: {
      src: 'media/9f3a2c7e.webp',
      alt: 'Das Haus vom Fluss aus',
      width: 2400,
      height: 1600,
    },
  });
});

const dated = (body: string) => timestampErrors('default', 'src/content/notes/en/one.yaml', body);

test('an unquoted date is named with its file, its key and the quotes it needs', () => {
  expect(dated('title: Note\npublished: 2026-07-14\n')).toEqual([
    'src/content/notes/en/one.yaml › published: an unquoted date is a timestamp, not a string. Quote it: "2026-07-14"',
  ]);
});

test('a quoted date is a string to both parsers and passes', () => {
  expect(dated('published: "2026-07-14"\nalso: \'2026-07-14\'\n')).toEqual([]);
});

test('an unquoted date-time is a timestamp too', () => {
  expect(dated('at: 2026-07-14 10:30:00\niso: 2026-07-14T10:30:00Z\n')).toEqual([
    'src/content/notes/en/one.yaml › at: an unquoted date is a timestamp, not a string. Quote it: "2026-07-14 10:30:00"',
    'src/content/notes/en/one.yaml › iso: an unquoted date is a timestamp, not a string. Quote it: "2026-07-14T10:30:00Z"',
  ]);
});

test('a single-digit month or day is a string to js-yaml as well, so it passes', () => {
  expect(dated('published: 2026-7-4\n')).toEqual([]);
});

test('a date nested in an array of groups is named by its path', () => {
  expect(dated('slots:\n  - _id: "a1"\n    starts: 2026-07-14\n')).toEqual([
    'src/content/notes/en/one.yaml › slots[0].starts: an unquoted date is a timestamp, not a string. Quote it: "2026-07-14"',
  ]);
});

test('a translated field its form left empty goes, rather than coming back', () => {
  const de = { _version: 1, title: 'Mühlenhaus', summary: 'Am Fluss', price: 425000 };

  expect(mergeEntry('default', de, { title: 'Mühlenhaus' }, listing)).toEqual({
    _version: 1,
    title: 'Mühlenhaus',
    price: 425000,
  });
});

// The skeleton is the same in every language, so a translated save carries values and never
// structure: the blocks it writes are the ones the file has, paired by `_id`.
const article: Form = {
  fields: [{ path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['hero'] }],
  blocks: {
    hero: [
      { path: ['heading'], label: 'Heading', type: 'text', required: true },
      { path: ['image'], label: 'Image', type: 'image', required: false },
    ],
  },
};

test('a duplicate value inside a block survives a translated save', () => {
  const de = {
    _version: 1,
    blocks: [
      {
        _type: 'hero',
        _id: 'k3nf9a2p',
        heading: 'Willkommen',
        image: { src: 'media/9f3a2c7e.webp', alt: 'Vorderseite', width: 2400, height: 1600 },
      },
    ],
  };
  const values = {
    blocks: [{ _type: 'hero', _id: 'k3nf9a2p', heading: 'Herzlich willkommen', image: {} }],
  };

  expect(mergeEntry('default', de, values, article)).toEqual({
    _version: 1,
    blocks: [
      {
        _type: 'hero',
        _id: 'k3nf9a2p',
        heading: 'Herzlich willkommen',
        image: { src: 'media/9f3a2c7e.webp', width: 2400, height: 1600 },
      },
    ],
  });
});

test('a translated save does not add, drop or reorder blocks', () => {
  const de = {
    _version: 1,
    blocks: [
      { _type: 'hero', _id: 'aaaaaaaa', heading: 'Erstens' },
      { _type: 'hero', _id: 'bbbbbbbb', heading: 'Zweitens' },
    ],
  };
  const values = {
    blocks: [
      { _type: 'hero', _id: 'bbbbbbbb', heading: 'Zweitens, neu' },
      { _type: 'hero', _id: 'cccccccc', heading: 'Drittens' },
    ],
  };

  expect(mergeEntry('default', de, values, article)).toEqual({
    _version: 1,
    blocks: [
      { _type: 'hero', _id: 'aaaaaaaa', heading: 'Erstens' },
      { _type: 'hero', _id: 'bbbbbbbb', heading: 'Zweitens, neu' },
    ],
  });
});

// The pair the `image.src` / `image.alt` split is drawn on: everything the two files share is
// byte for byte the same, `notes` is the source locale's alone, and the German file holds
// nothing but translations of the rest.
const millHouse: Form = {
  fields: [
    ...listing.fields,
    { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['hero'] },
  ],
  blocks: article.blocks,
};
const localeFile = (locale: string) =>
  readFileSync(join(import.meta.dirname, '../test/locales', locale, 'mill-house.yaml'), 'utf8');

for (const locale of ['en', 'de']) {
  test(`the ${locale} locale fixture is one the serialiser could have written`, () => {
    const file = localeFile(locale);
    expect(stringifyEntry('default', parseEntry('default', file))).toBe(file);
  });
}

test('a duplicate value follows the source locale into the other file, nested included', () => {
  const en = parseEntry('default', localeFile('en')) as Record<string, unknown>;
  const de = parseEntry('default', localeFile('de'));
  const image = { ...(en.image as Record<string, unknown>), src: 'media/2c40ab19.webp' };

  const synced = syncLocale(
    'default',
    millHouse,
    'de',
    { before: en, after: { ...en, price: 450000, image } },
    de,
  );

  expect(synced.price).toBe(450000);
  expect(synced.image).toEqual({
    src: 'media/2c40ab19.webp',
    alt: 'Vorderseite des Hauses',
    width: 2400,
    height: 1600,
  });
  expect(synced.title).toBe('Mühlenhaus');
  expect(synced.notes).toBeUndefined();
});

test('the other locale file comes back byte for byte when the source has nothing new', () => {
  const de = localeFile('de');
  const en = parseEntry('default', localeFile('en'));
  const synced = syncLocale(
    'default',
    millHouse,
    'de',
    { before: en, after: en },
    parseEntry('default', de),
  );
  expect(stringifyEntry('default', synced)).toBe(de);
});

// The drift pair: EN has the two shared blocks, DE has those plus a `compliance` block marked
// `_locales: [de]` and a `quote` block marked nothing at all. One fixture covers both rules —
// what an edit in one language owns, and what it must not touch.
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
      { path: ['image'], label: 'Image', type: 'image', required: false },
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
const blockIds = (data: Record<string, unknown>) =>
  (data.blocks as Record<string, unknown>[]).map((b) => b._id);

test('moving a block moves it in the other language, and a block only that language has holds its place', () => {
  const before = drifted('en');
  const [hero, cta] = before.blocks as Record<string, unknown>[];
  const after = { ...before, blocks: [cta, hero] };

  const de = syncLocale('default', page, 'de', { before, after }, drifted('de'));

  expect(stringifyEntry('default', de)).toBe(
    [
      '_version: 1',
      '_i18n:',
      '  sourceLocale: "en"',
      '  sourceBlob: "3f9c2e1a7b8d4c6e0a2f5b7c9d1e3a5b7c9d1e3a"',
      '  sourceHash: "8f3a1c"',
      '  translatedAt: "2026-08-20T10:14:00Z"',
      'title: "Startseite"',
      'blocks:',
      '  - _type: "cta"',
      '    _id: "q1w2e3r4"',
      '    heading: "Bereit für den Umzug?"',
      '  - _type: "hero"',
      '    _id: "k3nf9a2p"',
      '    heading: "Zieh an die Küste"',
      '  - _type: "compliance"',
      '    _id: "p8xk2m4q"',
      '    _locales:',
      '      - "de"',
      '    heading: "Widerrufsbelehrung"',
      '  - _type: "quote"',
      '    _id: "z9y8x7w6"',
      '    body: "Ein seltener Fund."',
      '',
    ].join('\n'),
  );
});

test('a save that changes no structure leaves the other language byte for byte', () => {
  const before = drifted('en');

  const de = syncLocale('default', page, 'de', { before, after: before }, drifted('de'));

  expect(stringifyEntry('default', de)).toBe(driftFile('de'));
});

test('a block added in one language arrives in the others with its shared values alone', () => {
  const before = drifted('en');
  const added = {
    _type: 'hero',
    _id: 'n5m6b7v8',
    heading: 'Come and see',
    image: { src: 'media/4b1d8e05.webp', alt: 'The river', width: 1800, height: 1200 },
  };
  const after = { ...before, blocks: [...(before.blocks as unknown[]), added] };

  const de = syncLocale('default', page, 'de', { before, after }, drifted('de'));

  expect(blockIds(de)).toEqual(['k3nf9a2p', 'p8xk2m4q', 'z9y8x7w6', 'q1w2e3r4', 'n5m6b7v8']);
  expect((de.blocks as Record<string, unknown>[])[4]).toEqual({
    _type: 'hero',
    _id: 'n5m6b7v8',
    image: { src: 'media/4b1d8e05.webp', width: 1800, height: 1200 },
  });
});

test('a block deleted in one language is deleted in every language', () => {
  const before = drifted('en');
  const after = { ...before, blocks: [(before.blocks as unknown[])[0]] };

  const de = syncLocale('default', page, 'de', { before, after }, drifted('de'));

  expect(blockIds(de)).toEqual(['k3nf9a2p', 'p8xk2m4q', 'z9y8x7w6']);
});

test('a block the other language alone has is never written into this one', () => {
  const before = drifted('en');

  const en = syncLocale('default', page, 'en', { before, after: before }, before);

  expect(stringifyEntry('default', en)).toBe(driftFile('en'));
});

test('a block marked for one language is written to that file and to no other', () => {
  const before = drifted('en');
  const only = { _type: 'compliance', _id: 'p8xk2m4q', _locales: ['de'], heading: 'Widerruf' };
  const after = { ...before, blocks: [...(before.blocks as unknown[]), only] };

  expect(blockIds(syncLocale('default', page, 'en', { before, after }, after))).toEqual([
    'k3nf9a2p',
    'q1w2e3r4',
  ]);
  expect(blockIds(syncLocale('default', page, 'de', { before, after }, drifted('de')))).toContain(
    'p8xk2m4q',
  );
});

test('a language whose file has no blocks yet is given the structure, not left empty', () => {
  const before = drifted('en');
  const fr = { title: 'Accueil' };

  const synced = syncLocale('default', page, 'fr', { before, after: before }, fr);

  expect(blockIds(synced)).toEqual(['k3nf9a2p', 'q1w2e3r4']);
  expect(synced.title).toBe('Accueil');
  expect(synced._version).toBe(1);
});

// Drift is what a save is not allowed to resolve: the same fixture pair, read rather than
// written. `compliance` says which language it belongs to and `quote` says nothing at all.
test('a block one language has without `_locales` is drift, and one with it is not', () => {
  expect(driftReport('default', page, { en: drifted('en'), de: drifted('de') })).toEqual([
    { path: 'blocks[_id=z9y8x7w6]', type: 'quote', in: ['de'], expected: ['en', 'de'] },
  ]);
});

test('an entry with a file in one language alone has nothing to have drifted from', () => {
  const de = drifted('de');
  // A block naming a language the entry has no file in included: there is no second file to
  // reconcile it against, so a publish of it is never the one that is blocked.
  const stray = { _type: 'quote', _id: 'z9y8x7w6', _locales: ['en'], body: 'Ein seltener Fund.' };

  expect(driftReport('default', page, { de: { ...de, blocks: [stray] } })).toEqual([]);
});

test('a block in a language its `_locales` does not name has drifted too', () => {
  const de = drifted('de');
  const compliance = (de.blocks as unknown[])[1];
  const en = { ...drifted('en'), blocks: [...(drifted('en').blocks as unknown[]), compliance] };

  expect(driftReport('default', page, { en, de })).toEqual([
    { path: 'blocks[_id=p8xk2m4q]', type: 'compliance', in: ['en', 'de'], expected: ['de'] },
    { path: 'blocks[_id=z9y8x7w6]', type: 'quote', in: ['de'], expected: ['en', 'de'] },
  ]);
});

// Blocks inside a block, and rows inside a group's array: drift anywhere the structure is
// shared is drift, and the report addresses the row the way `_machine` addresses a field.
const nested: Form = {
  fields: [
    {
      path: ['sidebar'],
      label: 'Sidebar',
      type: 'group',
      required: false,
      fields: [
        {
          path: ['features'],
          label: 'Features',
          type: 'array',
          required: false,
          item: [{ path: ['label'], label: 'Label', type: 'text', required: true }],
        },
      ],
    },
    { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['section'] },
  ],
  blocks: {
    section: [
      { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['quote'] },
    ],
    quote: [{ path: ['body'], label: 'Body', type: 'text', required: true }],
  },
};

const section = (inner: unknown[]) => ({
  blocks: [{ _type: 'section', _id: 'a1b2c3d4', blocks: inner }],
});

test('a block inside a block is compared too', () => {
  const en = section([{ _type: 'quote', _id: 'z9y8x7w6', body: 'A rare find.' }]);
  const de = section([]);

  expect(driftReport('default', nested, { en, de })).toEqual([
    {
      path: 'blocks[_id=a1b2c3d4].blocks[_id=z9y8x7w6]',
      type: 'quote',
      in: ['en'],
      expected: ['en', 'de'],
    },
  ]);
});

test('a row an array in one language has and the other does not is drift', () => {
  const en = { sidebar: { features: [{ _id: 'f1f2f3f4', label: 'Parking' }] } };
  const de = { sidebar: { features: [] } };

  expect(driftReport('default', nested, { en, de })).toEqual([
    { path: 'sidebar.features[_id=f1f2f3f4]', in: ['en'], expected: ['en', 'de'] },
  ]);
});

// Reconciliation: the same rows, answered. An answer names the languages the row should end
// up in, and the files are made to say that — the one thing a save is not allowed to do.
const QUOTE = 'blocks[_id=z9y8x7w6]';
const answer = (locales: string[], files: Record<string, unknown>, path = QUOTE) =>
  applyDrift('default', page, ['en', 'de'], files, [{ path, locales }]);

test('a block answered with the language missing it arrives there with its shared values', () => {
  const files = answer(['en', 'de'], { en: drifted('en'), de: drifted('de') });

  // Behind the hero, which is the last block before it that English also has.
  expect(stringifyEntry('default', files.en)).toBe(
    [
      '_version: 1',
      'title: "Home"',
      'blocks:',
      '  - _type: "hero"',
      '    _id: "k3nf9a2p"',
      '    heading: "Move to the coast"',
      '  - _type: "quote"',
      '    _id: "z9y8x7w6"',
      '  - _type: "cta"',
      '    _id: "q1w2e3r4"',
      '    heading: "Ready to move?"',
      '',
    ].join('\n'),
  );
  expect(stringifyEntry('default', files.de)).toBe(driftFile('de'));
});

test('a block answered with no language at all is taken out of every file', () => {
  const files = answer([], { en: drifted('en'), de: drifted('de') });

  expect(blockIds(files.de as Record<string, unknown>)).toEqual([
    'k3nf9a2p',
    'p8xk2m4q',
    'q1w2e3r4',
  ]);
  expect(stringifyEntry('default', files.en)).toBe(driftFile('en'));
});

test('a block answered with the languages that already have it is marked for them', () => {
  const files = answer(['de'], { en: drifted('en'), de: drifted('de') });

  expect((files.de as { blocks: Record<string, unknown>[] }).blocks[2]).toEqual({
    _type: 'quote',
    _id: 'z9y8x7w6',
    _locales: ['de'],
    body: 'Ein seltener Fund.',
  });
  expect(stringifyEntry('default', files.en)).toBe(driftFile('en'));
});

// The other shape: a block whose `_locales` the file it sits in is not named by.
const marked = () => {
  const de = drifted('de');
  const compliance = (de.blocks as unknown[])[1];
  return {
    en: { ...drifted('en'), blocks: [...(drifted('en').blocks as unknown[]), compliance] },
    de,
  };
};
const COMPLIANCE = 'blocks[_id=p8xk2m4q]';

test('a marked block answered with what the mark says comes out of the other file', () => {
  const files = answer(['de'], marked(), COMPLIANCE);

  expect(blockIds(files.en as Record<string, unknown>)).toEqual(['k3nf9a2p', 'q1w2e3r4']);
  expect(stringifyEntry('default', files.de)).toBe(driftFile('de'));
});

test('a marked block answered with every language loses the mark rather than widening it', () => {
  const files = answer(['en', 'de'], marked(), COMPLIANCE);

  for (const locale of ['en', 'de']) {
    const blocks = (files[locale] as { blocks: Record<string, unknown>[] }).blocks;
    expect(blocks.find((b) => b._id === 'p8xk2m4q')).toEqual({
      _type: 'compliance',
      _id: 'p8xk2m4q',
      heading: 'Widerrufsbelehrung',
    });
  }
});

test('a mark naming a language the entry has no file in is left alone', () => {
  const files = marked();
  ((files.de.blocks as Record<string, unknown>[])[1] as Record<string, unknown>)._locales = [
    'de',
    'fr',
  ];

  const applied = applyDrift('default', page, ['en', 'de', 'fr'], files, [
    { path: COMPLIANCE, locales: ['de'] },
  ]);

  expect((applied.de as { blocks: Record<string, unknown>[] }).blocks[1]?._locales).toEqual([
    'de',
    'fr',
  ]);
  expect(blockIds(applied.en as Record<string, unknown>)).toEqual(['k3nf9a2p', 'q1w2e3r4']);
});

test('a row answered inside a group arrives in a file that has neither the group nor the array', () => {
  const en = { sidebar: { features: [{ _id: 'f1f2f3f4', label: 'Parking' }] } };

  const files = applyDrift('default', nested, ['en', 'de'], { en, de: {} }, [
    { path: 'sidebar.features[_id=f1f2f3f4]', locales: ['en', 'de'] },
  ]);

  expect(files.de).toEqual({ sidebar: { features: [{ _id: 'f1f2f3f4' }] } });
});

test('a block answered into another language takes the blocks inside it along', () => {
  const de = section([{ _type: 'quote', _id: 'z9y8x7w6', body: 'Ein seltener Fund.' }]);

  const files = applyDrift('default', nested, ['en', 'de'], { en: { blocks: [] }, de }, [
    { path: 'blocks[_id=a1b2c3d4]', locales: ['en', 'de'] },
  ]);

  expect(files.en).toEqual({
    blocks: [{ _type: 'section', _id: 'a1b2c3d4', blocks: [{ _type: 'quote', _id: 'z9y8x7w6' }] }],
  });
});

// Staleness: the German was translated from the English as it then stood, and `_i18n` is what
// says which English that was. The pair above is the one to ask it about — a shared price and
// a source-language-only note must not count as something anybody has to retranslate.
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
  expect(await staleLocales('default', millHouse, files)).toEqual(['de']);
});

test('a shared value, a hidden one and a requoted file leave the translation current', async () => {
  const en = localeFile('en');
  const de = parseEntry('default', await translate(en, localeFile('de')));
  // Single quotes are the same values in different bytes: `sourceBlob` moves, `sourceHash` does
  // not, which is the whole reason there are two of them.
  const same = {
    ...(parseEntry('default', en.replace(/"/g, "'")) as Record<string, unknown>),
    price: 450000,
    notes: 'Completion moved to October.',
  };

  expect(await staleLocales('default', millHouse, { en: same, de })).toEqual([]);
});

test('a file nobody has marked is not stale', async () => {
  const files = {
    en: parseEntry('default', localeFile('en')),
    de: parseEntry('default', localeFile('de')),
  };

  expect(await staleLocales('default', millHouse, files)).toEqual([]);
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
  expect(await staleLocales('default', page, files)).toEqual([]);
});

// What a publish must not do: the German file is rewritten whenever English changes its
// structure or a shared value, and neither of those is somebody translating it.
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
    await staleLocales('default', millHouse, {
      en: parseEntry('default', en),
      de: parseEntry('default', marked),
    }),
  ).toEqual([]);
});

test('a mark that says nothing about the values is not a claim to be stale', async () => {
  const de = {
    ...(parseEntry('default', localeFile('de')) as object),
    _i18n: { sourceLocale: 'en' },
  };

  expect(
    await staleLocales('default', millHouse, { en: parseEntry('default', localeFile('en')), de }),
  ).toEqual([]);
});
