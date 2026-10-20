import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import {
  type Auth,
  accountLocale,
  cloudflareMailer,
  createAuth as create,
  type Db,
  type EmailSender,
  logActivity,
  type Mailer,
  type Role,
  resendMailer,
  senderAddress,
  type UiLocale,
} from '@handover/core';
import { db } from './environment.js';
import { mailText, requestLocale } from './mail-text.js';

/** Named here rather than from `workers-types`: `waitUntil` is all this package asks of it. */
export interface CloudflareContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Handlers receive this shape after middleware verifies the session. */
export interface Session {
  user: { id: string; name: string; email: string; uiLocale: UiLocale | null };
  role: Role;
  /** Which of this person's sessions is asking — the account page marks it "this device". */
  sessionId: string;
}

/** `worker-mailer` imports `cloudflare:sockets` at module scope, hence the import in the send. */
function smtpMailer(host: string, port: number, user: string, pass: string, from: string): Mailer {
  return async ({ to, subject, text, html }) => {
    const { LogLevel, WorkerMailer } = await import('worker-mailer');
    await WorkerMailer.send(
      {
        host,
        port,
        secure: true,
        // Never STARTTLS: it falls back to plaintext where the server does not offer it.
        startTls: false,
        credentials: { username: user, password: pass },
        // Empty by default, and `worker-mailer@1.2.1`'s own `auth()` refuses an empty list.
        authType: ['plain', 'login'],
        // Its debug level prints the `AUTH PLAIN` payload, which is the password in base64.
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
      // `Socket timeout!` alone tells the settings screen nothing; neither half is a credential.
      throw new Error(`${host} did not take the message: ${(err as Error).message}`);
    });
    // SMTP hands back no identifier a person can look a message up by, so the check reports none.
    return {};
  };
}

/** A provider with its credential missing is no mailer, so the login draws no button for it. */
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

/** Never read off the request: a forged `Host` would mail a working sign-in link elsewhere. */
function baseUrl(): string | undefined {
  const raw = (env as { HANDOVER_BASE_URL?: string }).HANDOVER_BASE_URL;
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`HANDOVER_BASE_URL is not a URL: ${raw}`);
  }
}

/** Reads the same values `createAuth` mounts from, so the login offers no button that 404s. */
export function loginMethods(): { emailLink: boolean; github: boolean } {
  const e = env as Record<string, string | undefined>;
  const base = Boolean(baseUrl());
  return {
    emailLink: base && Boolean(mailer()),
    github: base && Boolean(e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET),
  };
}

/** Never a singleton: D1 bindings are per-request and the lock fight is the 33-second dev hang. */
export function createAuth(
  url: URL,
  ctx?: CloudflareContext,
  // `locale` is the inviting owner's; `request` carries the device hint of whoever triggers a mail.
  options?: { invite?: true; locale?: UiLocale; request?: Request },
): Auth {
  const secret = (env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'BETTER_AUTH_SECRET is not set: run `wrangler secret put BETTER_AUTH_SECRET` (or add it to .dev.vars)',
    );
  }
  const e = env as Record<string, string | undefined>;
  const database = db();
  const base = baseUrl();
  const send = mailer();
  // A saved interface language wins; otherwise the hint from the request that triggers the mail.
  const hint = options?.locale ?? requestLocale(options?.request);
  const languageOf = async (email: string) => (await accountLocale(database, email)) ?? hint;
  return create('default', database, {
    secret,
    baseURL: base,
    basePath: `${(config.i18n.base ?? '').replace(/\/+$/, '')}/admin/api/auth`,
    // Decided from the same string as the cookie, so the two cannot disagree about one request.
    secureCookies: (base ?? url.origin).startsWith('https:'),
    ...(e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET
      ? { github: { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET } }
      : {}),
    ...(send
      ? {
          sendMagicLink: options?.invite
            ? inviteLink(database, send, base ?? url.origin, hint)
            : signInLink(database, send, hint, ctx),
          ...(options?.invite ? { magicLinkMinutes: INVITE_HOURS * 60 } : {}),
          sendPasswordReset: async ({ email, url: link }) =>
            send({ to: email, ...mailText(await languageOf(email)).reset(email, link) })
              .catch(mailFailed(database, 'password reset'))
              .then(() => undefined),
          sendEmailChangeApproval: async ({ email, newEmail, url: link }) =>
            send({
              to: email,
              ...mailText(await languageOf(email)).approve(email, link, newEmail),
            })
              .catch(mailFailed(database, 'email change approval'))
              .then(() => undefined),
          sendEmailChangeLink: async ({ email, url: link }) =>
            send({ to: email, ...mailText(await languageOf(email)).confirm(email, link) })
              .catch(mailFailed(database, 'email change link'))
              .then(() => undefined),
        }
      : {}),
    // Better Auth already attached its `.catch`, so a failed send is only a Worker log line.
    ...(ctx ? { background: (promise) => ctx.waitUntil(promise) } : {}),
  });
}

/** Names what the message was for and nothing else: never the address, never the link. */
const mailFailed = (db: Db, what: string) => async (err: unknown) => {
  await logActivity('default', db, { kind: 'mail-failed', detail: { message: what } });
  throw err;
};

/** The endpoint mails regardless; sending only to a known address stops it mailing strangers. */
const signInLink =
  (db: Db, send: Mailer, hint: UiLocale | undefined, ctx?: CloudflareContext) =>
  async ({ email, url }: { email: string; url: string }) => {
    // After the answer, lookup included: a member's address must answer like a stranger's.
    const task = (async () => {
      const saved = await accountLocale(db, email);
      if (saved === undefined) return;
      await send({ to: email, ...mailText(saved ?? hint).signIn(email, url) }).catch(
        mailFailed(db, 'sign-in link'),
      );
    })().catch((err: unknown) => console.error(`Sign-in link not sent: ${(err as Error).message}`));
    if (ctx) ctx.waitUntil(task);
    else await task;
  };

/** An invite is read in the evening, so a sign-in link's fifteen minutes would often be a lie. */
const INVITE_HOURS = 72;

/** Said for somebody who has never heard of the site; it lands on the account page. */
const inviteLink =
  (db: Db, send: Mailer, site: string, hint: UiLocale | undefined) =>
  async ({ email, url }: { email: string; url: string }) => {
    const saved = await accountLocale(db, email);
    if (saved === undefined) return;
    await send({ to: email, ...mailText(saved ?? hint).invite(email, url, site) }).catch(
      mailFailed(db, 'invite'),
    );
  };
