import type { APIContext } from 'astro';
import { beforeEach, expect, test, vi } from 'vitest';
import { onRequest } from './middleware.js';

// The Better Auth instance is the boundary here: what it answers is proven against a real D1
// in core's auth.test.ts, and what this file tests is which requests ever get to ask it.
let session: { user: { id: string; name: string; email: string; role: string | null } } | null =
  null;
const getSession = vi.fn(async () => session);
vi.mock('./auth.js', () => ({ createAuth: () => ({ api: { getSession } }) }));

beforeEach(() => getSession.mockClear());

async function run(path: string) {
  const url = new URL(path, 'https://x');
  const locals: Record<string, unknown> = {};
  const next = vi.fn(async () => new Response('next'));
  const res = (await onRequest(
    { request: new Request(url), url, locals } as unknown as APIContext,
    next,
  )) as Response;
  return { status: res.status, passed: next.mock.calls.length === 1, locals };
}

test('an API call with no session is 401', async () => {
  session = null;
  expect(await run('/admin/api/drafts')).toMatchObject({ status: 401, passed: false });
});

test("the login's own endpoints are reachable without a session", async () => {
  session = null;
  for (const path of ['/admin/api/auth/sign-in/email', '/admin/api/auth/get-session']) {
    expect(await run(path), path).toMatchObject({ status: 200, passed: true });
  }
  expect(getSession).not.toHaveBeenCalled();
});

test('a signed-in call passes through carrying the user and the role', async () => {
  session = { user: { id: 'u1', name: 'Martin', email: 'martin@example.com', role: 'owner' } };
  const { status, passed, locals } = await run('/admin/api/drafts');
  expect({ status, passed }).toEqual({ status: 200, passed: true });
  expect(locals.handover).toEqual({
    user: { id: 'u1', name: 'Martin', email: 'martin@example.com' },
    role: 'owner',
  });
});

test('a session whose row carries no role is an editor', async () => {
  session = { user: { id: 'u2', name: 'Anna', email: 'anna@example.com', role: null } };
  const { locals } = await run('/admin/api/drafts');
  expect((locals.handover as { role: string }).role).toBe('editor');
});

test('the shell and the public site are not gated', async () => {
  session = null;
  for (const path of ['/admin', '/admin/_assets/main-x.js', '/listings/a']) {
    expect(await run(path), path).toMatchObject({ status: 200, passed: true });
  }
});
