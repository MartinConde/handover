import { readFile } from 'node:fs/promises';
import { fieldsFrom, formOf, type JsonSchema, parseEntry, syncLocale } from '@handover/core';
import { z } from 'astro/zod';
import { expect, expectTypeOf, test } from 'vitest';
import {
  type Block,
  type BlockRegistry,
  blocks,
  defineBlock,
  defineConfig,
  embed,
  file,
  formSchema,
  image,
  link,
  navigation,
  redirects,
  reference,
  richtext,
  seo,
} from './index.js';

test('the scalar field types are detected from real Zod output', () => {
  const schema = z.object({
    title: z.string(),
    area: z.number(),
    sold: z.boolean(),
    from: z.iso.date(),
    status: z.enum(['sale', 'rent']),
    button: link.optional(),
  });
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchema;
  expect(fieldsFrom('default', json).map((f) => [f.path.join('.'), f.type])).toEqual([
    ['title', 'text'],
    ['area', 'number'],
    ['sold', 'boolean'],
    ['from', 'date'],
    ['status', 'select'],
    ['button', 'link'],
  ]);
});

test('a link field refuses a target that would run code', () => {
  const parsed = link.safeParse({ type: 'url', href: 'javascript:alert(1)' });
  expect(parsed.success).toBe(false);
  expect(parsed.error?.issues[0]?.message).toBe('javascript: links are not allowed');
  expect(link.safeParse({ type: 'url', href: 'mailto:hello@example.com' }).success).toBe(true);
});

// The canonical box took any string: a `javascript:` one would have gone into a <link> tag.
test('a seo canonical refuses a target that would run code', () => {
  const parsed = seo.safeParse({ canonical: 'javascript:alert(1)' });
  expect(parsed.success).toBe(false);
  expect(parsed.error?.issues[0]?.message).toBe('javascript: links are not allowed');
  expect(seo.safeParse({ canonical: 'https://example.com/about/' }).success).toBe(true);
});

test('link accepts url and ref shapes and rejects a mismatched pair', () => {
  expect(link.safeParse({ type: 'url', href: '/contact', newTab: true }).success).toBe(true);
  expect(link.safeParse({ type: 'page', ref: 'pages/impressum' }).success).toBe(true);
  expect(link.safeParse({ type: 'url', ref: 'pages/impressum' }).success).toBe(false);
});

test('the structured field types are detected from real Zod output', () => {
  const schema = z.object({
    hero: image({ ratio: '16:9', max: 2400, min: 1600 }),
    brochure: file().optional(),
    video: embed,
    seo: seo.optional(),
    agent: reference('agents'),
  });
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchema;
  expect(fieldsFrom('default', json)).toEqual([
    {
      path: ['hero'],
      label: 'Hero',
      type: 'image',
      required: true,
      preset: { ratio: '16:9', max: 2400, min: 1600 },
    },
    {
      path: ['brochure'],
      label: 'Brochure',
      type: 'file',
      required: false,
      accept: ['application/pdf'],
    },
    { path: ['video'], label: 'Video', type: 'embed', required: true },
    { path: ['seo'], label: 'Seo', type: 'seo', required: false },
    { path: ['agent'], label: 'Agent', type: 'reference', required: true, collection: 'agents' },
  ]);
});

test('image and file take media keys, never URLs', () => {
  const hero = { src: 'media/9f3a2c7e.webp', width: 2400, height: 1600 };
  expect(image().safeParse(hero).success).toBe(true);
  expect(image().safeParse({ ...hero, src: 'https://cdn.example.com/9f3a.webp' }).success).toBe(
    false,
  );
  const doc = {
    src: 'files/3e8a1b9c.pdf',
    name: 'Brochure.pdf',
    bytes: 1,
    mime: 'application/pdf',
  };
  expect(file().safeParse(doc).success).toBe(true);
  // The name is the translatable half, so a language yet to type one still has a valid file.
  expect(file().safeParse({ ...doc, name: undefined }).success).toBe(true);
  expect(file().safeParse({ ...doc, src: 'media/3e8a1b9c.pdf' }).success).toBe(false);
});

test('embed takes an allow-listed provider and rejects raw HTML', () => {
  expect(embed.safeParse({ provider: 'vimeo', id: '76979871', start: 10 }).success).toBe(true);
  expect(embed.safeParse({ provider: 'tiktok', id: '76979871' }).success).toBe(false);
  const iframe = '<iframe src="https://evil.example/x"></iframe>';
  expect(embed.safeParse({ provider: 'youtube', id: iframe }).success).toBe(false);
  expect(embed.safeParse({ provider: 'youtube', id: 'x', html: iframe }).success).toBe(false);
});

test('reference is a collection/slug string', () => {
  expect(reference('agents').safeParse('agents/jane-doe').success).toBe(true);
  expect(reference('agents').safeParse('jane-doe').success).toBe(false);
  expect(reference('agents').safeParse('https://example.com/agents/jane').success).toBe(false);
});

// The 1.5 golden's registry: `columns` holds `blocks` again, so the union is recursive.
const registry: BlockRegistry = {
  hero: defineBlock('hero', { heading: z.string(), image: image().optional() }),
  textSection: defineBlock('textSection', { body: z.string() }),
  cta: defineBlock('cta', { heading: z.string(), button: link }),
  columns: defineBlock('columns', {
    columns: z.array(z.object({ _id: z.string(), blocks: blocks(() => registry) })),
  }),
};
const page = z.object({ title: z.string(), blocks: blocks(() => registry) });

test('the Block type recursion compiles: a page of blocks infers to Block[]', () => {
  expectTypeOf<z.infer<typeof page>['blocks']>().toEqualTypeOf<Block[]>();
});

test('the 1.5 golden parses through the registry, three levels deep', async () => {
  const yaml = await readFile(
    new URL('../../core/test/golden/blocks.yaml', import.meta.url),
    'utf8',
  );
  const data = parseEntry('default', yaml);
  expect(page.safeParse(data).success).toBe(true);
});

test('a block with _ref needs nothing but _type and _id; without it the fields are required', () => {
  const ref = { _type: 'cta', _id: 'q7r8s9t0', _ref: 'globals/cta-newsletter' };
  expect(page.safeParse({ title: 'x', blocks: [ref] }).success).toBe(true);
  expect(page.safeParse({ title: 'x', blocks: [{ _type: 'cta', _id: 'q7r8s9t0' }] }).success).toBe(
    false,
  );
  expect(page.safeParse({ title: 'x', blocks: [{ ...ref, _ref: 'cta-newsletter' }] }).success).toBe(
    false,
  );
});

test('an unregistered block type is rejected', () => {
  expect(
    page.safeParse({ title: 'x', blocks: [{ _type: 'video', _id: 'q7r8s9t0' }] }).success,
  ).toBe(false);
});

test('group, array and blocks are detected from real Zod output', () => {
  const schema = z.object({
    address: z.object({ street: z.string(), town: z.string().optional() }),
    rooms: z.array(z.object({ _id: z.string(), name: z.string(), area: z.number() })),
    tags: z.array(z.string()).optional(),
    blocks: blocks(() => registry),
  });
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchema;
  expect(fieldsFrom('default', json)).toEqual([
    {
      path: ['address'],
      label: 'Address',
      type: 'group',
      required: true,
      fields: [
        { path: ['street'], label: 'Street', type: 'text', required: true },
        { path: ['town'], label: 'Town', type: 'text', required: false },
      ],
    },
    {
      path: ['rooms'],
      label: 'Rooms',
      type: 'array',
      required: true,
      item: [
        { path: ['name'], label: 'Name', type: 'text', required: true },
        { path: ['area'], label: 'Area', type: 'number', required: true },
      ],
    },
    {
      path: ['tags'],
      label: 'Tags',
      type: 'array',
      required: false,
      item: [{ path: [], label: '', type: 'text', required: true }],
    },
    {
      path: ['blocks'],
      label: 'Blocks',
      type: 'blocks',
      required: true,
      types: ['hero', 'textSection', 'cta', 'columns'],
    },
  ]);
});

const EN = { locales: ['en'], defaultLocale: 'en' };

test('a cms.config.ts without an i18n block is refused before the build', () => {
  expect(() => defineConfig({ collections: {} } as Parameters<typeof defineConfig>[0])).toThrow(
    /^cms\.config\.ts › i18n: required/,
  );
});

test('richtext is detected with its tier, basic by default', () => {
  const schema = z.object({ body: richtext('full'), note: richtext().optional() });
  expect(fieldsFrom('default', z.toJSONSchema(schema) as JsonSchema)).toEqual([
    { path: ['body'], label: 'Body', type: 'richtext', required: true, tier: 'full' },
    { path: ['note'], label: 'Note', type: 'richtext', required: false, tier: 'basic' },
  ]);
});

test('richtext rejects a construct outside its tier and names it', () => {
  expect(richtext().safeParse('A **bold** [link](https://x.y).').success).toBe(true);
  expect(richtext('full').safeParse('## Heading\n\n> Quote').success).toBe(true);
  const basic = richtext().safeParse('## Heading');
  expect(basic.success).toBe(false);
  expect(basic.error?.issues[0]?.message).toBe('heading needs richtext: full (line 1)');
  const html = richtext('full').safeParse('<script>alert(1)</script>');
  expect(html.success).toBe(false);
  expect(html.error?.issues[0]?.message).toBe('html is not allowed (line 1)');
});

test('defineConfig fails on a bad route with a message naming the key', () => {
  expect(() =>
    defineConfig({ i18n: EN, collections: { posts: { schema: z.object({}), route: '/blog' } } }),
  ).toThrow(/cms\.config\.ts › collections\.posts\.route: expected a path .*"\/blog"/);
});

test('defineConfig fails when titleField is not a text field of the schema', () => {
  const presenter = z.object({ name: z.string(), bio: richtext() });
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { presenters: { schema: presenter, titleField: 'nmae' } },
    }),
  ).toThrow(
    'cms.config.ts › collections.presenters.titleField: "nmae" is not a text field of this collection\'s schema',
  );
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { presenters: { schema: presenter, titleField: 'bio' } },
    }),
  ).toThrow(/collections\.presenters\.titleField/);
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { presenters: { schema: presenter, titleField: 'name' } },
    }),
  ).not.toThrow();
});

// The site's route reads the field, so a collection without one would fail at the first page.
test('defineConfig fails when localizedSlugs has no optional slug field to read', () => {
  const bare = z.object({ title: z.string() });
  expect(() =>
    defineConfig({ i18n: EN, collections: { pages: { schema: bare, localizedSlugs: true } } }),
  ).toThrow(
    'cms.config.ts › collections.pages.localizedSlugs: this collection\'s schema has no optional "slug" text field — add slug: z.string().optional() to it, since the site\'s own route reads it',
  );
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { pages: { schema: z.object({ slug: z.string() }), localizedSlugs: true } },
    }),
  ).toThrow(/"slug" is required in this collection's schema/);
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: {
        pages: {
          schema: z.object({ slug: z.string().optional() }),
          route: '/[slug]',
          localizedSlugs: true,
        },
      },
    }),
  ).not.toThrow();
  // Nothing renders the collection, so an address is a segment of nothing.
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: {
        pages: { schema: z.object({ slug: z.string().optional() }), localizedSlugs: true },
      },
    }),
  ).toThrow(/has no route, so an address has nothing to be a segment of/);
  // Without the flag a `slug` is an ordinary field and nothing is asked of it.
  expect(() => defineConfig({ i18n: EN, collections: { pages: { schema: bare } } })).not.toThrow();
});

test('defineConfig returns a valid config unchanged', () => {
  const config = {
    i18n: EN,
    collections: { posts: { schema: z.object({}), route: '/blog/[slug]', index: '/blog' } },
  };
  expect(defineConfig(config)).toBe(config);
});

const golden = (name: string) =>
  readFile(new URL(`../../core/test/golden/${name}.yaml`, import.meta.url), 'utf8').then((y) =>
    parseEntry('default', y),
  );

test('the navigation golden parses: menus[].items[] nest through children', async () => {
  const result = navigation.safeParse(await golden('navigation'));
  expect(result.success).toBe(true);
  expect(result.data?.menus[0]?.items[0]?.children?.[0]?.label).toBe('For sale');
});

test('the navigation global is one menus field: the walker stops at the shape it owns', () => {
  const { fields } = formOf('default', formSchema(navigation));
  expect(fields).toEqual([
    { path: ['menus'], label: 'Menus', type: 'menus', required: true, i18n: 'duplicate' },
  ]);
});

// Labels are per language, so a row reaches a language before anybody typed its word for it.
test('an item synced into another language before it is translated is a valid file', () => {
  const form = formOf('default', formSchema(navigation));
  const en = {
    menus: [
      {
        _id: '7h2kq9sd',
        key: 'header',
        items: [{ _id: 'a1b2c3d4', label: 'Listings', link: { type: 'url', href: '/listings' } }],
      },
    ],
  };

  const de = syncLocale('default', form, 'de', { before: { menus: [] }, after: en }, {});

  expect(de.menus).toEqual([
    {
      _id: '7h2kq9sd',
      key: 'header',
      items: [{ _id: 'a1b2c3d4', link: { type: 'url', href: '/listings' } }],
    },
  ]);
  const parsed = navigation.safeParse(de);
  expect(parsed.success).toBe(true);
  expect(parsed.data?.menus[0]?.items[0]?.label).toBe('');
});

// The form is JSON on its way to the browser, and a cycle in it has no end.
test('the form a browser is handed carries no cycle', () => {
  expect(() => JSON.stringify(formOf('default', formSchema(navigation)))).not.toThrow();
});

test('a menu item link is a bare target: no label or newTab inside it', () => {
  const item = { _id: 'a1b2c3d4', label: 'Listings', link: { type: 'url', href: '/listings' } };
  const menu = (i: unknown) => ({ menus: [{ _id: '7h2kq9sd', key: 'header', items: [i] }] });
  expect(navigation.safeParse(menu(item)).success).toBe(true);
  expect(
    navigation.safeParse(menu({ ...item, link: { ...item.link, newTab: true } })).success,
  ).toBe(false);
  expect(navigation.safeParse(menu({ ...item, link: { type: 'entry', href: '/x' } })).success).toBe(
    false,
  );
  // A menu item is the most-clicked link on a site; it takes the same targets as any other.
  expect(
    navigation.safeParse(menu({ ...item, link: { type: 'url', href: 'javascript:alert(1)' } }))
      .success,
  ).toBe(false);
});

test('the redirects golden parses; from must be a path and to a path or absolute URL', async () => {
  expect(redirects.safeParse(await golden('redirects')).success).toBe(true);
  const rule = {
    _id: 'aaaaaaaa',
    from: '/old',
    to: '/new',
    status: 301,
    reason: 'manual',
    createdAt: '2026-01-01T00:00:00Z',
  };
  const file = (r: unknown) => redirects.safeParse({ rules: [r] }).success;
  expect(file(rule)).toBe(true);
  expect(file({ ...rule, to: 'https://example.com/new' })).toBe(true);
  expect(file({ ...rule, from: 'https://example.com/old' })).toBe(false);
  expect(file({ ...rule, from: 'old' })).toBe(false);
  expect(file({ ...rule, to: 'new' })).toBe(false);
  // 302 is the manual rule's "just for now"; nothing else is a code this format has.
  expect(file({ ...rule, status: 302 })).toBe(true);
  expect(file({ ...rule, status: 307 })).toBe(false);
  expect(file({ ...rule, reason: 'moved' })).toBe(false);
  for (const value of ['/old\n/shadow', '/old\r/shadow', '/old\t/shadow', '/old shadow']) {
    expect(file({ ...rule, from: value })).toBe(false);
    expect(file({ ...rule, to: value })).toBe(false);
  }
});

test('formSchema maps z.date() to a date field and a transform to its input type', () => {
  const schema = z.object({
    when: z.date(),
    slug: z.string().transform((s) => s.toLowerCase()),
    tag: z.custom<string>(() => true).meta({ handover: 'text' }),
  });
  expect(fieldsFrom('default', formSchema(schema))).toEqual([
    { path: ['when'], label: 'When', type: 'date', required: true },
    { path: ['slug'], label: 'Slug', type: 'text', required: true },
    { path: ['tag'], label: 'Tag', type: 'text', required: true },
  ]);
});

test('a label names the field, on a plain type and on top of a helper', () => {
  const schema = z.object({
    availableFrom: z.iso.date(),
    seo: seo.meta({ label: 'SEO' }).optional(),
  });
  expect(fieldsFrom('default', formSchema(schema)).map((f) => [f.type, f.label])).toEqual([
    ['date', 'Available from'],
    ['seo', 'SEO'],
  ]);
});

// A full demo-shaped schema carries no unsupported marker.
test('the demo schema produces a full descriptor tree', () => {
  const hero = defineBlock('hero', {
    heading: z.string(),
    image: image({ ratio: '16:9', max: 2400 }).optional(),
  });
  const textSection = defineBlock('textSection', { body: z.string() });
  const cta = defineBlock('cta', { heading: z.string(), button: link });
  const columns = defineBlock('columns', {
    columns: z.array(z.object({ _id: z.string(), blocks: blocks(() => registry) })),
  });
  const registry: BlockRegistry = { hero, textSection, cta, columns };
  const page = z.object({ title: z.string(), blocks: blocks(() => registry) });
  const listing = z.object({
    slug: z.string().optional(),
    title: z.string(),
    location: z.string(),
    price: z.string(),
    summary: z.string(),
    photo: image({ ratio: '3:2', max: 2400, min: 1200 }).optional(),
    brochure: file().optional(),
    phone: z.string().optional().meta({ i18n: 'duplicate' }),
    internalNote: z.string().optional().meta({ i18n: false }),
  });
  const form = {
    listings: formOf('default', formSchema(listing)),
    pages: formOf('default', formSchema(page)),
  };
  expect(JSON.stringify(form)).not.toContain('unsupported');
});

test('a field says how it translates through .meta({ i18n })', () => {
  const schema = z.object({
    title: z.string(),
    price: z.number().meta({ i18n: 'duplicate' }),
    notes: z.string().optional().meta({ i18n: false }),
    hero: image({ ratio: '16:9' }).meta({ i18n: 'duplicate' }).optional(),
  });
  expect(fieldsFrom('default', formSchema(schema)).map((f) => [f.path[0], f.i18n])).toEqual([
    ['title', undefined],
    ['price', 'duplicate'],
    ['notes', false],
    ['hero', 'duplicate'],
  ]);
});

// `mailer()` took an unknown provider for resend, so a typo was told RESEND_API_KEY was missing.
test('defineConfig fails when mailer.provider names no provider', () => {
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { posts: { schema: z.object({}) } },
      mailer: { provider: 'sendgrid', from: 'Site <hi@example.com>' } as never,
    }),
  ).toThrow(
    'cms.config.ts › mailer.provider: "sendgrid" is not one of the providers — resend, smtp, cloudflare',
  );
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { posts: { schema: z.object({}) } },
      mailer: { provider: 'smtp', from: 'Site <hi@example.com>', host: 'smtp.example.com' },
    }),
  ).not.toThrow();
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { posts: { schema: z.object({}) } },
      mailer: async () => ({ id: '1' }),
    }),
  ).not.toThrow();
});

// A language code the admin does not have would fall back to English with nothing saying why.
test('defineConfig fails when a collection label names no interface language', () => {
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: {
        posts: { schema: z.object({}), label: { en: 'posts', ger: 'Beiträge' } as never },
      },
    }),
  ).toThrow('cms.config.ts › collections.posts.label: "ger" is not an interface language — en, de');
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: {
        posts: {
          schema: z.object({}),
          label: { en: 'posts', de: 'Beiträge' },
          singular: { en: 'post', de: 'Beitrag' },
        },
      },
    }),
  ).not.toThrow();
});

// The key is the address segment: a capital or a space would be a link nothing reaches.
test('defineConfig fails when a screen key is not an address segment', () => {
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: {},
      admin: { screens: { Analytics: { component: './src/admin/A.svelte', label: 'Analytics' } } },
    }),
  ).toThrow(
    'cms.config.ts › admin.screens.Analytics: screen keys are lowercase letters, digits and dashes starting with a letter (it is the address segment under /admin/x/)',
  );
});

test('defineConfig fails when a screen label names no interface language', () => {
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: {},
      admin: {
        screens: {
          analytics: {
            component: './src/admin/A.svelte',
            label: { en: 'Analytics', ger: 'Statistik' } as never,
          },
        },
      },
    }),
  ).toThrow(
    'cms.config.ts › admin.screens.analytics.label: "ger" is not an interface language — en, de',
  );
});

// Roles hide the link; a misspelled one would hide it from everybody with nothing saying why.
test('defineConfig fails when a screen names no role', () => {
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: {},
      admin: {
        screens: {
          analytics: {
            component: './src/admin/A.svelte',
            label: 'Analytics',
            roles: ['admin'] as never,
          },
        },
      },
    }),
  ).toThrow('cms.config.ts › admin.screens.analytics.roles: "admin" is not a role — owner, editor');
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: {},
      admin: {
        screens: {
          analytics: {
            component: './src/admin/A.svelte',
            label: { en: 'Analytics', de: 'Statistik' },
            roles: ['owner'],
          },
        },
      },
    }),
  ).not.toThrow();
});

// A typo in checks.ignore is a check the site thinks it turned off, which nothing else would say.
test('defineConfig fails when checks.ignore names no check', () => {
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { posts: { schema: z.object({}) } },
      checks: { ignore: ['seo-descriptions'] as never },
    }),
  ).toThrow(
    'cms.config.ts › checks.ignore: "seo-descriptions" is not one of the checks — media-missing, source-unresolved, link-target, link-locale, media-archived, image-alt, menu-target, translation-empty, translation-stale, translation-machine, seo-title, seo-description, seo-image',
  );
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { posts: { schema: z.object({}) } },
      checks: { ignore: ['seo-description'] },
    }),
  ).not.toThrow();
});
