import { expect, test } from 'vitest';
import { drifted, driftFile, listing, localeFile, millHouse, page } from './content.fixture.js';
import { parseEntry, stringifyEntry } from './entry-format.js';
import { applyDrift, driftReport, syncLocale, syncLocaleField } from './locale-sync.js';
import type { Form } from './schema.js';

test('one-field locale projection preserves translated properties and copies shared ones', () => {
  const field = listing.fields.find((candidate) => candidate.path[0] === 'image');
  if (!field) throw new Error('image field missing');
  const source = {
    src: 'media/new.webp',
    alt: 'New source words',
    width: 1800,
    height: 1200,
  };
  const target = {
    src: 'media/old.webp',
    alt: 'Bestehende Übersetzung',
    width: 1200,
    height: 800,
  };

  expect(syncLocaleField(field, true, source, target)).toEqual({
    src: 'media/new.webp',
    alt: 'Bestehende Übersetzung',
    width: 1800,
    height: 1200,
  });
  expect(syncLocaleField(field, true, undefined, target)).toEqual({
    alt: 'Bestehende Übersetzung',
  });
  expect(syncLocaleField(field, 'duplicate', source, target)).toBe(source);
  expect(syncLocaleField(field, false, source, target)).toBe(target);
});

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

test('a restored block takes translated and opaque values from its locale seed', () => {
  const before = {
    _version: 1,
    title: 'Home',
    blocks: [
      { _type: 'hero', _id: 'lead0001', heading: 'Welcome' },
      { _type: 'cta', _id: 'gone0001', heading: 'Book now' },
    ],
  };
  const after = {
    _version: 1,
    title: 'Home',
    blocks: [
      { _type: 'hero', _id: 'lead0001', heading: 'Welcome' },
      {
        _type: 'hero',
        _id: 'back0001',
        heading: 'Welcome back',
        image: { src: 'media/new.webp', alt: 'River', width: 1800, height: 1200 },
      },
    ],
  };
  const target = {
    _version: 1,
    title: 'Startseite',
    blocks: [
      { _type: 'hero', _id: 'lead0001', heading: 'Willkommen' },
      { _type: 'quote', _id: 'local001', body: 'Nur auf Deutsch.' },
      { _type: 'cta', _id: 'gone0001', heading: 'Jetzt buchen' },
    ],
  };

  expect(
    syncLocale('default', page, 'de', { before, after }, target, {
      seeds: [
        {
          address: 'blocks[_id=back0001]',
          value: {
            _type: 'hero',
            _id: 'back0001',
            heading: 'Willkommen zurück',
            image: {
              src: 'media/old.webp',
              alt: 'Der Fluss',
              width: 900,
              height: 600,
            },
            providerState: { crop: 'kept', token: 17 },
          },
        },
        {
          address: 'blocks[_id=gone0001]',
          value: { _type: 'cta', _id: 'gone0001', heading: 'Nicht wiederherstellen' },
        },
      ],
    }),
  ).toEqual({
    _version: 1,
    title: 'Startseite',
    blocks: [
      { _type: 'hero', _id: 'lead0001', heading: 'Willkommen' },
      { _type: 'quote', _id: 'local001', body: 'Nur auf Deutsch.' },
      {
        _type: 'hero',
        _id: 'back0001',
        heading: 'Willkommen zurück',
        image: {
          src: 'media/new.webp',
          alt: 'Der Fluss',
          width: 1800,
          height: 1200,
        },
        providerState: { crop: 'kept', token: 17 },
      },
    ],
  });
});

test('a seed cannot overwrite a surviving row or repair a row missing through drift', () => {
  const before = {
    blocks: [
      {
        _type: 'hero',
        _id: 'stay0001',
        heading: 'Stay',
        image: { src: 'media/old.webp', alt: 'Old' },
      },
      { _type: 'hero', _id: 'drift001', heading: 'Drifted' },
    ],
  };
  const after = {
    blocks: [
      {
        _type: 'hero',
        _id: 'stay0001',
        heading: 'Stay edited',
        image: { src: 'media/new.webp', alt: 'New' },
      },
      { _type: 'hero', _id: 'drift001', heading: 'Drifted' },
    ],
  };
  const target = {
    blocks: [
      {
        _type: 'hero',
        _id: 'stay0001',
        heading: 'Bleibt',
        image: { src: 'media/old.webp', alt: 'Bleibt alt' },
        opaque: 'survives',
      },
    ],
  };

  expect(
    syncLocale('default', page, 'de', { before, after }, target, {
      seeds: [
        {
          address: 'blocks[_id=stay0001]',
          value: { _type: 'hero', _id: 'stay0001', heading: 'Seeded', opaque: 'seeded' },
        },
        {
          address: 'blocks[_id=drift001]',
          value: { _type: 'hero', _id: 'drift001', heading: 'Not a drift answer' },
        },
      ],
    }),
  ).toEqual({
    _version: 1,
    blocks: [
      {
        _type: 'hero',
        _id: 'stay0001',
        heading: 'Bleibt',
        image: { src: 'media/new.webp', alt: 'Bleibt alt' },
        opaque: 'survives',
      },
      { _type: 'hero', _id: 'drift001' },
    ],
  });
});

test('locale exclusions discard a seed rather than inserting its row', () => {
  const before = { blocks: [] };
  const after = {
    blocks: [
      {
        _type: 'hero',
        _id: 'onlyen01',
        _locales: ['en'],
        heading: 'English only',
      },
    ],
  };

  expect(
    syncLocale(
      'default',
      page,
      'de',
      { before, after },
      { blocks: [] },
      {
        seeds: [
          {
            address: 'blocks[_id=onlyen01]',
            value: { _type: 'hero', _id: 'onlyen01', heading: 'Nicht einfügen' },
          },
        ],
      },
    ),
  ).toEqual({ _version: 1, blocks: [] });
});

test('duplicate seed addresses are ambiguous and restore nothing locale-owned', () => {
  const before = { blocks: [] };
  const after = {
    blocks: [
      {
        _type: 'hero',
        _id: 'back0001',
        heading: 'Welcome back',
        image: { src: 'media/new.webp', alt: 'River' },
      },
    ],
  };
  const seeds = ['Erste Fassung', 'Zweite Fassung'].map((heading) => ({
    address: 'blocks[_id=back0001]',
    value: { _type: 'hero', _id: 'back0001', heading },
  }));

  expect(syncLocale('default', page, 'de', { before, after }, { blocks: [] }, { seeds })).toEqual({
    _version: 1,
    blocks: [
      {
        _type: 'hero',
        _id: 'back0001',
        image: { src: 'media/new.webp' },
      },
    ],
  });
});

test('only translated string markers belonging to an accepted seed are restored', () => {
  const before = {
    blocks: [
      { _type: 'hero', _id: 'lead0001', heading: 'Welcome' },
      { _type: 'hero', _id: 'gone0001', heading: 'Gone' },
    ],
  };
  const after = {
    blocks: [
      { _type: 'hero', _id: 'lead0001', heading: 'Welcome' },
      {
        _type: 'hero',
        _id: 'back0001',
        heading: 'Welcome back',
        image: { src: 'media/new.webp', alt: 'River' },
      },
    ],
  };
  const target = {
    _machine: ['blocks[lead0001].heading', 'blocks[_id=gone0001].heading'],
    blocks: [
      { _type: 'hero', _id: 'lead0001', heading: 'Willkommen' },
      { _type: 'hero', _id: 'gone0001', heading: 'Fort' },
    ],
  };

  expect(
    syncLocale('default', page, 'de', { before, after }, target, {
      seeds: [
        {
          address: 'blocks[_id=back0001]',
          value: {
            _type: 'hero',
            _id: 'back0001',
            heading: 'Willkommen zurück',
            image: { src: 'media/old.webp', alt: 'Der Fluss' },
          },
          machine: [
            'blocks[_id=back0001].heading',
            'blocks[_id=back0001].image.alt',
            'blocks[_id=back0001].image.src',
            'blocks[_id=back0001].missing',
            'blocks[_id=lead0001].heading',
          ],
        },
      ],
    }),
  ).toEqual({
    _version: 1,
    _machine: [
      'blocks[lead0001].heading',
      'blocks[_id=back0001].heading',
      'blocks[_id=back0001].image.alt',
    ],
    blocks: [
      { _type: 'hero', _id: 'lead0001', heading: 'Willkommen' },
      {
        _type: 'hero',
        _id: 'back0001',
        heading: 'Willkommen zurück',
        image: { src: 'media/new.webp', alt: 'Der Fluss' },
      },
    ],
  });
});

test('a duplicated nested subtree restores markers already remapped to its new ids', () => {
  const nested: Form = {
    fields: [
      { path: ['sections'], label: 'Sections', type: 'blocks', required: true, types: ['columns'] },
    ],
    blocks: {
      columns: [
        {
          path: ['items'],
          label: 'Items',
          type: 'blocks',
          required: true,
          types: ['hero'],
        },
      ],
      hero: [
        { path: ['heading'], label: 'Heading', type: 'text', required: true },
        { path: ['rank'], label: 'Rank', type: 'number', required: true, i18n: 'duplicate' },
      ],
    },
  };
  const before = { sections: [] };
  const after = {
    sections: [
      {
        _type: 'columns',
        _id: 'newouter',
        items: [{ _type: 'hero', _id: 'newinner', heading: 'Copy', rank: 2 }],
      },
    ],
  };
  const marker = 'sections[_id=newouter].items[_id=newinner].heading';

  expect(
    syncLocale(
      'default',
      nested,
      'de',
      { before, after },
      { sections: [] },
      {
        seeds: [
          {
            address: 'sections[_id=newouter]',
            value: {
              _type: 'columns',
              _id: 'newouter',
              items: [
                {
                  _type: 'hero',
                  _id: 'newinner',
                  heading: 'Kopie',
                  rank: 1,
                  opaque: { from: 'duplicate' },
                },
              ],
            },
            machine: [marker],
          },
        ],
      },
    ),
  ).toEqual({
    _version: 1,
    _machine: [marker],
    sections: [
      {
        _type: 'columns',
        _id: 'newouter',
        items: [
          {
            _type: 'hero',
            _id: 'newinner',
            heading: 'Kopie',
            rank: 2,
            opaque: { from: 'duplicate' },
          },
        ],
      },
    ],
  });
});

test('a block deleted in one language is deleted in every language', () => {
  const before = drifted('en');
  const after = { ...before, blocks: [(before.blocks as unknown[])[0]] };

  const de = syncLocale('default', page, 'de', { before, after }, drifted('de'));

  expect(blockIds(de)).toEqual(['k3nf9a2p', 'p8xk2m4q', 'z9y8x7w6']);
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

// Drift is what a save is not allowed to resolve.
test('a block one language has without `_locales` is drift, and one with it is not', () => {
  expect(driftReport('default', page, { en: drifted('en'), de: drifted('de') })).toEqual([
    {
      path: 'blocks[_id=z9y8x7w6]',
      type: 'quote',
      in: ['de'],
      expected: ['en', 'de'],
      values: { de: ['Ein seltener Fund.'] },
    },
  ]);
});

test('an entry with a file in one language alone has nothing to have drifted from', () => {
  const de = drifted('de');
  // With no second file to reconcile against, a publish of a stray mark is never blocked.
  const stray = { _type: 'quote', _id: 'z9y8x7w6', _locales: ['en'], body: 'Ein seltener Fund.' };

  expect(driftReport('default', page, { de: { ...de, blocks: [stray] } })).toEqual([]);
});

test('a block in a language its `_locales` does not name has drifted too', () => {
  const de = drifted('de');
  const compliance = (de.blocks as unknown[])[1];
  const en = { ...drifted('en'), blocks: [...(drifted('en').blocks as unknown[]), compliance] };

  expect(driftReport('default', page, { en, de })).toEqual([
    {
      path: 'blocks[_id=p8xk2m4q]',
      type: 'compliance',
      in: ['en', 'de'],
      expected: ['de'],
      values: { en: ['Widerrufsbelehrung'], de: ['Widerrufsbelehrung'] },
    },
    {
      path: 'blocks[_id=z9y8x7w6]',
      type: 'quote',
      in: ['de'],
      expected: ['en', 'de'],
      values: { de: ['Ein seltener Fund.'] },
    },
  ]);
});

// The card shows what an answer would lose, and the panel reads no file of its own.
test('a drift row carries the words each language has for it', () => {
  const de = drifted('de');
  const compliance = (de.blocks as Record<string, unknown>[])[1];
  const en = {
    ...drifted('en'),
    blocks: [...(drifted('en').blocks as unknown[]), { ...compliance, heading: 'Right to cancel' }],
  };

  expect(driftReport('default', page, { en, de })[0]?.values).toEqual({
    en: ['Right to cancel'],
    de: ['Widerrufsbelehrung'],
  });
});

// The report addresses a row the way `_machine` addresses a field.
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
      values: { en: ['A rare find.'] },
    },
  ]);
});

test('a row an array in one language has and the other does not is drift', () => {
  const en = { sidebar: { features: [{ _id: 'f1f2f3f4', label: 'Parking' }] } };
  const de = { sidebar: { features: [] } };

  expect(driftReport('default', nested, { en, de })).toEqual([
    {
      path: 'sidebar.features[_id=f1f2f3f4]',
      in: ['en'],
      expected: ['en', 'de'],
      values: { en: ['Parking'] },
    },
  ]);
});

// An answer names the languages a row should end up in, which a save is not allowed to do.
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
const en = () => tree(['Home', 'Listings', 'Impressum']);
const de = () => tree(['Startseite', 'Angebote', 'Impressum']);
const itemsOf = (data: Record<string, unknown>) =>
  ((data.menus as Record<string, unknown>[])[0]?.items ?? []) as Record<string, unknown>[];
const childrenOf = (data: Record<string, unknown>, at: number) =>
  (itemsOf(data)[at]?.children ?? []) as Record<string, unknown>[];

test('a menu reordered in one language is reordered in the other, and its labels stay put', () => {
  const before = en();
  const [home, listings, impressum] = itemsOf(before);
  const after = tree(['Home', 'Listings', 'Impressum']);
  (after.menus[0] as Record<string, unknown>).items = [listings, home, impressum];

  const synced = syncLocale('default', navigation, 'de', { before, after }, de());

  expect(itemsOf(synced).map((i) => [i._id, i.label])).toEqual([
    ['l1i2s3t4', 'Angebote'],
    ['h1o2m3e4', 'Startseite'],
    ['i1m2p3r4', 'Impressum'],
  ]);
});

test('what a menu item points at follows the source language; the label does not', () => {
  const before = en();
  const after = en();
  const moved = itemsOf(after)[1] as Record<string, unknown>;
  moved.link = { type: 'entry', ref: 'pages/for-sale' };
  moved.newTab = true;
  moved.label = 'For sale';

  const synced = syncLocale('default', navigation, 'de', { before, after }, de());

  expect(itemsOf(synced)[1]).toMatchObject({
    label: 'Angebote',
    link: { type: 'entry', ref: 'pages/for-sale' },
    newTab: true,
  });
});

test('an item added in one language arrives in the other with no label of its own', () => {
  const before = en();
  const after = en();
  itemsOf(after).push({
    _id: 'c1o2n3t4',
    label: 'Contact',
    link: { type: 'entry', ref: 'pages/contact' },
  });

  const synced = syncLocale('default', navigation, 'de', { before, after }, de());

  expect(itemsOf(synced)[3]).toEqual({
    _id: 'c1o2n3t4',
    link: { type: 'entry', ref: 'pages/contact' },
  });
});

test('a child label is the child language’s own, however deep the tree goes', () => {
  const before = en();
  const after = en();
  const child = childrenOf(after, 1)[0] as Record<string, unknown>;
  child.label = 'The Mill';
  const target = de();
  (childrenOf(target, 1)[0] as Record<string, unknown>).label = 'Die Mühle';

  const synced = syncLocale('default', navigation, 'de', { before, after }, target);

  expect(childrenOf(synced, 1)[0]?.label).toBe('Die Mühle');
});

test('a synced menu file is written in the order the format declares', () => {
  const before = en();
  const after = en();
  (itemsOf(after)[0] as Record<string, unknown>).newTab = true;
  (itemsOf(after)[2] as Record<string, unknown>)._locales = ['de'];

  const synced = syncLocale('default', navigation, 'de', { before, after }, de());

  expect(Object.keys(itemsOf(synced)[0] ?? {})).toEqual(['_id', 'label', 'link', 'newTab']);
  expect(Object.keys(itemsOf(synced)[2] ?? {})).toEqual(['_id', '_locales', 'label', 'link']);
});

test('a menu item one language has without `_locales` is drift like any other row', () => {
  const short = de();
  itemsOf(short).splice(1, 1);

  expect(driftReport('default', navigation, { en: en(), de: short })).toEqual([
    {
      path: 'menus[_id=n1h2e3a4].items[_id=l1i2s3t4]',
      in: ['en'],
      expected: ['en', 'de'],
      values: { en: ['Listings'] },
    },
  ]);
});
