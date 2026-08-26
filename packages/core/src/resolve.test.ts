import { expect, test } from 'vitest';
import { applyResolution, conflictReport } from './resolve.js';
import type { Form } from './schema.js';

// The same listing the diff is read on: a shared price, a summary in each language's own words.
const listing: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['summary'], label: 'Summary', type: 'text', required: false },
    { path: ['body'], label: 'Body', type: 'richtext', required: false, tier: 'full' },
    { path: ['price'], label: 'Price', type: 'number', required: true, i18n: 'duplicate' },
  ],
  blocks: {},
};

const page: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    {
      path: ['blocks'],
      label: 'Blocks',
      type: 'blocks',
      required: false,
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
const gallery = { _type: 'hero', _id: 'cccc3333', heading: 'Gallery' };

test('a field only one side changed is merged rather than asked about', () => {
  const base = { title: 'Mill House', summary: 'A mill.', price: 450000 };

  const report = conflictReport('default', listing, {
    en: {
      base,
      ours: { ...base, summary: 'A mill above the weir.' },
      theirs: { ...base, price: 440000 },
    },
  });

  expect(report.questions).toEqual([]);
  expect(report.merged.map((m) => [m.label, m.side])).toEqual([
    ['Summary', 'ours'],
    ['Price', 'theirs'],
  ]);
});

test('a field both sides changed is one question, and it names what both started from', () => {
  const base = { title: 'Mill House', price: 450000 };

  const report = conflictReport('default', listing, {
    en: { base, ours: { ...base, price: 435000 }, theirs: { ...base, price: 440000 } },
  });

  expect(report.merged).toEqual([]);
  expect(report.questions).toEqual([
    {
      path: 'price',
      label: 'Price',
      locale: 'en',
      base: '450000',
      ours: { path: 'price', label: 'Price', kind: 'value', before: '450000', after: '435000' },
      theirs: { path: 'price', label: 'Price', kind: 'value', before: '450000', after: '440000' },
    },
  ]);
});

test('a field both sides changed the same way is not a question', () => {
  const base = { title: 'Mill House', price: 450000 };
  const both = { ...base, price: 440000 };

  const report = conflictReport('default', listing, { en: { base, ours: both, theirs: both } });

  expect(report.questions).toEqual([]);
  expect(report.merged.map((m) => m.label)).toEqual(['Price']);
});

test('a question about a sentence carries the words each side moved', () => {
  const base = { summary: 'A cottage above the harbour' };

  const report = conflictReport('default', listing, {
    en: {
      base,
      ours: { summary: 'A cottage above the fish market' },
      theirs: { summary: 'A whitewashed cottage above the harbour' },
    },
  });

  expect(report.questions[0]?.base).toBe('A cottage above the harbour');
  expect(report.questions[0]?.ours).toMatchObject({
    kind: 'words',
    parts: [
      { text: 'A cottage above the ' },
      { text: 'harbour', mark: 'del' },
      { text: 'fish market', mark: 'ins' },
    ],
  });
});

test('a value the languages share is one question and not one per language', () => {
  const en = { title: 'Mill House', price: 450000 };
  const de = { title: 'Mühlenhaus', price: 450000 };
  const ours = (data: typeof en) => ({ ...data, price: 435000 });
  const theirs = (data: typeof en) => ({ ...data, price: 440000 });

  const report = conflictReport('default', listing, {
    en: { base: en, ours: ours(en), theirs: theirs(en) },
    de: { base: de, ours: ours(de), theirs: theirs(de) },
  });

  expect(report.questions.map((q) => [q.path, q.locale])).toEqual([['price', undefined]]);
});

test("a question about one language's own words says which language it is", () => {
  const en = { title: 'Mill House', summary: 'A mill.', price: 450000 };
  const de = { title: 'Mühlenhaus', summary: 'Eine Mühle.', price: 450000 };

  const report = conflictReport('default', listing, {
    en: {
      base: en,
      ours: { ...en, summary: 'A mill above the weir.' },
      theirs: { ...en, summary: 'A restored mill.' },
    },
    de: { base: de, ours: de, theirs: de },
  });

  expect(report.questions.map((q) => [q.path, q.locale])).toEqual([['summary', 'en']]);
});

test('a block one side added and a block the other side edited are both merged', () => {
  const base = { title: 'Home', blocks: [hero, gallery] };

  const report = conflictReport('default', page, {
    en: {
      base,
      ours: { ...base, blocks: [hero, gallery, cta] },
      theirs: { ...base, blocks: [hero, { ...gallery, heading: 'Pictures' }] },
    },
  });

  expect(report.questions).toEqual([]);
  expect(report.merged.map((m) => [m.label, m.side])).toEqual([
    ['Newsletter signup', 'ours'],
    ['Pictures · Heading', 'theirs'],
  ]);
});

test('the same heading rewritten on both sides is a question about that block', () => {
  const base = { title: 'Home', blocks: [hero] };

  const report = conflictReport('default', page, {
    en: {
      base,
      ours: { ...base, blocks: [{ ...hero, heading: 'Seaview Cottage, Devon' }] },
      theirs: { ...base, blocks: [{ ...hero, heading: 'Seaview Cottage, Salcombe' }] },
    },
  });

  expect(report.questions.map((q) => [q.path, q.label, q.base])).toEqual([
    ['blocks[_id=aaaa1111].heading', 'Seaview Cottage, Devon · Heading', 'Seaview Cottage'],
  ]);
});

test('a body too long to read twice is asked about whole', () => {
  const base = { body: 'A mill.' };

  const report = conflictReport('default', listing, {
    en: { base, ours: { body: 'A mill above the weir.' }, theirs: { body: 'A restored mill.' } },
  });

  expect(report.questions.map((q) => [q.path, q.ours.kind, q.base])).toEqual([
    ['body', 'whole', undefined],
  ]);
});

test('what nobody answered takes the side that changed it', () => {
  const base = { title: 'Mill House', summary: 'A mill.', price: 450000 };

  const resolved = applyResolution(
    'default',
    listing,
    {
      en: {
        base,
        ours: { ...base, summary: 'A mill above the weir.' },
        theirs: { ...base, price: 440000 },
      },
    },
    [],
  );

  expect(resolved.en).toEqual({
    title: 'Mill House',
    summary: 'A mill above the weir.',
    price: 440000,
  });
});

test('an answer decides the field it names and nothing else', () => {
  const base = { title: 'Mill House', summary: 'A mill.', price: 450000 };
  const files = {
    en: {
      base,
      ours: { ...base, summary: 'A mill above the weir.', price: 435000 },
      theirs: { ...base, summary: 'A mill above the weir.', price: 440000 },
    },
  };

  const answer = (side: 'ours' | 'theirs') => [{ path: 'price', locale: 'en', side }] as const;
  const mine = applyResolution('default', listing, files, [...answer('ours')]);
  const theirs = applyResolution('default', listing, files, [...answer('theirs')]);

  expect(mine.en).toMatchObject({ price: 435000, summary: 'A mill above the weir.' });
  expect(theirs.en).toMatchObject({ price: 440000, summary: 'A mill above the weir.' });
});

test('an answer about a shared value is written into every language', () => {
  const en = { title: 'Mill House', price: 450000 };
  const de = { title: 'Mühlenhaus', price: 450000 };
  const files = {
    en: { base: en, ours: { ...en, price: 435000 }, theirs: { ...en, price: 440000 } },
    de: { base: de, ours: { ...de, price: 435000 }, theirs: { ...de, price: 440000 } },
  };

  const resolved = applyResolution('default', listing, files, [{ path: 'price', side: 'ours' }]);

  expect([resolved.en, resolved.de]).toMatchObject([{ price: 435000 }, { price: 435000 }]);
});

test('the marks a file carries are the ones the side it came from had', () => {
  const base = { _version: 1, _machine: ['summary'], title: 'Mill House' };

  const resolved = applyResolution(
    'default',
    listing,
    {
      en: {
        base,
        ours: { ...base, title: 'The Mill House' },
        theirs: { _version: 1, title: 'Mill House', _i18n: { de: false } },
      },
    },
    [],
  );

  expect(resolved.en).toEqual({ _version: 1, title: 'The Mill House', _i18n: { de: false } });
});

test('a block one side added stays, and one the other side removed goes', () => {
  const base = { title: 'Home', blocks: [hero, gallery] };

  const resolved = applyResolution(
    'default',
    page,
    {
      en: {
        base,
        ours: { ...base, blocks: [hero, gallery, cta] },
        theirs: { ...base, blocks: [hero] },
      },
    },
    [],
  );

  expect((resolved.en as { blocks: { _id: string }[] }).blocks.map((b) => b._id)).toEqual([
    'aaaa1111',
    'bbbb2222',
  ]);
});

test('a block added in the repository arrives where it was put', () => {
  const base = { title: 'Home', blocks: [hero, gallery] };

  const resolved = applyResolution(
    'default',
    page,
    {
      en: {
        base,
        ours: { ...base, blocks: [gallery, hero] },
        theirs: { ...base, blocks: [hero, cta, gallery] },
      },
    },
    [],
  );

  expect((resolved.en as { blocks: { _id: string }[] }).blocks.map((b) => b._id)).toEqual([
    'cccc3333',
    'aaaa1111',
    'bbbb2222',
  ]);
});

test('a language nobody changed comes out of the resolution as it went in', () => {
  const en = { title: 'Mill House', price: 450000 };
  const de = { title: 'Mühlenhaus', price: 450000 };

  const resolved = applyResolution(
    'default',
    listing,
    {
      en: { base: en, ours: { ...en, title: 'The Mill House' }, theirs: en },
      de: { base: de, ours: de, theirs: de },
    },
    [],
  );

  expect(resolved.de).toEqual(de);
});
