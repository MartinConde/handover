import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import {
  type Auth,
  cloudflareMailer,
  createAuth as create,
  type Db,
  type EmailSender,
  logActivity,
  type Mailer,
  openDb,
  type Role,
  resendMailer,
  senderAddress,
  userExists,
} from '@handover/core';

/** Named here rather than from `workers-types`: `waitUntil` is all this package asks of it. */
export interface CloudflareContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Handlers receive this shape after middleware verifies the session. */
export interface Session {
  user: { id: string; name: string; email: string };
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
  return create('default', db, {
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
            ? inviteLink(db, send, base ?? url.origin)
            : signInLink(db, send),
          ...(options?.invite ? { magicLinkMinutes: INVITE_HOURS * 60 } : {}),
          sendPasswordReset: ({ email, url: link }) =>
            send({
              to: email,
              subject: 'Set a new password',
              text: `Open this link to choose a new password for ${email}. It works once and expires in an hour.\n\n${link}\n\nIf you did not ask for this, ignore it — nothing has changed.`,
            })
              .catch(mailFailed(db, 'password reset'))
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
  (db: Db, send: Mailer) =>
  async ({ email, url }: { email: string; url: string }) => {
    if (!(await userExists('default', db, email))) return;
    await send({
      to: email,
      subject: 'Your sign-in link',
      text: `Open this link to sign in as ${email}. It works once and expires in 15 minutes.\n\n${url}\n\nIf you did not ask for it, ignore it — nobody can sign in without opening the link.`,
    }).catch(mailFailed(db, 'sign-in link'));
  };

/** An invite is read in the evening, so a sign-in link's fifteen minutes would often be a lie. */
const INVITE_HOURS = 72;

/** Said for somebody who has never heard of the site; it lands on the account page. */
const inviteLink =
  (db: Db, send: Mailer, site: string) =>
  async ({ email, url }: { email: string; url: string }) => {
    if (!(await userExists('default', db, email))) return;
    await send({
      to: email,
      subject: 'You have been invited',
      text: `You have been invited to help run ${site}.\n\nOpen this link to sign in as ${email}. It works once and expires in three days; once you are in, your account page offers you a password so the next time needs no link.\n\n${url}\n\nIf you were not expecting this, ignore it — nobody can sign in without opening the link.`,
    }).catch(mailFailed(db, 'invite'));
  };
