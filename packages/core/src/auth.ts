import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { BetterAuthOptions } from 'better-auth/minimal';
import { betterAuth } from 'better-auth/minimal';
import { createAccessControl } from 'better-auth/plugins/access';
import { admin } from 'better-auth/plugins/admin';
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import { magicLink } from 'better-auth/plugins/magic-link';
import { and, desc, eq, gt, isNotNull } from 'drizzle-orm';
import * as authTables from './auth-schema.js';
import type { Db } from './db.js';

/** Where the login's own endpoints are served, and the one path no session assert may cover. */
export const AUTH_BASE_PATH = '/admin/api/auth';

/** How long an emailed sign-in link lives. The login screen says this number out loud. */
const MAGIC_LINK_MINUTES = 15;

// Two roles, one `role` column. The admin plugin refuses an `adminRoles` entry it has no
// role for, so this is what makes `owner` a name rather than a string. What each may do
// inside Handover — publish, upload, change what is editable — is asserted by the route
// handlers; these statements are only the member management the plugin itself gates.
const ac = createAccessControl(defaultStatements);
const roles = { owner: adminAc, editor: userAc };

/**
 * The admin plugin's column, read as one of the two roles. Anything else — an unset column, a
 * name from a later version — is an editor, because the narrower of the two is the safe guess.
 * Better Auth's own session type does not carry plugin columns, so the read is narrowed here
 * rather than cast at each call site.
 */
export type Role = 'owner' | 'editor';
export const roleOf = (user: { id: string; role?: string | null }): Role =>
  user.role === 'owner' ? 'owner' : 'editor';

/** What differs per site; everything else about the login is the package's decision. */
export interface AuthConfig {
  secret: string;
  /**
   * The site's own origin, stated rather than read off the request. Every other option here
   * is a credential; this one is what decides where an emailed credential points, so it may
   * never come from a header. Absent, the emailing methods are not offered at all.
   */
  baseURL?: string;
  /** Absent until the site has GitHub credentials — the provider is not mounted without them. */
  github?: { clientId: string; clientSecret: string };
  /** Sends the link the user clicks; absent until the site has a `Mailer`. */
  sendMagicLink?: (data: { email: string; url: string }) => Promise<void>;
  /** Sends the "set a new password" link; the same `Mailer`, a different message. */
  sendPasswordReset?: (data: { email: string; url: string }) => Promise<void>;
  /**
   * Whether this request arrived over https. Defaults to yes, because the wrong answer in
   * that direction is only an inconvenience on a dev machine, and in the other it is a
   * session cookie a plaintext request can carry.
   */
  secureCookies?: boolean;
  /**
   * Hands a promise to the platform so it outlives the response — `ctx.waitUntil` on Workers.
   * Absent, Better Auth awaits the send inline, which is slower and always correct; a handler
   * that dropped the promise would lose the email with nothing to show for it.
   */
  background?: (promise: Promise<unknown>) => void;
}

/**
 * The options `npx auth generate` reads and the ones the Worker runs — one object, so the
 * tables in `auth-schema.ts` cannot drift from the config that queries them. A method whose
 * credentials the site does not hold is left unmounted rather than mounted and broken, and
 * the two that put a URL in an email also want `baseURL`: without one they would mail a link
 * built from whatever `Host` the request carried.
 */
export function authOptions(db: Db, config: AuthConfig): BetterAuthOptions {
  const emailing = Boolean(config.baseURL);
  const resetting = emailing && config.sendPasswordReset;
  return {
    basePath: AUTH_BASE_PATH,
    baseURL: config.baseURL,
    secret: config.secret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema: { ...authTables } }),
    // Closed on every method separately: forgetting one lets a stranger create a user on a
    // client's admin. The only way in is an invite, which pre-creates the row.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      ...(resetting
        ? {
            sendResetPassword: ({ user, url }) =>
              (config.sendPasswordReset as NonNullable<AuthConfig['sendPasswordReset']>)({
                email: user.email,
                url,
              }),
            // Said rather than inherited, so the hour the docs quote is this file's number.
            resetPasswordTokenExpiresIn: 60 * 60,
            // Somebody resetting a password may be doing it because they lost control of the
            // account; leaving the old sessions signed in would defeat the reset.
            revokeSessionsOnPasswordReset: true,
          }
        : {}),
    },
    ...(emailing && config.github
      ? { socialProviders: { github: { ...config.github, disableSignUp: true } } }
      : {}),
    // GitHub sign-in only succeeds against a row that already carries the same verified
    // email, so linking is what makes closed signup and social login coexist.
    account: { accountLinking: { enabled: true, trustedProviders: ['github'] } },
    // D1 through the same Drizzle adapter, so `/sign-in/email` is rate-limited without KV.
    // `enabled` defaults to `NODE_ENV === 'production'`, which a Worker never sets, so saying
    // it is what turns the limit on at all.
    rateLimit: { enabled: true, storage: 'database' },
    advanced: {
      // Which bucket an attempt is counted against. The default reads `x-forwarded-for`, whose
      // first entry the caller writes — behind Cloudflare that is a limit anyone can walk
      // around by varying a header. `cf-connecting-ip` is written by the edge and cannot be
      // sent in.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // Stated from the same string `baseURL` came from, so the two cannot disagree. Left to
      // Better Auth it falls back through the request's protocol to `NODE_ENV === 'production'`,
      // which a Worker never sets — and the deployed site hands out a cookie with no `Secure`.
      useSecureCookies: config.secureCookies ?? true,
      ...(config.background ? { backgroundTasks: { handler: config.background } } : {}),
    },
    plugins: [
      ...(emailing && config.sendMagicLink
        ? [
            magicLink({
              sendMagicLink: config.sendMagicLink,
              disableSignUp: true,
              expiresIn: MAGIC_LINK_MINUTES * 60,
              // The row in `verification` is then no use to anyone who reads the database:
              // what is stored is a hash of the link that was mailed, not the link.
              storeToken: 'hashed',
            }),
          ]
        : []),
      admin({ ac, roles, adminRoles: ['owner'], defaultRole: 'editor' }),
    ],
  };
}

/** Named so the declaration emit does not have to reach into better-auth's own dist. */
export type Auth = ReturnType<typeof betterAuth<BetterAuthOptions>>;

/**
 * Per request, never at module scope and never both: a singleton and a per-request instance
 * fighting over the D1 lock is the documented 33-second `wrangler dev` hang.
 */
export function createAuth(db: Db, config: AuthConfig): Auth {
  return betterAuth(authOptions(db, config));
}

/** Whether this address has an account at all — what decides if a sign-in link is worth sending. */
export async function userExists(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .select({ id: authTables.user.id })
    .from(authTables.user)
    .where(eq(authTables.user.email, email))
    .limit(1);
  return rows.length > 0;
}

/** One person's own account page: whether they have a password, and where they are signed in. */
export interface AccountFacts {
  hasPassword: boolean;
  sessions: { id: string; current: boolean; userAgent: string | null; lastUsed: number }[];
}

/**
 * Read here rather than through Better Auth's own `/list-sessions`, which needs a session
 * younger than `freshAge` — a signed-in person would be refused their own account page after a
 * day — and which answers with each session's token. Nothing the browser is shown can revoke
 * anything; "sign out everywhere" is one endpoint that needs no id at all.
 */
export async function accountFacts(
  db: Db,
  userId: string,
  currentSessionId: string,
): Promise<AccountFacts> {
  const [credentials, live] = await Promise.all([
    db
      .select({ id: authTables.account.id })
      .from(authTables.account)
      .where(
        and(
          eq(authTables.account.userId, userId),
          eq(authTables.account.providerId, 'credential'),
          isNotNull(authTables.account.password),
        ),
      )
      .limit(1),
    db
      .select({
        id: authTables.session.id,
        userAgent: authTables.session.userAgent,
        updatedAt: authTables.session.updatedAt,
      })
      .from(authTables.session)
      .where(
        and(eq(authTables.session.userId, userId), gt(authTables.session.expiresAt, new Date())),
      )
      .orderBy(desc(authTables.session.updatedAt)),
  ]);
  return {
    hasPassword: credentials.length > 0,
    sessions: live.map((row) => ({
      id: row.id,
      current: row.id === currentSessionId,
      userAgent: row.userAgent,
      lastUsed: row.updatedAt.getTime(),
    })),
  };
}
