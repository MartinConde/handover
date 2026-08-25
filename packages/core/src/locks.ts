import { and, eq, gt, lte, or } from 'drizzle-orm';
import type { Db } from './db.js';
import { locks, user } from './tables.js';

/**
 * How long a lock outlives the beat that took it. The editor beats while somebody is typing,
 * so an abandoned tab lets go of the entry without anybody having to say it did.
 */
export const LOCK_TTL = 120_000;

/** Who is editing an entry, and when the beat that took it runs out. */
export interface Lock {
  userId: string;
  /** Null where the account has gone since — the row outlives it until it expires. */
  name: string | null;
  expiresAt: number;
}

/**
 * Take the lock on one entry, or push the one we already hold further out. The expiry it now
 * carries, or `undefined` when somebody else is editing it — `lockHolder` names them.
 *
 * One statement: the update only fires for our own row or an expired one, so two tabs asking
 * at once cannot both be told they have it.
 */
export async function claimLock(
  siteId: string,
  db: Db,
  entry: string,
  userId: string,
  now = Date.now(),
): Promise<number | undefined> {
  const expiresAt = now + LOCK_TTL;
  const [taken] = await db
    .insert(locks)
    .values({ siteId, entry, userId, expiresAt })
    .onConflictDoUpdate({
      target: [locks.siteId, locks.entry],
      set: { userId, expiresAt },
      setWhere: or(eq(locks.userId, userId), lte(locks.expiresAt, now)),
    })
    .returning();
  return taken ? expiresAt : undefined;
}

/** Who is editing this entry right now, or nothing where the last beat has run out. */
export async function lockHolder(
  siteId: string,
  db: Db,
  entry: string,
  now = Date.now(),
): Promise<Lock | undefined> {
  const [row] = await db
    .select({ userId: locks.userId, name: user.name, expiresAt: locks.expiresAt })
    .from(locks)
    .leftJoin(user, eq(user.id, locks.userId))
    .where(and(eq(locks.siteId, siteId), eq(locks.entry, entry), gt(locks.expiresAt, now)))
    .limit(1);
  return row;
}

/** What each member is editing right now, member id → entries: the members screen's warning. */
export async function heldEntries(
  siteId: string,
  db: Db,
  now = Date.now(),
): Promise<Record<string, string[]>> {
  const rows = await db
    .select({ userId: locks.userId, entry: locks.entry })
    .from(locks)
    .where(and(eq(locks.siteId, siteId), gt(locks.expiresAt, now)));
  const held: Record<string, string[]> = {};
  for (const row of rows) held[row.userId] = [...(held[row.userId] ?? []), row.entry];
  return held;
}

/** Everything one member is holding, let go at once: what removing them does to their locks. */
export async function releaseLocks(siteId: string, db: Db, userId: string): Promise<void> {
  await db.delete(locks).where(and(eq(locks.siteId, siteId), eq(locks.userId, userId)));
}
