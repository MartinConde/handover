import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { BetterAuthOptions } from 'better-auth/minimal';
import { betterAuth } from 'better-auth/minimal';
import { createAccessControl } from 'better-auth/plugins/access';
import { admin } from 'better-auth/plugins/admin';
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import { magicLink } from 'better-auth/plugins/magic-link';
import * as authTables from './auth-schema.js';
import type { Db } from './db.js';

/** Where the login's own endpoints are served, and the one path no session assert may cover. */
export const AUTH_BASE_PATH = '/admin/api/auth';

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
  /** Absent until the site has GitHub credentials — the provider is not mounted without them. */
  github?: { clientId: string; clientSecret: string };
  /** Sends the link the user clicks; absent until the site has a `Mailer`. */
  sendMagicLink?: (data: { email: string; url: string }) => Promise<void>;
  /**
   * Whether this request arrived over https. Defaults to yes, because the wrong answer in
   * that direction is only an inconvenience on a dev machine, and in the other it is a
   * session cookie a plaintext request can carry.
   */
  secureCookies?: boolean;
}

/**
 * The options `npx auth generate` reads and the ones the Worker runs — one object, so the
 * tables in `auth-schema.ts` cannot drift from the config that queries them. A method whose
 * credentials the site does not hold is left unmounted rather than mounted and broken.
 */
export function authOptions(db: Db, config: AuthConfig): BetterAuthOptions {
  return {
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema: { ...authTables } }),
    // Closed on every method separately: forgetting one lets a stranger create a user on a
    // client's admin. The only way in is an invite, which pre-creates the row.
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    ...(config.github
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
      // Said rather than inferred: with no `baseURL` set, Better Auth falls back to
      // `NODE_ENV === 'production'`, which a Worker never sets — so the deployed site was
      // handing out a session cookie with no `Secure` on it.
      useSecureCookies: config.secureCookies ?? true,
    },
    plugins: [
      ...(config.sendMagicLink
        ? [magicLink({ sendMagicLink: config.sendMagicLink, disableSignUp: true })]
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
