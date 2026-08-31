import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  type CheckEntry,
  type CheckInput,
  type CheckResult,
  type CheckSite,
  runChecks,
} from './checks.js';
import { type Db, openDb } from './db.js';
import type { ContentIndex } from './entries.js';
import type { R2Store } from './media.js';
import type { Form } from './schema.js';
import * as tables from './tables.js';

const site: CheckSite = {
  i18n: { locales: ['en', 'de'], defaultLocale: 'en' },
  collections: {
    listings: { route: '/listings/[slug]', index: '/listings', localizedSlugs: true },
    pages: { route: '/[slug]' },
  },
};

const file = (collection: string, locale: string, name: string) =>
  `src/content/${collection}/${locale}/${name}.yaml`;

const index: ContentIndex = {
  listings: [
    {
      id: 'mill-house',
      locales: {
        en: { title: 'The Mill House', path: file('listings', 'en', 'mill-house') },
        de: {
          title: 'Das Mühlenhaus',
          path: file('listings', 'de', 'mill-house'),
          slug: 'muehlenhaus',
        },
      },
    },
    {
      id: 'cafe-bar',
      locales: { en: { title: 'The Café Bar', path: file('listings', 'en', 'cafe-bar') } },
      offered: ['en'],
    },
    {
      id: 'old-barn',
      locales: {
        en: { title: 'The Old Barn', path: file('listings', 'en', 'old-barn'), status: 'hidden' },
        de: { title: 'Die Scheune', path: file('listings', 'de', 'old-barn'), status: 'hidden' },
      },
    },
  ],
};

const listing: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['summary'], label: 'Summary', type: 'richtext', required: true, tier: 'basic' },
    { path: ['photo'], label: 'Photo', type: 'image', required: false, preset: { max: 2400 } },
    { path: ['brochure'], label: 'Brochure', type: 'file', required: false, accept: ['pdf'] },
    { path: ['cta'], label: 'Call to action', type: 'link', required: false },
    { path: ['seo'], label: 'Seo', type: 'seo', required: false },
    { path: ['blocks'], label: 'Blocks', type: 'blocks', required: false, types: ['promo'] },
  ],
  blocks: {
    promo: [
      { path: ['heading'], label: 'Heading', type: 'text', required: true },
      { path: ['link'], label: 'Link', type: 'link', required: false },
    ],
  },
};

const navigation: Form = {
  fields: [{ path: ['menus'], label: 'Menus', type: 'menus', required: true, i18n: 'duplicate' }],
  blocks: {},
};

/** One entry as the drawer would hand it over: its files, and the languages going out. */
const entryOf = (
  key: string,
  files: Record<string, string>,
  form: Form = listing,
  publishing = Object.keys(files),
): CheckEntry => {
  const [collection = '', name = ''] = key.split('/');
  return {
    key,
    form,
    publishing,
    files: Object.fromEntries(
      Object.entries(files).map(([locale, contents]) => [
        locale,
        { path: file(collection, locale, name), contents },
      ]),
    ),
  };
};

const mf = new Miniflare({
  modules: true,
  script: 'export default {}',
  d1Databases: { DB: ':memory:' },
});
afterAll(() => mf.dispose());

let db: Db;
beforeAll(async () => {
  const binding = await mf.getD1Database('DB');
  const ddl = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson({ ...tables }),
  );
  await binding.batch(ddl.map((sql) => binding.prepare(sql)));
  db = openDb('default', binding);
});

const run = (
  entries: CheckEntry[],
  extra: Partial<CheckInput> = {},
  deps: { fetch?: typeof globalThis.fetch } = {},
) => runChecks('default', db, { entries, site, index, ...extra }, deps);

const shown = (results: CheckResult[]) => results.map((r) => `${r.check} ${r.fieldPath}`);

const store: R2Store = {
  accountId: '2e4dff78a4af5223c7940d6b41d7c9a7',
  bucket: 'site-media',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
};

/** The bucket with these keys in it, and every key it was asked about. */
function bucket(has: string[]) {
  const asked: string[] = [];
  const fetch = (async (input: Request) => {
    const key = new URL(input.url).pathname.slice(`/${store.bucket}/`.length);
    asked.push(key);
    return new Response(null, { status: has.includes(key) ? 200 : 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

const picture = (hash: string) => `media/${hash}.webp`;
const image = (hash: string, alt = 'The mill from the river') =>
  `photo:\n  src: "${picture(hash)}"\n  alt: "${alt}"\n  width: 2400\n  height: 1600\n`;

const title = 'title: "The Mill House"\n';

test('a link to an entry the site does not have is a warning naming the reference', async () => {
  const results = await run([
    entryOf('listings/mill-house', {
      en: `${title}cta:\n  type: "entry"\n  ref: "listings/gone"\n`,
    }),
  ]);
  expect(shown(results)).toContain('link-target cta.ref');
  expect(results[0]?.severity).toBe('warn');
  expect(results.find((r) => r.check === 'link-target')?.message).toContain('listings/gone');
});

test('a link to an entry with no page in this language is a warning about this language', async () => {
  const results = await run([
    entryOf(
      'listings/mill-house',
      { de: `title: "Das Mühlenhaus"\ncta:\n  type: "entry"\n  ref: "listings/cafe-bar"\n` },
      listing,
      ['de'],
    ),
  ]);
  const found = results.find((r) => r.check === 'link-locale');
  expect(found?.fieldPath).toBe('cta.ref');
  expect(found?.message).toContain('The Café Bar');
  expect(found?.message).toContain('DE');
});

test('a typed address under a collection’s route with no entry at it is a broken link', async () => {
  const results = await run([
    entryOf('listings/mill-house', {
      en: `${title}cta:\n  type: "url"\n  href: "/listings/no-such-place"\n`,
    }),
  ]);
  expect(shown(results)).toContain('link-target cta.href');
});

test('a path none of the site’s routes produce is left alone: a template may render it', async () => {
  const results = await run([
    entryOf('listings/mill-house', {
      en: `${title}cta:\n  type: "url"\n  href: "/about-us/our-team"\n`,
    }),
  ]);
  expect(shown(results)).not.toContain('link-target cta.href');
});

test('the language’s own address answers: /de/listings/muehlenhaus is the mill house', async () => {
  const good = await run([
    entryOf('listings/mill-house', {
      en: `${title}cta:\n  type: "url"\n  href: "/de/listings/muehlenhaus#book"\n`,
    }),
  ]);
  expect(shown(good).filter((s) => s.startsWith('link'))).toEqual([]);
  const bad = await run([
    entryOf('listings/mill-house', {
      en: `${title}cta:\n  type: "url"\n  href: "/de/listings/mill-house"\n`,
    }),
  ]);
  expect(shown(bad)).toContain('link-target cta.href');
});

test('a link inside a block is reported at the block’s own address', async () => {
  const results = await run([
    entryOf('listings/mill-house', {
      en: `${title}blocks:\n  - _type: "promo"\n    _id: "b1x2y3z4"\n    heading: "Stay"\n    link:\n      type: "entry"\n      ref: "listings/gone"\n`,
    }),
  ]);
  expect(shown(results)).toContain('link-target blocks[_id=b1x2y3z4].link.ref');
});

test('a link in richtext is read with the parser the page is rendered with', async () => {
  const results = await run([
    entryOf('listings/mill-house', {
      en: `${title}summary: "Book the [barn](/listings/no-such-place) or [write to us](mailto:hello@example.com)"\n`,
    }),
  ]);
  const found = results.find((r) => r.check === 'link-target');
  expect(found?.fieldPath).toBe('summary');
  expect(found?.message).toContain('/listings/no-such-place');
});

test('a key the table and the bucket both have nothing for is an error, and the only one', async () => {
  const hash = 'a'.repeat(64);
  const r2 = bucket([]);
  const results = await run(
    [entryOf('listings/mill-house', { en: title + image(hash) })],
    { store },
    { fetch: r2.fetch },
  );
  expect(r2.asked).toEqual([picture(hash)]);
  const found = results.find((r) => r.check === 'media-missing');
  expect(found?.severity).toBe('error');
  expect(found?.fieldPath).toBe('photo.src');
  expect(found?.message).toContain('Photo');
  expect(found?.message).toContain(picture(hash));
});

test('an object the bucket still has is nobody’s problem, row or no row', async () => {
  const hash = 'b'.repeat(64);
  const r2 = bucket([picture(hash)]);
  const results = await run(
    [entryOf('listings/mill-house', { en: title + image(hash) })],
    { store },
    { fetch: r2.fetch },
  );
  expect(shown(results).filter((s) => s.startsWith('media'))).toEqual([]);
});

test('the sharing picture is looked up like any other, under its own name', async () => {
  const hash = 'f'.repeat(64);
  const r2 = bucket([]);
  const results = await run(
    [
      entryOf('listings/mill-house', {
        en: `${title}seo:\n  image:\n    src: "media/${hash}.webp"\n    width: 1200\n    height: 630\n`,
      }),
    ],
    { store },
    { fetch: r2.fetch },
  );
  const found = results.find((r) => r.check === 'media-missing');
  expect(found?.fieldPath).toBe('seo.image.src');
  expect(found?.message).toContain('The sharing image');
});

test('a picture that has been archived is a warning, and the bucket is not asked about it', async () => {
  const hash = 'c'.repeat(64);
  await db.insert(tables.media).values({
    id: hash,
    siteId: 'default',
    r2Key: picture(hash),
    mime: 'image/webp',
    archived: 1,
    createdAt: Date.now(),
  });
  const r2 = bucket([]);
  const results = await run(
    [entryOf('listings/mill-house', { en: title + image(hash) })],
    { store },
    { fetch: r2.fetch },
  );
  expect(r2.asked).toEqual([]);
  expect(shown(results)).toContain('media-archived photo.src');
  const found = results.find((r) => r.check === 'media-archived');
  expect(found?.severity).toBe('warn');
  expect(found?.message).toContain('Photo');
});

test('a picture with no alt text is a warning against the alt, not the picture', async () => {
  const hash = 'd'.repeat(64);
  const r2 = bucket([picture(hash)]);
  const results = await run(
    [entryOf('listings/mill-house', { en: title + image(hash, '  ') })],
    { store },
    { fetch: r2.fetch },
  );
  const found = results.find((r) => r.check === 'image-alt');
  expect(found?.fieldPath).toBe('photo.alt');
  expect(found?.message).toContain('Photo');
});

test('a required field left empty in a translation is a warning; the source language is not', async () => {
  const translated = await run([
    entryOf('listings/mill-house', { de: 'title: ""\nsummary: "Ein Mühlenhaus"\n' }, listing, [
      'de',
    ]),
  ]);
  const found = translated.find((r) => r.check === 'translation-empty');
  expect(found?.fieldPath).toBe('title');
  expect(found?.message).toContain('DE');
  const source = await run([entryOf('listings/mill-house', { en: 'title: ""\n' })]);
  expect(shown(source)).not.toContain('translation-empty title');
});

test('a translation made from an older version of its source language is a note', async () => {
  const results = await run([
    entryOf('listings/mill-house', {
      en: `${title}summary: "A mill house on the river"\n`,
      de: 'title: "Das Mühlenhaus"\n_i18n:\n  sourceLocale: "en"\n  sourceBlob: "0000"\n  sourceHash: "notthehashatall"\n  translatedAt: "2026-08-01T10:00:00.000Z"\n',
    }),
  ]);
  const found = results.find((r) => r.check === 'translation-stale');
  expect(found?.path).toBe(file('listings', 'de', 'mill-house'));
  expect(found?.severity).toBe('info');
  expect(found?.message).toContain('EN');
});

test('a translation going out on its own is still measured against the language it came from', async () => {
  const results = await run([
    entryOf(
      'listings/mill-house',
      {
        en: `${title}summary: "A mill house on the river"\n`,
        de: 'title: "Das Mühlenhaus"\n_i18n:\n  sourceLocale: "en"\n  sourceBlob: "0000"\n  sourceHash: "notthehashatall"\n  translatedAt: "2026-08-01T10:00:00.000Z"\n',
      },
      listing,
      ['de'],
    ),
  ]);
  expect(results.map((r) => r.check)).toContain('translation-stale');
});

test('a value a machine filled in and nobody has read is a note at that value’s own address', async () => {
  const results = await run([
    entryOf(
      'listings/mill-house',
      {
        de: 'title: "Das Mühlenhaus"\n_machine:\n  - "summary"\n  - "blocks[_id=b1x2y3z4].heading"\n',
      },
      listing,
      ['de'],
    ),
  ]);
  expect(shown(results).filter((s) => s.startsWith('translation-machine'))).toEqual([
    'translation-machine summary',
    'translation-machine blocks[_id=b1x2y3z4].heading',
  ]);
});

test('a page with nothing to say about itself gets a note apiece, and the site’s defaults answer them', async () => {
  const bare = await run([entryOf('listings/mill-house', { en: title })]);
  expect(shown(bare)).toEqual(['seo-description seo.description', 'seo-image seo.image']);
  const withDefaults = await run([entryOf('listings/mill-house', { en: title })], {
    seoDefaults: {
      en: {
        description: 'Holiday cottages in the Derbyshire Dales',
        image: { src: `media/${'e'.repeat(64)}.webp`, width: 1200, height: 630 },
      },
    },
  });
  expect(shown(withDefaults).filter((s) => s.startsWith('seo'))).toEqual([]);
});

test('a search title longer than a search result shows is a note', async () => {
  const long = 'The Mill House, a converted watermill in the Derbyshire Dales, sleeps six';
  const results = await run([
    entryOf('listings/mill-house', { en: `${title}seo:\n  title: "${long}"\n` }),
  ]);
  const found = results.find((r) => r.check === 'seo-title');
  expect(found?.fieldPath).toBe('seo.title');
  expect(found?.message).toContain(String(long.length));
});

test('a menu item pointing at a page that is gone, or hidden everywhere, is a warning', async () => {
  const menus = [
    'menus:',
    '  - _id: "m1a2b3c4"',
    '    key: "header"',
    '    items:',
    '      - _id: "i1a2b3c4"',
    '        label: "Gone"',
    '        link:',
    '          type: "entry"',
    '          ref: "listings/gone"',
    '      - _id: "i2a2b3c4"',
    '        link:',
    '          type: "entry"',
    '          ref: "listings/cafe-bar"',
    '        children:',
    '          - _id: "i3a2b3c4"',
    '            link:',
    '              type: "entry"',
    '              ref: "listings/old-barn"',
    '',
  ].join('\n');
  const results = await run([entryOf('globals/navigation', { en: menus }, navigation)]);
  expect(shown(results)).toEqual([
    'menu-target menus[_id=m1a2b3c4].items[_id=i1a2b3c4].link',
    'menu-target menus[_id=m1a2b3c4].items[_id=i2a2b3c4].children[_id=i3a2b3c4].link',
  ]);
  expect(results[1]?.message).toContain('The Old Barn');
});

test('only the languages this publish commits are linted', async () => {
  const broken = `title: "Das Mühlenhaus"\ncta:\n  type: "entry"\n  ref: "listings/gone"\n`;
  const results = await run([
    entryOf('listings/mill-house', { en: title, de: broken }, listing, ['en']),
  ]);
  expect(results.map((r) => r.path)).not.toContain(file('listings', 'de', 'mill-house'));
  expect(shown(results)).not.toContain('link-target cta.ref');
});

test('a check the site has turned off says nothing at all', async () => {
  const entries = [
    entryOf('listings/mill-house', {
      en: `${title}cta:\n  type: "entry"\n  ref: "listings/gone"\n`,
    }),
  ];
  expect(shown(await run(entries))).toContain('link-target cta.ref');
  const quiet = await run(entries, { ignore: ['link-target', 'seo-description', 'seo-image'] });
  expect(quiet).toEqual([]);
});

test('results are grouped by the file they are about', async () => {
  const results = await run([
    entryOf('listings/mill-house', {
      en: `${title}cta:\n  type: "entry"\n  ref: "listings/gone"\n`,
      de: `title: "Das Mühlenhaus"\ncta:\n  type: "entry"\n  ref: "listings/gone"\n`,
    }),
  ]);
  expect(results.map((r) => r.path)).toEqual([
    ...results.filter((r) => r.path.includes('/de/')).map((r) => r.path),
    ...results.filter((r) => r.path.includes('/en/')).map((r) => r.path),
  ]);
});
