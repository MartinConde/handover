import { and, eq, gt, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Db } from './db.js';
import { costlyOperations, resourceLimits } from './tables.js';

export class ResourceLimitError extends Error {
  override name = 'ResourceLimitError';
}

export interface ResourceClaim {
  subject: string;
  kind: string;
  windowAt: number;
  cost: number;
}

const WINDOW = 60 * 60_000;

export async function claimResource(
  siteId: string,
  db: Db,
  request: {
    subject: string;
    kind: string;
    cost: number;
    limit: number;
    now?: number;
  },
): Promise<ResourceClaim> {
  const { subject, kind, cost, limit, now = Date.now() } = request;
  const windowAt = Math.floor(now / WINDOW) * WINDOW;
  if (!(Number.isInteger(cost) && cost > 0 && Number.isInteger(limit) && limit >= cost))
    throw new ResourceLimitError('Invalid resource budget');
  const [row] = await db
    .insert(resourceLimits)
    .values({ siteId, subject, kind, windowAt, used: cost })
    .onConflictDoUpdate({
      target: [resourceLimits.siteId, resourceLimits.subject, resourceLimits.kind],
      set: {
        windowAt,
        used: sql`case when ${resourceLimits.windowAt} = ${windowAt} then ${resourceLimits.used} + ${cost} else ${cost} end`,
      },
      setWhere: sql`${resourceLimits.windowAt} <> ${windowAt} or ${resourceLimits.used} + ${cost} <= ${limit}`,
    })
    .returning({ used: resourceLimits.used });
  if (!row) throw new ResourceLimitError('Too many costly requests; try again later');
  return { subject, kind, windowAt, cost };
}

export async function releaseResource(siteId: string, db: Db, claim: ResourceClaim): Promise<void> {
  await db
    .update(resourceLimits)
    .set({ used: sql`${resourceLimits.used} - ${claim.cost}` })
    .where(
      and(
        eq(resourceLimits.siteId, siteId),
        eq(resourceLimits.subject, claim.subject),
        eq(resourceLimits.kind, claim.kind),
        eq(resourceLimits.windowAt, claim.windowAt),
        gt(resourceLimits.used, 0),
      ),
    );
}

// The built-in provider aborts at 15 seconds. This also gives custom providers time to observe
// the cancellation signal before another Worker may take the lease.
const COSTLY_LEASE = 5 * 60_000;
const COSTLY_RETENTION = 60_000;

export async function claimCostlyOperation(
  siteId: string,
  db: Db,
  key: string,
  userId: string,
  now = Date.now(),
): Promise<{ owner: boolean; token?: string; result?: unknown }> {
  const expired = await db
    .select({ key: costlyOperations.key })
    .from(costlyOperations)
    .where(and(eq(costlyOperations.siteId, siteId), lt(costlyOperations.expiresAt, now)))
    .limit(100);
  if (expired.length)
    await db.delete(costlyOperations).where(
      and(
        eq(costlyOperations.siteId, siteId),
        lt(costlyOperations.expiresAt, now),
        inArray(
          costlyOperations.key,
          expired.map(({ key: expiredKey }) => expiredKey),
        ),
      ),
    );
  const leaseToken = crypto.randomUUID();
  const [owned] = await db
    .insert(costlyOperations)
    .values({
      siteId,
      key,
      userId,
      leaseToken,
      state: 'active',
      leaseUntil: now + COSTLY_LEASE,
      expiresAt: now + COSTLY_LEASE,
    })
    .onConflictDoUpdate({
      target: [costlyOperations.siteId, costlyOperations.key],
      set: {
        userId,
        leaseToken,
        state: 'active',
        leaseUntil: now + COSTLY_LEASE,
        result: null,
        expiresAt: now + COSTLY_LEASE,
      },
      setWhere: and(eq(costlyOperations.state, 'active'), lte(costlyOperations.leaseUntil, now)),
    })
    .returning({ key: costlyOperations.key });
  if (owned) return { owner: true, token: leaseToken };
  const [existing] = await db
    .select({ state: costlyOperations.state, result: costlyOperations.result })
    .from(costlyOperations)
    .where(and(eq(costlyOperations.siteId, siteId), eq(costlyOperations.key, key)))
    .limit(1);
  return existing?.state === 'complete'
    ? { owner: false, result: existing.result }
    : { owner: false };
}

export async function completeCostlyOperation(
  siteId: string,
  db: Db,
  key: string,
  token: string,
  result: unknown,
  now = Date.now(),
): Promise<void> {
  await db
    .update(costlyOperations)
    .set({ state: 'complete', leaseUntil: null, result, expiresAt: now + COSTLY_RETENTION })
    .where(
      and(
        eq(costlyOperations.siteId, siteId),
        eq(costlyOperations.key, key),
        eq(costlyOperations.leaseToken, token),
        eq(costlyOperations.state, 'active'),
      ),
    );
}

export async function costlyOperationResult(
  siteId: string,
  db: Db,
  key: string,
): Promise<unknown | undefined> {
  const [row] = await db
    .select({ state: costlyOperations.state, result: costlyOperations.result })
    .from(costlyOperations)
    .where(and(eq(costlyOperations.siteId, siteId), eq(costlyOperations.key, key)))
    .limit(1);
  return row?.state === 'complete' ? row.result : undefined;
}

export async function abandonCostlyOperation(
  siteId: string,
  db: Db,
  key: string,
  token: string,
): Promise<void> {
  await db
    .delete(costlyOperations)
    .where(
      and(
        eq(costlyOperations.siteId, siteId),
        eq(costlyOperations.key, key),
        eq(costlyOperations.leaseToken, token),
      ),
    );
}
