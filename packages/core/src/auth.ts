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

/** The one path no session assert may cover. */
export const AUTH_BASE_PATH = '/admin/api/auth';

/** The login screen quotes this number. */
const MAGIC_LINK_MINUTES = 15;

// Only member management is gated here; what each role may do is asserted by the routes.
const ac = createAccessControl(defaultStatements);
const roles = { owner: adminAc, editor: userAc };

/** Anything but `owner` is an editor, the narrower role being the safe guess. */
export type Role = 'owner' | 'editor';
export const roleOf = (_siteId: string, user: { id: string; role?: string | null }): Role =>
  user.role === 'owner' ? 'owner' : 'editor';

export interface AuthConfig {
  secret: string;
  /** Decides where emailed links point, so it must never come from a request header. */
  baseURL?: string;
  basePath?: string;
  github?: { clientId: string; clientSecret: string };
  sendMagicLink?: (data: { email: string; url: string }) => Promise<void>;
  sendPasswordReset?: (data: { email: string; url: string }) => Promise<void>;
  /** Defaults to true: the wrong answer the other way is a session cookie sent in plaintext. */
  secureCookies?: boolean;
  /** An invite is read hours later; the minted row carries its own expiry. */
  magicLinkMinutes?: number;
  /** `ctx.waitUntil` on Workers; a handler that drops the promise loses the email. */
  background?: (promise: Promise<unknown>) => void;
}

// `path` is the endpoint's own path, not the mounted URL; any other path is not a login.
const SIGN_IN_METHOD: Record<string, string> = {
  '/sign-in/email': 'password',
  '/magic-link/verify': 'link',
};

/** One object for `npx auth generate` and the Worker, so `auth-schema.ts` cannot drift from it. */
export function authOptions(siteId: string, db: Db, config: AuthConfig): BetterAuthOptions {
  const emailing = Boolean(config.baseURL);
  const resetting = emailing && config.sendPasswordReset;
  return {
    basePath: config.basePath ?? AUTH_BASE_PATH,
    baseURL: config.baseURL,
    secret: config.secret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema: { ...authTables } }),
    // Signup is closed on every method separately; the only way in is an invite.
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
            // Stated so the hour the docs quote is this file's number.
            resetPasswordTokenExpiresIn: 60 * 60,
            // A reset may follow a lost account, so old sessions must not stay signed in.
            revokeSessionsOnPasswordReset: true,
          }
        : {}),
    },
    ...(emailing && config.github
      ? { socialProviders: { github: { ...config.github, disableSignUp: true } } }
      : {}),
    // Linking is what lets closed signup and GitHub sign-in coexist.
    account: { accountLinking: { enabled: true, trustedProviders: ['github'] } },
    // `enabled` defaults to `NODE_ENV === 'production'`, which a Worker never sets.
    rateLimit: { enabled: true, storage: 'database' },
    // An expired OAuth state has nowhere to route back to but Better Auth's own error page.
    onAPIError: { errorURL: (config.basePath ?? AUTH_BASE_PATH).replace(/\/api\/auth$/, '') },
    // Impersonation would let an owner act as anybody with the log naming that person.
    disabledPaths: ['/admin/impersonate-user'],
    advanced: {
      // The default `x-forwarded-for` is caller-written; `cf-connecting-ip` cannot be sent in.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // The default is `isTest()`, which would wave every `origin` through under vitest.
      disableOriginCheck: false,
      // The default falls back to `NODE_ENV`, so a Worker would hand out cookies without `Secure`.
      useSecureCookies: config.secureCookies ?? true,
      ...(config.background ? { backgroundTasks: { handler: config.background } } : {}),
    },
    // `logActivity` must swallow failures: an after-hook throw answers 500 with the row committed.
    databaseHooks: {
      // The consumed row's `value` is the user id; its other column is the token in the clear.
      verification: {
        delete: {
          after: async (row, context) => {
            if (context?.path !== '/reset-password') return;
            await logActivity(siteId, db, {
              userId: row.value,
              kind: 'password-set',
              detail: { how: 'reset' },
            });
          },
        },
      },
      // Keyed on the endpoint, since a refreshed OAuth token updates the same table.
      account: {
        update: {
          after: async (account, context) => {
            if (context?.path !== '/change-password') return;
            await logActivity(siteId, db, {
              userId: account.userId,
              kind: 'password-set',
              detail: { how: 'changed' },
            });
          },
        },
      },
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
              // A database read then yields a hash, not the mailed link.
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

/** Plugin endpoints are absent from the generic `Auth` type, so their real signatures live here. */
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

export const memberApi = (_siteId: string, auth: Auth): MemberApi =>
  auth.api as unknown as MemberApi;

/** Per request only: a singleton contending with per-request instances over D1 hangs dev. */
export function createAuth(siteId: string, db: Db, config: AuthConfig): Auth {
  const auth = betterAuth(authOptions(siteId, db, config));
  const handler = auth.handler;
  // Plugin administration stays behind the guarded MemberApi, never open to HTTP callers.
  auth.handler = async (request) => {
    const path = new URL(request.url).pathname.slice((config.basePath ?? AUTH_BASE_PATH).length);
    const allowed =
      request.method === 'POST'
        ? [
            '/sign-in/email',
            '/sign-in/magic-link',
            '/sign-in/social',
            '/sign-out',
            '/request-password-reset',
            '/reset-password',
            '/update-user',
            '/change-password',
            '/revoke-other-sessions',
          ].includes(path)
        : request.method === 'GET' &&
          (/^\/(callback\/github|magic-link\/verify|reset-password\/[^/]+)$/.test(path) ||
            ['/get-session', '/error'].includes(path));
    return allowed ? handler(request) : new Response('Not found', { status: 404 });
  };
  return auth;
}

export async function userExists(_siteId: string, db: Db, email: string): Promise<boolean> {
  const rows = await db
    .select({ id: authTables.user.id })
    .from(authTables.user)
    .where(eq(authTables.user.email, email))
    .limit(1);
  return rows.length > 0;
}

export interface AccountFacts {
  hasPassword: boolean;
  sessions: { id: string; current: boolean; userAgent: string | null; lastUsed: number }[];
}

/** Not `/list-sessions`: that needs a session younger than `freshAge` and leaks each token. */
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

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Inferred, since no `invited_at` column may be added: unverified, no account, no sign-in. */
  pending: boolean;
  /** Null while pending, because nobody knows yet. */
  method: 'github' | 'password' | 'link' | null;
  /** Newest session or `login` event: sign-out deletes sessions; the log postdates some members. */
  lastSignIn: number | null;
  invitedAt: number;
}

/** Four reads and no join; the password hash is never a selected column. */
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
    // Grouped by kind: 180 days of sign-ins is thousands of rows.
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
        // GitHub first: whoever linked it signs in with it whatever else they hold.
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

/** The rule lives in the `WHERE`: two owners demoting each other at once would both pass a read. */
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
