import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookParameters } from 'astro';
import { expect, test, vi } from 'vitest';
import handover, { NO_ADAPTER_MESSAGE, uiAssetsModule } from './index.js';

type Setup = HookParameters<'astro:config:setup'>;

function runSetup(adapter: unknown) {
  const info = vi.fn();
  const injectRoute = vi.fn();
  const updateConfig = vi.fn();
  const setup = handover().hooks['astro:config:setup'] as (o: Setup) => void;
  setup({
    config: { adapter, root: new URL('file:///site/') },
    logger: { info },
    injectRoute,
    updateConfig,
  } as unknown as Setup);
  return { info, injectRoute, updateConfig };
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
