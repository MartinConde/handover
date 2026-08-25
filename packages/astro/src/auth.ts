import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import {
  type Auth,
  cloudflareMailer,
  createAuth as create,
  type Db,
  type EmailSender,
  type Mailer,
  openDb,
  type Role,
  resendMailer,
  senderAddress,
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
 * SMTP behind the same interface, and the one implementation that cannot live in `core`:
 * `worker-mailer` imports `cloudflare:sockets` at module scope, which does not resolve under
 * Node — so a static import here would stop this package's own test files loading, and would
 * break the CLI's Node-side resolution of the schema through `core`. The import is inside the
 * send, so nothing pays for it until a message is actually sent.
 *
 * TLS is implicit and not negotiated. `worker-mailer` will otherwise `STARTTLS` only if the
 * server offers it and carry on in plaintext if it does not, which sends the password in the
 * clear; 465 is what Resend and Cloudflare both speak, so the branch is not worth having.
 */
function smtpMailer(host: string, port: number, user: string, pass: string, from: string): Mailer {
  return async ({ to, subject, text, html }) => {
    const { LogLevel, WorkerMailer } = await import('worker-mailer');
    await WorkerMailer.send(
      {
        host,
        port,
        secure: true,
        startTls: false,
        credentials: { username: user, password: pass },
        // Empty by default, and an empty list is refused by every server that advertises AUTH
        // with `No supported auth method found.` — read out of `worker-mailer@1.2.1`'s own
        // `auth()`, not from its README.
        authType: ['plain', 'login'],
        // Nothing about the session reaches the Worker's log: its debug level prints the
        // `AUTH PLAIN` payload, which is the password in base64.
        logLevel: LogLevel.NONE,
      },
      {
        to,
        from: senderAddress('default', from),
        subject,
        text,
        ...(html ? { html } : {}),
      },
    ).catch((err: unknown) => {
      // The server's own line, and the host it came from — `Socket timeout!` on its own tells
      // the person reading the settings screen nothing. Neither half is a credential.
      throw new Error(`${host} did not take the message: ${(err as Error).message}`);
    });
    // SMTP hands back no identifier a person can look a message up by, so the check reports none.
    return {};
  };
}

/**
 * Who sends a message: the site's own function, or the provider it named on the credential the
 * Worker holds. Neither is an ordinary state of a site — a site with no mailer is offered no
 * test email and no sign-in link at all — so it is asked for where it is needed rather than
 * resolved on the way. It lives here rather than beside its first caller because the login
 * needs it too, and `routes/api.ts` already imports this file.
 *
 * A provider named with its credential missing is the same answer as no mailer at all, which is
 * what keeps the login from drawing a button that cannot work.
 */
export function mailer(): Mailer | undefined {
  const configured = config.mailer;
  if (!configured) return undefined;
  if (typeof configured === 'function') return configured;
  const e = env as Record<string, string | undefined>;
  if (configured.provider === 'smtp') {
    return e.SMTP_USER && e.SMTP_PASS
      ? smtpMailer(
          configured.host,
          configured.port ?? 465,
          e.SMTP_USER,
          e.SMTP_PASS,
          configured.from,
        )
      : undefined;
  }
  if (configured.provider === 'cloudflare') {
    const binding = (env as { EMAIL?: EmailSender }).EMAIL;
    return binding ? cloudflareMailer('default', binding, configured.from) : undefined;
  }
  if (configured.provider === 'resend')
    return e.RESEND_API_KEY
      ? resendMailer('default', e.RESEND_API_KEY, configured.from)
      : undefined;
  return undefined;
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
export function createAuth(url: URL, ctx?: CloudflareContext, options?: { invite?: true }): Auth {
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
          sendMagicLink: options?.invite
            ? inviteLink(db, send, base ?? url.origin)
            : signInLink(db, send),
          ...(options?.invite ? { magicLinkMinutes: INVITE_HOURS * 60 } : {}),
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

/**
 * How long the link in an invite lives. A sign-in link is clicked in the minute it was asked
 * for and gets fifteen; an invite is read in the evening, so fifteen minutes would make the
 * link in it a lie more often than not. Nothing else about it is different — still one use,
 * still stored as a hash — and the `verification` row carries its own expiry, so the ordinary
 * instance verifies a link this one minted.
 */
const INVITE_HOURS = 72;

/**
 * The same one-time link, said differently: the person opening it has never heard of this
 * site and needs to know why the mail arrived and what to do next. It goes to the account
 * page rather than the dashboard, because the first thing they want is a password.
 */
const inviteLink =
  (db: Db, send: Mailer, site: string) =>
  async ({ email, url }: { email: string; url: string }) => {
    if (!(await userExists(db, email))) return;
    await send({
      to: email,
      subject: 'You have been invited',
      text: `You have been invited to help run ${site}.\n\nOpen this link to sign in as ${email}. It works once and expires in three days; once you are in, your account page offers you a password so the next time needs no link.\n\n${url}\n\nIf you were not expecting this, ignore it — nobody can sign in without opening the link.`,
    });
  };
