import type { HookParameters } from 'astro';
import { expect, test, vi } from 'vitest';
import handover, { NO_ADAPTER_MESSAGE } from './index.js';

type Setup = HookParameters<'astro:config:setup'>;

function runSetup(adapter: unknown) {
  const info = vi.fn();
  const setup = handover().hooks['astro:config:setup'] as (o: Setup) => void;
  setup({ config: { adapter }, logger: { info } } as unknown as Setup);
  return info;
}

test('throws the documented message when no adapter is configured', () => {
  expect(() => runSetup(undefined)).toThrow(NO_ADAPTER_MESSAGE);
});

test('logs once an adapter is present', () => {
  const info = runSetup({ name: 'fake-adapter', hooks: {} });
  expect(info).toHaveBeenCalledWith('astro-handover integration loaded');
});
