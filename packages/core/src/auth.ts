import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { BetterAuthOptions } from 'better-auth/minimal';
import { betterAuth } from 'better-auth/minimal';
import { createAccessControl } from 'better-auth/plugins/access';
import { admin } from 'better-auth/plugins/admin';
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import { magicLink } from 'better-auth/plugins/magic-link';
import { and, desc, eq, exists, gt, isNotNull, max, ne, or, sql } from 'drizzle-orm';
import { logActivity } from './activity.js';
import * as authTables from './auth-schema.js';
import type { Db } from './db.js';
import { activity } from './tables.js';

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
export const roleOf = (_siteId: string, user: { id: string; role?: string | null }): Role =>
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
   * How long an emailed link lives, when 15 minutes is the wrong number. An invite is read
   * hours later; a sign-in link is clicked now. Nothing else about the two differs, and the
   * row that is minted carries its own expiry, so a link made by one instance is verified by
   * the other.
   */
  magicLinkMinutes?: number;
  /**
   * Hands a promise to the platform so it outlives the response — `ctx.waitUntil` on Workers.
   * Absent, Better Auth awaits the send inline, which is slower and always correct; a handler
   * that dropped the promise would lose the email with nothing to show for it.
   */
  background?: (promise: Promise<unknown>) => void;
}

/**
 * Which of the three ways in a session was created by, keyed on the endpoint that created it.
 * Read out of a real instance rather than recalled: `path` is the endpoint's own path and not
 * the mounted URL, and a social callback is the *pattern* with the provider in `params`.
 *
 * A path that is not one of these is deliberately not a login. `/admin/impersonate-user` is
 * the one that matters: it creates a session for somebody who did not sign in, and a row
 * saying they did would be a false record rather than a missing one.
 */
const SIGN_IN_METHOD: Record<string, string> = {
  '/sign-in/email': 'password',
  '/magic-link/verify': 'link',
};

/**
 * The options `npx auth generate` reads and the ones the Worker runs — one object, so the
 * tables in `auth-schema.ts` cannot drift from the config that queries them. A method whose
 * credentials the site does not hold is left unmounted rather than mounted and broken, and
 * the two that put a URL in an email also want `baseURL`: without one they would mail a link
 * built from whatever `Host` the request carried.
 */
export function authOptions(siteId: string, db: Db, config: AuthConfig): BetterAuthOptions {
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
    // Where a failure that cannot route itself lands. An OAuth callback carries where to go
    // back to inside its own state, so when the state is what expired — five minutes is all it
    // gets, and a first trip through GitHub's consent screen can take longer — there is nothing
    // left to read it out of. Without this the person ends on Better Auth's own error page;
    // with it they end on the login, which says the one thing every refusal here says.
    onAPIError: { errorURL: '/admin' },
    advanced: {
      // Which bucket an attempt is counted against. The default reads `x-forwarded-for`, whose
      // first entry the caller writes — behind Cloudflare that is a limit anyone can walk
      // around by varying a header. `cf-connecting-ip` is written by the edge and cannot be
      // sent in.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // The fourth default that reads the environment rather than the config, and the one that
      // makes a test suite prove nothing: `skipOriginCheck` is `isTest()`, so under vitest every
      // `origin` header is waved through while the Worker checks it. Saying it means the two run
      // the same configuration; production is unchanged, since `isTest()` is false there.
      disableOriginCheck: false,
      // Stated from the same string `baseURL` came from, so the two cannot disagree. Left to
      // Better Auth it falls back through the request's protocol to `NODE_ENV === 'production'`,
      // which a Worker never sets — and the deployed site hands out a cookie with no `Secure`.
      useSecureCookies: config.secureCookies ?? true,
      ...(config.background ? { backgroundTasks: { handler: config.background } } : {}),
    },
    // The only seam that sees all three ways in: they are all inside Better Auth's own
    // handler, so there is no route of ours to hang this on. `logActivity` swallows its own
    // failures, and that is load-bearing here — a throw in an after-hook answers `500` with
    // the session row already committed, which is a sign-in that half happened.
    databaseHooks: {
      session: {
        create: {
          after: async (session, context) => {
            const path = context?.path ?? '';
            const method =
              path === '/callback/:id'
                ? String((context?.params as { id?: string } | undefined)?.id ?? '')
                : SIGN_IN_METHOD[path];
            if (!method) return;
            await logActivity(siteId, db, {
              userId: session.userId,
              kind: 'login',
              detail: { method },
            });
          },
        },
      },
    },
    plugins: [
      ...(emailing && config.sendMagicLink
        ? [
            magicLink({
              sendMagicLink: config.sendMagicLink,
              disableSignUp: true,
              expiresIn: (config.magicLinkMinutes ?? MAGIC_LINK_MINUTES) * 60,
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
 * The four endpoints the package drives itself, with the signatures they really have —
 * `createUser` wants a `name` whether or not there is one, `setRole` takes a string *or an
 * array*, and both live on plugins. `Auth` is typed on generic options so the declaration
 * emit stays out of better-auth's dist, and the price of that is that no plugin's endpoints
 * are on it; this is the one place that pays it.
 */
export interface MemberApi {
  createUser(args: {
    body: { email: string; name: string; role: Role };
    headers: Headers;
  }): Promise<{ user: { id: string; email: string } }>;
  signInMagicLink(args: {
    body: { email: string; callbackURL?: string };
    headers: Headers;
  }): Promise<{ status: boolean }>;
  setRole(args: { body: { userId: string; role: Role }; headers: Headers }): Promise<unknown>;
  removeUser(args: { body: { userId: string }; headers: Headers }): Promise<unknown>;
}

/** The endpoints above, off an instance that mounts them. */
export const memberApi = (_siteId: string, auth: Auth): MemberApi =>
  auth.api as unknown as MemberApi;

/**
 * Per request, never at module scope and never both: a singleton and a per-request instance
 * fighting over the D1 lock is the documented 33-second `wrangler dev` hang.
 */
export function createAuth(siteId: string, db: Db, config: AuthConfig): Auth {
  return betterAuth(authOptions(siteId, db, config));
}

/** Whether this address has an account at all — what decides if a sign-in link is worth sending. */
export async function userExists(_siteId: string, db: Db, email: string): Promise<boolean> {
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
  _siteId: string,
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

/** A row on the members screen: who can sign in to this site, and as what. */
export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  /**
   * An invite nobody has opened yet. There is no `invited_at` column and none may be added,
   * so what makes somebody pending is that they have never proved they own the address:
   * `emailVerified` is false and they have neither an account nor a session to show for it.
   * Every way in flips one of the three — a magic link verifies the address outright, GitHub
   * does the same and leaves a row, a password is a row — so the only reading this gets wrong
   * is a member seeded by hand with `email_verified 0` and a password, who signs in happily
   * while the screen calls the invite pending.
   */
  pending: boolean;
  /** How they sign in, and nothing while they are pending, because nobody knows yet. */
  method: 'github' | 'password' | 'link' | null;
  /**
   * When this person last signed in: the newer of their newest session and their newest
   * `login` event. The session alone is a convenience — signing out deletes the row — and the
   * event alone misses everybody who signed in before there was a log, so both are read.
   */
  lastSignIn: number | null;
  invitedAt: number;
}

/**
 * Everyone who can sign in, with the two facts that are computed rather than stored: how
 * each of them gets in, and whether an invite has ever been opened. Four reads and no join,
 * so a site with twenty members costs four round trips rather than twenty-one; the password
 * hash is never one of the columns asked for.
 */
export async function memberList(siteId: string, db: Db): Promise<Member[]> {
  const [users, accounts, sessions, logins] = await Promise.all([
    db
      .select({
        id: authTables.user.id,
        name: authTables.user.name,
        email: authTables.user.email,
        role: authTables.user.role,
        emailVerified: authTables.user.emailVerified,
        createdAt: authTables.user.createdAt,
      })
      .from(authTables.user),
    db
      .select({ userId: authTables.account.userId, providerId: authTables.account.providerId })
      .from(authTables.account)
      .where(
        or(
          eq(authTables.account.providerId, 'github'),
          and(
            eq(authTables.account.providerId, 'credential'),
            isNotNull(authTables.account.password),
          ),
        ),
      ),
    db
      .select({ userId: authTables.session.userId, createdAt: authTables.session.createdAt })
      .from(authTables.session),
    // A grouped read of one kind rather than the whole table: an owner opens this screen now
    // and then, and 180 days of sign-ins is thousands of rows, not millions.
    db
      .select({ userId: activity.userId, at: max(activity.at) })
      .from(activity)
      .where(and(eq(activity.siteId, siteId), eq(activity.kind, 'login')))
      .groupBy(activity.userId),
  ]);
  const providers = new Map<string, Set<string>>();
  for (const row of accounts) {
    const held = providers.get(row.userId) ?? new Set<string>();
    held.add(row.providerId);
    providers.set(row.userId, held);
  }
  const signedIn = new Map<string, number>();
  for (const row of sessions) {
    const at = row.createdAt.getTime();
    signedIn.set(row.userId, Math.max(signedIn.get(row.userId) ?? 0, at));
  }
  for (const row of logins) {
    if (row.userId && row.at !== null)
      signedIn.set(row.userId, Math.max(signedIn.get(row.userId) ?? 0, row.at));
  }
  return users
    .map((row) => {
      const held = providers.get(row.id);
      const lastSignIn = signedIn.get(row.id) ?? null;
      const pending = !row.emailVerified && !held && lastSignIn === null;
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        role: roleOf(siteId, row),
        pending,
        // GitHub first: it is the one a person recognises, and somebody who has linked it
        // signs in with it whatever else they also hold.
        method: pending
          ? null
          : held?.has('github')
            ? ('github' as const)
            : held?.has('credential')
              ? ('password' as const)
              : ('link' as const),
        lastSignIn,
        invitedAt: row.createdAt.getTime(),
      };
    })
    .sort((a, b) => (b.lastSignIn ?? -1) - (a.lastSignIn ?? -1) || a.invitedAt - b.invitedAt);
}

/**
 * Take one owner out of the count — the write and the rule in the same statement, because the
 * rule is about how many owners there are and any check that reads first can be overtaken.
 * Two owners demoting or removing each other at the same instant would both read a count of
 * two and both go, leaving a site nobody can manage; one `UPDATE` whose own `WHERE` asks
 * whether another owner is left serialises them, and the second finds none and changes
 * nothing.
 *
 * `false` is the refusal: this row is the last owner, or somebody else demoted it first. A row
 * that is not an owner is not this function's business — callers ask about the role before
 * they get here, since removing an editor never touches the count.
 */
export async function demoteOwner(_siteId: string, db: Db, userId: string): Promise<boolean> {
  const anotherOwner = db
    .select({ one: sql`1` })
    .from(authTables.user)
    .where(and(eq(authTables.user.role, 'owner'), ne(authTables.user.id, userId)));
  const changed = await db
    .update(authTables.user)
    .set({ role: 'editor' })
    .where(
      and(eq(authTables.user.id, userId), eq(authTables.user.role, 'owner'), exists(anotherOwner)),
    )
    .returning({ id: authTables.user.id });
  return changed.length > 0;
}
