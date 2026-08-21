import type { APIContext } from 'astro';
import { expect, test, vi } from 'vitest';
import { GET } from './api.js';

vi.mock('virtual:handover/config', () => ({
  default: { collections: { listings: { schema: {} } } },
}));

const ctx = (path: string) => ({ params: { path } }) as unknown as APIContext;

test('ping returns the configured collection names', async () => {
  const res = await GET(ctx('ping'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, collections: ['listings'] });
});

test('unknown paths are 404', async () => {
  expect((await GET(ctx('nope'))).status).toBe(404);
});
