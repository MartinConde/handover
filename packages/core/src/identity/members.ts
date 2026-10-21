import { and, desc, eq, exists, gt, isNotNull, max, ne, or, sql } from 'drizzle-orm';
import { isUiLocale, type UiLocale } from '../content/ui-locale.js';
import type { Db } from '../db.js';
import { activity } from '../tables.js';
import { type Role, roleOf } from './auth.js';
import * as authTables from './auth-schema.js';

/** Every emailed sign-in link to the address, so a revoked or resent invite stops working. */
export async function dropEmailLinks(db: Db, email: string): Promise<void> {
  const { verification } = authTables;
  await db
    .delete(verification)
    .where(
      and(
        sql`${verification.identifier} LIKE 'magic-link:%'`,
        sql`lower(json_extract(${verification.value}, '$.email')) = ${email.toLowerCase()}`,
      ),
    );
}

/** Undefined when there is no account; null when the person never chose an interface language. */
export async function accountLocale(db: Db, email: string): Promise<UiLocale | null | undefined> {
  const [row] = await db
    .select({ uiLocale: authTables.user.uiLocale })
    .from(authTables.user)
    .where(eq(authTables.user.email, email))
    .limit(1);
  return row && (isUiLocale(row.uiLocale) ? row.uiLocale : null);
}

export interface AccountFacts {
  hasPassword: boolean;
  sessions: { id: string; current: boolean; userAgent: string | null; lastUsed: number }[];
}

/** Not `/list-sessions`: that needs a session younger than `freshAge` and leaks each token. */
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
        role: roleOf(row),
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
export async function demoteOwner(db: Db, userId: string): Promise<boolean> {
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
