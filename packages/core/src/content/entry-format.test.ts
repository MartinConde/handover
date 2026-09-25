import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { article, listing, localeFile } from './content.fixture.js';
import {
  mergeEntry,
  offeredEntry,
  parseEntry,
  stringifyEntry,
  timestampErrors,
  withSource,
  writtenEntry,
} from './entry-format.js';
import { syncLocale } from './locale-sync.js';
import type { Form } from './schema.js';

// Publish decides "nothing pending" by blob SHA, so a byte change in the serialiser is a bug.
const goldenDir = join(import.meta.dirname, '../../test/golden');
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

// DE has two blocks EN has not: `compliance` is DE-only on purpose, `quote` is drift.
for (const locale of ['en', 'de']) {
  test(`the drift fixture's ${locale} file is one the serialiser could have written`, () => {
    const file = readFileSync(
      join(import.meta.dirname, '../../test/drift', locale, 'home.yaml'),
      'utf8',
    );
    expect(stringifyEntry('default', parseEntry('default', file))).toBe(file);
  });
}

for (const locale of ['en', 'de']) {
  test(`the ${locale} locale fixture is one the serialiser could have written`, () => {
    const file = localeFile(locale);
    expect(stringifyEntry('default', parseEntry('default', file))).toBe(file);
  });
}

// One fixture per scalar field type pins the stored form of each.
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
    blocks: [{ heading: 'Hi', _id: 'x0000000', _type: 'cta' }],
  });
  expect(out).toBe(
    '_version: 1\n_id: "k3nf9a2p"\ntitle: "Home"\nblocks:\n  - _type: "cta"\n    _id: "x0000000"\n    heading: "Hi"\n',
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
  expect(() =>
    stringifyEntry('default', { blocks: [{ _id: 'a0000000', columns: [['x']] }] }),
  ).toThrow('blocks[0].columns[0]');
});

test('reserved metadata that would make saved bytes unreadable is rejected before serialising', () => {
  expect(() =>
    stringifyEntry('default', {
      title: 'Still an incomplete but valid draft',
      opaque: { imported: [{ _id: 'bad' }] },
    }),
  ).toThrow('opaque.imported[0]._id: expected eight characters from 0-9a-z, got "bad"');
});

test('duplicate row identities are rejected with both ambiguous paths named', () => {
  const contents = [
    '_version: 1',
    'sections:',
    '  - _id: "same0001"',
    '    title: "One"',
    '  - _id: "same0001"',
    '    title: "Two"',
    '',
  ].join('\n');

  expect(() => parseEntry('default', contents)).toThrow(
    'sections[1]._id: duplicate row identity "same0001"; already used at sections[0]._id. Give each row in sections a unique _id and keep matching IDs aligned across locale files.',
  );
  expect(() =>
    stringifyEntry('default', {
      sections: [
        { _id: 'same0001', title: 'One' },
        { _id: 'same0001', title: 'Two' },
      ],
    }),
  ).toThrow('sections[1]._id: duplicate row identity "same0001"');
});

test('the same row identity remains valid in separate addressed collections', () => {
  const data = {
    primary: [{ _id: 'same0001', title: 'One' }],
    secondary: [{ _id: 'same0001', title: 'The matching row in another collection' }],
  };

  expect(parseEntry('default', stringifyEntry('default', data))).toEqual(data);
});

test('a persisted entry must be an object while incomplete and opaque fields remain valid', () => {
  expect(() => stringifyEntry('default', ['not', 'an', 'entry'])).toThrow(
    'Entry: expected an object, got an array',
  );
  expect(
    parseEntry('default', stringifyEntry('default', { title: '', opaque: { kept: true } })),
  ).toEqual({ title: '', opaque: { kept: true } });
});

// A template carries no `_id`s; they are generated when an entry is created from it.
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

for (const [type, fixture] of Object.entries({
  ...scalars,
  ...structured,
  ...nesting,
  ...conventions,
})) {
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

// Which video an embed points at is every language's, so a translation cannot change it.
test('a translated save of an embed writes the title and leaves the video alone', () => {
  const form: Form = {
    fields: [{ path: ['video'], label: 'Video', type: 'embed', required: false }],
    blocks: {},
  };
  const de = {
    _version: 1,
    video: { provider: 'youtube', id: 'dQw4w9WgXcQ', title: 'Rundgang', start: 42 },
  };
  const values = {
    video: { provider: 'vimeo', id: '76979871', title: 'Rundgang durchs Haus', start: 7 },
  };

  expect(mergeEntry('default', de, values, form)).toEqual({
    _version: 1,
    video: { provider: 'youtube', id: 'dQw4w9WgXcQ', title: 'Rundgang durchs Haus', start: 42 },
  });
});

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

test.each([
  {
    name: 'an unquoted date is named with its file, its key and the quotes it needs',
    body: 'title: Note\npublished: 2026-07-14\n',
    errors: [
      'src/content/notes/en/one.yaml › published: an unquoted date is a timestamp, not a string. Quote it: "2026-07-14"',
    ],
  },
  {
    name: 'a quoted date is a string to both parsers and passes',
    body: 'published: "2026-07-14"\nalso: \'2026-07-14\'\n',
    errors: [],
  },
  {
    name: 'an unquoted date-time is a timestamp too',
    body: 'at: 2026-07-14 10:30:00\niso: 2026-07-14T10:30:00Z\n',
    errors: [
      'src/content/notes/en/one.yaml › at: an unquoted date is a timestamp, not a string. Quote it: "2026-07-14 10:30:00"',
      'src/content/notes/en/one.yaml › iso: an unquoted date is a timestamp, not a string. Quote it: "2026-07-14T10:30:00Z"',
    ],
  },
  {
    name: 'a single-digit month or day is a string to js-yaml as well, so it passes',
    body: 'published: 2026-7-4\n',
    errors: [],
  },
  {
    name: 'a date nested in an array of groups is named by its path',
    body: 'slots:\n  - _id: "a1"\n    starts: 2026-07-14\n',
    errors: [
      'src/content/notes/en/one.yaml › slots[0].starts: an unquoted date is a timestamp, not a string. Quote it: "2026-07-14"',
    ],
  },
])('$name', ({ body, errors }) => {
  expect(dated(body)).toEqual(errors);
});

test('a translated field its form left empty goes, rather than coming back', () => {
  const de = { _version: 1, title: 'Mühlenhaus', summary: 'Am Fluss', price: 425000 };

  expect(mergeEntry('default', de, { title: 'Mühlenhaus' }, listing)).toEqual({
    _version: 1,
    title: 'Mühlenhaus',
    price: 425000,
  });
});

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

// Create-from-English used to write shared keys before translated ones (F4 in 02-i18n.md).
const presenter: Form = {
  fields: [
    { path: ['name'], label: 'Name', type: 'text', required: true },
    { path: ['role'], label: 'Role', type: 'text', required: true, i18n: 'duplicate' },
    { path: ['bio'], label: 'Bio', type: 'text', required: false },
  ],
  blocks: {},
};

test('a file made from another language is written in schema order', () => {
  const en = {
    _version: 1,
    name: 'Theo Adeyemi',
    role: 'Presenter',
    bio: 'Mornings on the coast.',
  };

  const made = syncLocale('default', presenter, 'de', { before: en, after: en }, {});
  const typed = mergeEntry(
    'default',
    made,
    { name: 'Theo Adeyemi', bio: 'Morgens am Meer.' },
    presenter,
  );

  expect(Object.keys(typed)).toEqual(['_version', 'name', 'role', 'bio']);
});

test('a machine-written path that a save types over stops being machine-written', () => {
  const de = {
    _version: 1,
    _machine: ['title', 'summary'],
    title: 'Mühlenhaus',
    summary: 'Eine restaurierte Mühle am Dart.',
  };

  const saved = mergeEntry(
    'default',
    de,
    { title: 'Mühlenhaus', summary: 'Eine restaurierte Mühle am Wehr.' },
    listing,
  );

  expect(saved._machine).toEqual(['title']);
});

test('a save that changes nothing leaves the machine-written paths alone', () => {
  const de = { _version: 1, _machine: ['title'], title: 'Mühlenhaus' };

  expect(mergeEntry('default', de, { title: 'Mühlenhaus' }, listing)._machine).toEqual(['title']);
});

test('the last machine-written path typed over takes the key out of the file', () => {
  const de = { _version: 1, _machine: ['title'], title: 'Mühlenhaus' };

  expect(mergeEntry('default', de, { title: 'Mühle' }, listing)).not.toHaveProperty('_machine');
});

// One skeleton, one label per language.
const navigation: Form = {
  fields: [{ path: ['menus'], label: 'Menus', type: 'menus', required: true, i18n: 'duplicate' }],
  blocks: {},
};
const tree = (labels: [string, string, string], over: Record<string, unknown> = {}) => ({
  _version: 1,
  menus: [
    {
      _id: 'n1h2e3a4',
      key: 'header',
      items: [
        { _id: 'h1o2m3e4', label: labels[0], link: { type: 'entry', ref: 'pages/home' } },
        {
          _id: 'l1i2s3t4',
          label: labels[1],
          link: { type: 'url', href: '/listings' },
          children: [{ _id: 'm1i2l3l4', label: '', link: { type: 'entry', ref: 'listings/mill' } }],
        },
        { _id: 'i1m2p3r4', label: labels[2], link: { type: 'entry', ref: 'pages/impressum' } },
      ],
      ...over,
    },
  ],
});
const de = () => tree(['Startseite', 'Angebote', 'Impressum']);
const itemsOf = (data: Record<string, unknown>) =>
  ((data.menus as Record<string, unknown>[])[0]?.items ?? []) as Record<string, unknown>[];

test('a translated save writes labels and moves nothing', () => {
  const values = {
    menus: [
      {
        _id: 'n1h2e3a4',
        key: 'header',
        items: [
          {
            _id: 'l1i2s3t4',
            label: 'Angebote, neu',
            link: { type: 'entry', ref: 'pages/somewhere-else' },
          },
          { _id: 'n9e8w7', label: 'Neu', link: { type: 'url', href: '/neu' } },
        ],
      },
    ],
  };

  const saved = mergeEntry('default', de(), values, navigation);

  expect(itemsOf(saved).map((i) => [i._id, i.label])).toEqual([
    ['h1o2m3e4', 'Startseite'],
    ['l1i2s3t4', 'Angebote, neu'],
    ['i1m2p3r4', 'Impressum'],
  ]);
  expect(itemsOf(saved)[1]?.link).toEqual({ type: 'url', href: '/listings' });
});

const sourceGolden = readFileSync(join(goldenDir, 'source-marked.yaml'), 'utf8');

test('withSource puts the key right after `_version`, and a write keeps it there', () => {
  const marked = withSource(
    'default',
    { _i18n: { sourceLocale: 'de' }, title: 'Notice', _version: 1 },
    'de',
  );

  expect(Object.keys(marked)).toEqual(['_version', '_source', '_i18n', 'title']);
  expect(Object.keys(writtenEntry('default', marked, listing.fields))).toEqual([
    '_version',
    '_source',
    '_i18n',
    'title',
  ]);
});

test('withSource writes the source-marked golden byte for byte', () => {
  const { _source, ...unmarked } = parseEntry('default', sourceGolden) as Record<string, unknown>;

  expect(stringifyEntry('default', withSource('default', unmarked, 'de'))).toBe(sourceGolden);
});

test('a save, a sibling sync, a change of offer and a plain write keep a file its `_source`', () => {
  const de = { _version: 1, _source: 'de', title: 'Mühlenhaus' };
  const en = { _version: 1, _source: 'de', title: 'Mill House', price: 1 };

  expect(mergeEntry('default', de, { title: 'Die Mühle' }, listing)._source).toBe('de');
  expect(syncLocale('default', listing, 'en', { before: de, after: de }, en)._source).toBe('de');
  const offer = { offered: ['de'], locales: ['en', 'de'] };
  expect(offeredEntry('default', de, offer)._source).toBe('de');
  expect(writtenEntry('default', de, listing.fields)._source).toBe('de');
});
