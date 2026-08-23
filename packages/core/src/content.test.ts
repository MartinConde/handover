import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { mergeEntry, parseEntry, staticSource, stringifyEntry } from './content.js';

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
