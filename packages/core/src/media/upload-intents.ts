import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db.js';
import { uploadIntents } from '../tables.js';

export type UploadIntent = typeof uploadIntents.$inferSelect;
const EXPIRES = 60 * 60_000;

export async function issueUploadIntent(
  siteId: string,
  db: Db,
  intent: {
    key: string;
    userId: string;
    hash: string;
    bytes: number;
    mime: string;
    now?: number;
  },
): Promise<void> {
  const now = intent.now ?? Date.now();
  const expired = await db
    .select({ key: uploadIntents.key })
    .from(uploadIntents)
    .where(and(eq(uploadIntents.siteId, siteId), lt(uploadIntents.expiresAt, now)))
    .limit(100);
  if (expired.length)
    await db.delete(uploadIntents).where(
      and(
        eq(uploadIntents.siteId, siteId),
        lt(uploadIntents.expiresAt, now),
        inArray(
          uploadIntents.key,
          expired.map(({ key: expiredKey }) => expiredKey),
        ),
      ),
    );
  await db.insert(uploadIntents).values({
    siteId,
    key: intent.key,
    userId: intent.userId,
    hash: intent.hash,
    bytes: intent.bytes,
    mime: intent.mime,
    state: 'pending',
    expiresAt: now + EXPIRES,
  });
}

export async function claimUploadIntent(
  siteId: string,
  db: Db,
  key: string,
  userId: string,
  now = Date.now(),
): Promise<UploadIntent | undefined> {
  const [row] = await db
    .update(uploadIntents)
    .set({ state: 'uploading' })
    .where(
      and(
        eq(uploadIntents.siteId, siteId),
        eq(uploadIntents.key, key),
        eq(uploadIntents.userId, userId),
        gt(uploadIntents.expiresAt, now),
        eq(uploadIntents.state, 'pending'),
      ),
    )
    .returning();
  return row;
}

export async function releaseUploadIntent(
  siteId: string,
  db: Db,
  key: string,
  userId: string,
): Promise<void> {
  await db
    .update(uploadIntents)
    .set({ state: 'pending' })
    .where(
      and(
        eq(uploadIntents.siteId, siteId),
        eq(uploadIntents.key, key),
        eq(uploadIntents.userId, userId),
        eq(uploadIntents.state, 'uploading'),
      ),
    );
}

export async function markUploadStored(
  siteId: string,
  db: Db,
  key: string,
  userId: string,
): Promise<void> {
  await db
    .update(uploadIntents)
    .set({ state: 'stored' })
    .where(
      and(
        eq(uploadIntents.siteId, siteId),
        eq(uploadIntents.key, key),
        eq(uploadIntents.userId, userId),
        eq(uploadIntents.state, 'uploading'),
      ),
    );
}

export async function storedUploadIntent(
  siteId: string,
  db: Db,
  key: string,
  userId: string,
  now = Date.now(),
): Promise<UploadIntent | undefined> {
  const [row] = await db
    .select()
    .from(uploadIntents)
    .where(
      and(
        eq(uploadIntents.siteId, siteId),
        eq(uploadIntents.key, key),
        eq(uploadIntents.userId, userId),
        eq(uploadIntents.state, 'stored'),
        gt(uploadIntents.expiresAt, now),
      ),
    )
    .limit(1);
  return row;
}

export async function finishUploadIntent(siteId: string, db: Db, key: string): Promise<void> {
  await db
    .delete(uploadIntents)
    .where(and(eq(uploadIntents.siteId, siteId), eq(uploadIntents.key, key)));
}
