import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { BetterAuthOptions } from 'better-auth/minimal';
import { createAccessControl } from 'better-auth/plugins/access';
import { admin } from 'better-auth/plugins/admin';
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import { magicLink } from 'better-auth/plugins/magic-link';
import * as authTables from './auth-schema.js';
import type { Db } from './db.js';

// Two roles, one `role` column. The admin plugin refuses an `adminRoles` entry it has no
// role for, so this is what makes `owner` a name rather than a string. What each may do
// inside Handover — publish, upload, change what is editable — is asserted by the route
// handlers; these statements are only the member management the plugin itself gates.
const ac = createAccessControl(defaultStatements);
const roles = { owner: adminAc, editor: userAc };

/** What differs per site; everything else about the login is the package's decision. */
export interface AuthConfig {
  secret: string;
  github: { clientId: string; clientSecret: string };
  /** Sends the link the user clicks; wired to the site's `Mailer`. */
  sendMagicLink: (data: { email: string; url: string }) => Promise<void>;
}

/**
 * The options `@better-auth/cli generate` reads and the ones the Worker runs — one object,
 * so the tables in `auth-schema.ts` cannot drift from the config that queries them. The
 * instance itself is built per request, never at module scope: a singleton and a
 * per-request instance fighting over the D1 lock is the documented `wrangler dev` hang.
 */
export function authOptions(db: Db, config: AuthConfig): BetterAuthOptions {
  return {
    secret: config.secret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema: { ...authTables } }),
    // Closed on every method separately: forgetting one lets a stranger create a user on a
    // client's admin. The only way in is an invite, which pre-creates the row.
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    socialProviders: { github: { ...config.github, disableSignUp: true } },
    // GitHub sign-in only succeeds against a row that already carries the same verified
    // email, so linking is what makes closed signup and social login coexist.
    account: { accountLinking: { enabled: true, trustedProviders: ['github'] } },
    // D1 through the same Drizzle adapter, so `/sign-in/email` is rate-limited without KV.
    rateLimit: { storage: 'database' },
    plugins: [
      magicLink({ sendMagicLink: config.sendMagicLink, disableSignUp: true }),
      admin({ ac, roles, adminRoles: ['owner'], defaultRole: 'editor' }),
    ],
  };
}
