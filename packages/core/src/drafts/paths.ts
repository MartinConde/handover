import { and, eq, inArray, sql } from 'drizzle-orm';
import { batchAll, type Db } from '../db.js';
import { operations, pathReservations } from '../tables.js';
import { noLiveRow, type PathReservation } from './drafts.js';

export type { PathReservation } from './drafts.js';

const ownedReservation = async (
  siteId: string,
  db: Db,
  operationId: string,
  paths: string[],
): Promise<PathReservation | undefined> => {
  const claimed = await db
    .select()
    .from(pathReservations)
    .where(and(eq(pathReservations.siteId, siteId), inArray(pathReservations.path, paths)));
  if (
    claimed.length !== paths.length ||
    claimed.some((row) => row.operationId !== operationId || row.token !== claimed[0]?.token)
  )
    return undefined;
  const token = claimed[0]?.token;
  return token ? { operationId, paths, token } : undefined;
};

/** Reserve every locale destination together; a crashed request's operation rejoins its claim. */
export async function reservePaths(
  siteId: string,
  db: Db,
  paths: string[],
  operationId: string,
): Promise<PathReservation> {
  const unique = [...new Set(paths)].sort();
  if (!unique.length) throw new Error('A destination reservation needs at least one path');
  const [owner] = await db
    .select({ state: operations.state })
    .from(operations)
    .where(and(eq(operations.siteId, siteId), eq(operations.id, operationId)))
    .limit(1);
  if (!owner || owner.state === 'finalized')
    throw new Error('A destination reservation needs an active operation owner');
  // A worker may have stopped after finalization but before cleanup. Finalization is monotonic,
  // so these claims are safe to discard and can never become active again.
  await db
    .delete(pathReservations)
    .where(
      and(
        eq(pathReservations.siteId, siteId),
        inArray(pathReservations.path, unique),
        sql`exists (select 1 from operations where operations.site_id = ${siteId} and operations.id = ${pathReservations.operationId} and operations.state = 'finalized')`,
      ),
    );
  const existing = await ownedReservation(siteId, db, operationId, unique);
  if (existing) return existing;
  const token = crypto.randomUUID();
  const writes = unique.map((path) =>
    db.insert(pathReservations).values({
      siteId,
      path,
      operationId,
      token: sql`case when ${noLiveRow(siteId, path)} then ${token} else null end`,
    }),
  );
  try {
    await batchAll(db, writes);
  } catch (error) {
    // Simultaneous retries of one durable operation join whichever token won the batch.
    const joined = await ownedReservation(siteId, db, operationId, unique);
    if (joined) return joined;
    throw error;
  }
  return { operationId, paths: unique, token };
}
export async function releasePaths(
  siteId: string,
  db: Db,
  reservation: Pick<PathReservation, 'operationId' | 'token'>,
): Promise<void> {
  await db
    .delete(pathReservations)
    .where(
      and(
        eq(pathReservations.siteId, siteId),
        eq(pathReservations.operationId, reservation.operationId),
        eq(pathReservations.token, reservation.token),
      ),
    );
}

/** Safe crash cleanup when finalization won but the request stopped before releasing its token. */
export async function releaseOperationPaths(
  siteId: string,
  db: Db,
  operationId: string,
): Promise<void> {
  await db
    .delete(pathReservations)
    .where(
      and(
        eq(pathReservations.siteId, siteId),
        eq(pathReservations.operationId, operationId),
        sql`exists (select 1 from operations where operations.site_id = ${siteId} and operations.id = ${operationId} and operations.state = 'finalized')`,
      ),
    );
}
