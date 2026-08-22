import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fieldsFrom, type JsonSchema } from '@handover/core';
import type { HookParameters } from 'astro';
import { z } from 'astro/zod';
import { expect, test, vi } from 'vitest';
import handover, { link, NO_ADAPTER_MESSAGE, uiAssetsModule } from './index.js';

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
