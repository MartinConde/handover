import { env } from 'cloudflare:workers';
import { type Auth, createAuth as create, openDb, type Role } from '@handover/core';

/** What the middleware hands a handler. Handlers assert on the role; none re-derives it. */
export interface Session {
  user: { id: string; name: string; email: string };
  role: Role;
}

/**
 * One instance per request and never one at module scope: D1 bindings are per-request, and a
 * singleton fighting a per-request instance over the lock is the 33-second `wrangler dev` hang.
 */
export function createAuth(url: URL): Auth {
  const secret = (env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'BETTER_AUTH_SECRET is not set: run `wrangler secret put BETTER_AUTH_SECRET` (or add it to .dev.vars)',
    );
  }
  return create(openDb('default', (env as { DB?: Parameters<typeof openDb>[1] }).DB), {
    secret,
    secureCookies: url.protocol === 'https:',
  });
}
