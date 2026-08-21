import type { APIContext } from 'astro';
import { expect, test, vi } from 'vitest';
import { onRequest } from './middleware.js';

vi.mock('cloudflare:workers', () => ({ env: { ADMIN_PASSWORD: 'hunter2' } }));

async function run(path: string, headers: Record<string, string> = {}) {
  const url = new URL(path, 'https://x');
  const next = vi.fn(async () => new Response('next'));
  const res = (await onRequest(
    { request: new Request(url, { headers }), url } as unknown as APIContext,
    next,
  )) as Response;
  return { status: res.status, passed: next.mock.calls.length === 1 };
}

test('unauthenticated API calls are 401', async () => {
  expect(await run('/admin/api/ping')).toEqual({ status: 401, passed: false });
});

test('authenticated API calls pass through', async () => {
  expect(await run('/admin/api/ping', { authorization: 'Bearer hunter2' })).toEqual({
    status: 200,
    passed: true,
  });
});

test('the login endpoint, the shell and the public site are not gated', async () => {
  for (const path of ['/admin/api/login', '/admin', '/admin/_assets/main-x.js', '/listings/a']) {
    expect(await run(path), path).toEqual({ status: 200, passed: true });
  }
});
