import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fieldsFrom, type JsonSchema, parseEntry } from '@handover/core';
import type { HookParameters } from 'astro';
import { z } from 'astro/zod';
import { expect, expectTypeOf, test, vi } from 'vitest';
import handover, {
  type Block,
  type BlockRegistry,
  blocks,
  defineBlock,
  embed,
  file,
  image,
  link,
  NO_ADAPTER_MESSAGE,
  reference,
  seo,
  uiAssetsModule,
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

test('link accepts url and ref shapes and rejects a mismatched pair', () => {
  expect(link.safeParse({ type: 'url', href: '/contact', newTab: true }).success).toBe(true);
  expect(link.safeParse({ type: 'page', ref: 'pages/impressum' }).success).toBe(true);
  expect(link.safeParse({ type: 'url', ref: 'pages/impressum' }).success).toBe(false);
});

test('the structured field types are detected from real Zod output', () => {
  const schema = z.object({
    hero: image,
    brochure: file.optional(),
    video: embed,
    seo: seo.optional(),
    agent: reference('agents'),
  });
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchema;
  expect(fieldsFrom('default', json)).toEqual([
    { path: ['hero'], type: 'image', required: true },
    { path: ['brochure'], type: 'file', required: false },
    { path: ['video'], type: 'embed', required: true },
    { path: ['seo'], type: 'seo', required: false },
    { path: ['agent'], type: 'reference', required: true, collection: 'agents' },
  ]);
});

test('image and file take media keys, never URLs', () => {
  const hero = { src: 'media/9f3a2c7e.webp', width: 2400, height: 1600 };
  expect(image.safeParse(hero).success).toBe(true);
  expect(image.safeParse({ ...hero, src: 'https://cdn.example.com/9f3a.webp' }).success).toBe(
    false,
  );
  const doc = {
    src: 'files/3e8a1b9c.pdf',
    name: 'Brochure.pdf',
    bytes: 1,
    mime: 'application/pdf',
  };
  expect(file.safeParse(doc).success).toBe(true);
  expect(file.safeParse({ ...doc, src: 'media/3e8a1b9c.pdf' }).success).toBe(false);
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
  hero: defineBlock('hero', { heading: z.string(), image: image.optional() }),
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
    { path: ['address', 'street'], type: 'text', required: true },
    { path: ['address', 'town'], type: 'text', required: false },
    {
      path: ['rooms'],
      type: 'array',
      required: true,
      item: [
        { path: ['name'], type: 'text', required: true },
        { path: ['area'], type: 'number', required: true },
      ],
    },
    {
      path: ['tags'],
      type: 'array',
      required: false,
      item: [{ path: [], type: 'text', required: true }],
    },
    {
      path: ['blocks'],
      type: 'blocks',
      required: true,
      types: ['hero', 'textSection', 'cta', 'columns'],
    },
  ]);
});

type Setup = HookParameters<'astro:config:setup'>;

function runSetup(adapter: unknown) {
  const info = vi.fn();
  const injectRoute = vi.fn();
  const addMiddleware = vi.fn();
  const updateConfig = vi.fn();
  const setup = handover().hooks['astro:config:setup'] as (o: Setup) => void;
  setup({
    config: { adapter, root: new URL('file:///site/') },
    logger: { info },
    injectRoute,
    addMiddleware,
    updateConfig,
  } as unknown as Setup);
  return { info, injectRoute, addMiddleware, updateConfig };
}

test('throws the documented message when no adapter is configured', () => {
  expect(() => runSetup(undefined)).toThrow(NO_ADAPTER_MESSAGE);
});

test('logs once an adapter is present', () => {
  const { info } = runSetup({ name: 'fake-adapter', hooks: {} });
  expect(info).toHaveBeenCalledWith('astro-handover integration loaded');
});

test('injects the admin shell and API routes as SSR', () => {
  const { injectRoute } = runSetup({ name: 'fake-adapter', hooks: {} });
  const routes = injectRoute.mock.calls.map(([r]) => [r.pattern, r.prerender]);
  expect(routes).toEqual([
    ['/admin/[...path]', false],
    ['/admin/api/[...path]', false],
  ]);
});

test('registers the password-gate middleware before the routes', () => {
  const { addMiddleware } = runSetup({ name: 'fake-adapter', hooks: {} });
  expect(addMiddleware).toHaveBeenCalledWith({ order: 'pre', entrypoint: expect.any(URL) });
  expect(String(addMiddleware.mock.calls[0]?.[0].entrypoint)).toMatch(/\/middleware\.js$/);
});

test('virtual:handover/config resolves to the root cms.config.ts', () => {
  const { updateConfig } = runSetup({ name: 'fake-adapter', hooks: {} });
  const plugin = updateConfig.mock.calls[0]?.[0].vite.plugins[0];
  expect(plugin.resolveId('virtual:handover/config')).toBe('/site/cms.config.ts');
  expect(plugin.resolveId('something-else')).toBeUndefined();
});

test('virtual:handover/ui inlines every file in dist/ui', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'handover-ui-'));
  await writeFile(join(dir, 'main-abc.js'), 'js();');
  await writeFile(join(dir, 'main-abc.css'), 'b{}');
  const { updateConfig } = runSetup({ name: 'fake-adapter', hooks: {} });
  const plugin = updateConfig.mock.calls[0]?.[0].vite.plugins[1];
  expect(plugin.resolveId('virtual:handover/ui')).toBe('\0virtual:handover/ui');
  expect(plugin.resolveId('other')).toBeUndefined();
  expect(await plugin.load('other')).toBeUndefined();
  expect(await uiAssetsModule(dir)).toBe(
    `export default ${JSON.stringify({ 'main-abc.css': 'b{}', 'main-abc.js': 'js();' })};`,
  );
});
