import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import {
  type Auth,
  createAuth as create,
  type Db,
  type Mailer,
  openDb,
  type Role,
  resendMailer,
  userExists,
} from '@handover/core';

/**
 * The Cloudflare execution context, named here rather than pulled in from `workers-types`:
 * `waitUntil` is the whole of what this package asks of it.
 */
export interface CloudflareContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** What the middleware hands a handler. Handlers assert on the role; none re-derives it. */
export interface Session {
  user: { id: string; name: string; email: string };
  role: Role;
  /** Which of this person's sessions is asking — the account page marks it "this device". */
  sessionId: string;
}

/**
 * Who sends a message: the site's own function, or the provider it named on the key the
 * Worker holds. Neither is an ordinary state of a site — a site with no mailer is offered no
 * test email and no sign-in link at all — so it is asked for where it is needed rather than
 * resolved on the way. It lives here rather than beside its first caller because the login
 * needs it too, and `routes/api.ts` already imports this file.
 */
export function mailer(): Mailer | undefined {
  const configured = config.mailer;
  if (typeof configured === 'function') return configured;
  const key = (env as Record<string, string | undefined>).RESEND_API_KEY;
  return configured && key ? resendMailer('default', key, configured.from) : undefined;
}

/**
 * The site's own origin, and the one thing about the login that cannot be read off the
 * request: it is what an emailed sign-in link points at, so a forged `Host` would mail a
 * working credential to somewhere else. Absent, the methods that put a URL in an email are
 * not offered — the same answer this file gives to a missing key.
 */
function baseUrl(): string | undefined {
  const raw = (env as { HANDOVER_BASE_URL?: string }).HANDOVER_BASE_URL;
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`HANDOVER_BASE_URL is not a URL: ${raw}`);
  }
}

/**
 * Which ways in this site actually has. It reads the same three values `createAuth` mounts
 * from, so the login cannot offer a button that answers `404` — a site with a mailer but no
 * base URL has no emailed link, and neither does one with a base URL and no mailer.
 */
export function loginMethods(): { emailLink: boolean; github: boolean } {
  const e = env as Record<string, string | undefined>;
  const base = Boolean(baseUrl());
  return {
    emailLink: base && Boolean(mailer()),
    github: base && Boolean(e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET),
  };
}

/**
 * One instance per request and never one at module scope: D1 bindings are per-request, and a
 * singleton fighting a per-request instance over the lock is the 33-second `wrangler dev` hang.
 * `ctx` is the Cloudflare execution context off `Astro.locals.cfContext`; without one the
 * email is sent before the response rather than after it.
 */
export function createAuth(url: URL, ctx?: CloudflareContext): Auth {
  const secret = (env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'BETTER_AUTH_SECRET is not set: run `wrangler secret put BETTER_AUTH_SECRET` (or add it to .dev.vars)',
    );
  }
  const e = env as Record<string, string | undefined>;
  const db = openDb('default', (env as { DB?: Parameters<typeof openDb>[1] }).DB);
  const base = baseUrl();
  const send = mailer();
  return create(db, {
    secret,
    baseURL: base,
    // The same string the cookie's `Secure` is decided from, so the two cannot disagree about
    // one request. With no base URL set this is still the request's own scheme, which is what
    // a cookie is scoped to anyway.
    secureCookies: (base ?? url.origin).startsWith('https:'),
    ...(e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET
      ? { github: { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET } }
      : {}),
    ...(send
      ? {
          sendMagicLink: signInLink(db, send),
          sendPasswordReset: ({ email, url: link }) =>
            send({
              to: email,
              subject: 'Set a new password',
              text: `Open this link to choose a new password for ${email}. It works once and expires in an hour.\n\n${link}\n\nIf you did not ask for this, ignore it — nothing has changed.`,
            }).then(() => undefined),
        }
      : {}),
    // Handed straight over: Better Auth has already attached its own `.catch` by the time this
    // is called, so a send that fails is `Failed to run background task` in the Worker's log
    // and nowhere a person can see — the response was sent before it was tried. The message it
    // logs is the provider's refusal, which carries no address and no link.
    ...(ctx ? { background: (promise) => ctx.waitUntil(promise) } : {}),
  });
}

/**
 * `/sign-in/magic-link` answers the same for every address — which is what keeps it from
 * confirming who has an account — and mails one regardless. Sending only to an address that
 * has a row is what stops an unauthenticated endpoint from being a way to mail strangers.
 */
const signInLink =
  (db: Db, send: Mailer) =>
  async ({ email, url }: { email: string; url: string }) => {
    if (!(await userExists(db, email))) return;
    await send({
      to: email,
      subject: 'Your sign-in link',
      text: `Open this link to sign in as ${email}. It works once and expires in 15 minutes.\n\n${url}\n\nIf you did not ask for it, ignore it — nobody can sign in without opening the link.`,
    });
  };
