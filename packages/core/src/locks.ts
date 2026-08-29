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
  /** The tab it is held from — the same person in a second tab is not the holder. */
  tab: string;
  /** Null where the account has gone since — the row outlives it until it expires. */
  name: string | null;
  expiresAt: number;
}

/**
 * Take the lock on one entry, or push the one we already hold further out. The expiry it now
 * carries, or `undefined` when another tab is editing it — `lockHolder` names them. The lock is
 * the tab's and not the person's: the same person in a second tab is refused too, since two
 * tabs on one draft row is the overwrite the lock exists to stop.
 *
 * One statement: the update only fires for our own row or an expired one, so two tabs asking
 * at once cannot both be told they have it.
 */
export async function claimLock(
  siteId: string,
  db: Db,
  entry: string,
  userId: string,
  tab: string,
  now = Date.now(),
): Promise<number | undefined> {
  const expiresAt = now + LOCK_TTL;
  const [taken] = await db
    .insert(locks)
    .values({ siteId, entry, userId, tab, expiresAt })
    .onConflictDoUpdate({
      target: [locks.siteId, locks.entry],
      set: { userId, tab, expiresAt },
      setWhere: or(and(eq(locks.userId, userId), eq(locks.tab, tab)), lte(locks.expiresAt, now)),
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
    .select({ userId: locks.userId, tab: locks.tab, name: user.name, expiresAt: locks.expiresAt })
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

/** Who is in each entry right now, entry → person: the badge on the list row and the card. */
export async function lockHolders(
  siteId: string,
  db: Db,
  now = Date.now(),
): Promise<Record<string, { id: string; name: string | null }>> {
  const rows = await db
    .select({ entry: locks.entry, id: locks.userId, name: user.name })
    .from(locks)
    .leftJoin(user, eq(user.id, locks.userId))
    .where(and(eq(locks.siteId, siteId), gt(locks.expiresAt, now)));
  return Object.fromEntries(rows.map((row) => [row.entry, { id: row.id, name: row.name }]));
}

/** Everything one member is holding, let go at once: what removing them does to their locks. */
export async function releaseLocks(siteId: string, db: Db, userId: string): Promise<void> {
  await db.delete(locks).where(and(eq(locks.siteId, siteId), eq(locks.userId, userId)));
}

/**
 * Take an entry off whoever is holding it: the same upsert as `claimLock` without the condition,
 * because Take over is a person deciding rather than two tabs racing. The holder hears about it
 * when their next save is refused.
 */
export async function takeLock(
  siteId: string,
  db: Db,
  entry: string,
  userId: string,
  tab: string,
  now = Date.now(),
): Promise<number> {
  const expiresAt = now + LOCK_TTL;
  await db
    .insert(locks)
    .values({ siteId, entry, userId, tab, expiresAt })
    .onConflictDoUpdate({ target: [locks.siteId, locks.entry], set: { userId, tab, expiresAt } });
  return expiresAt;
}

/**
 * The lock follows the entry a rename gave a new name: whoever has it open still has it, and
 * their next beat is about the entry that now exists. The row a free name might still carry
 * goes first, the way `recordRename` clears the draft at the new path — only a name nothing
 * holds is ever renamed onto, and a primary key that did collide would throw after the commit.
 */
export async function moveLock(siteId: string, db: Db, from: string, to: string): Promise<void> {
  await db.delete(locks).where(and(eq(locks.siteId, siteId), eq(locks.entry, to)));
  await db
    .update(locks)
    .set({ entry: to })
    .where(and(eq(locks.siteId, siteId), eq(locks.entry, from)));
}

/** The entry has gone, so nobody is editing it: what a delete does to its lock. */
export async function dropLock(siteId: string, db: Db, entry: string): Promise<void> {
  await db.delete(locks).where(and(eq(locks.siteId, siteId), eq(locks.entry, entry)));
}
