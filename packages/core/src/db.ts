import type { BatchItem } from 'drizzle-orm/batch';
import { drizzle } from 'drizzle-orm/d1';
import { drafts } from './tables.js';

type D1Binding = Parameters<typeof drizzle>[0];

/** The Handover tables on the site's D1 binding. */
export function openDb(_siteId: string, binding: D1Binding | undefined) {
  if (!binding) {
    throw new Error(
      'The D1 binding DB is not configured: add a d1_databases entry with "binding": "DB" to wrangler.jsonc',
    );
  }
  return drizzle(binding, { schema: { drafts } });
}

export type Db = ReturnType<typeof openDb>;
export type Draft = typeof drafts.$inferSelect;

/** Cloudflare D1 rejects an individual statement with more than this many bindings. */
export const D1_MAX_BOUND_PARAMETERS = 100;

/** Split values so callers can account for every fixed and per-row binding in their query. */
export function chunksOf<T>(values: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('Chunk size must be positive');
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

/** One D1 transaction; drizzle's `batch` refuses an empty list. */
export async function batchAll(db: Db, writes: readonly BatchItem<'sqlite'>[]): Promise<void> {
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
}
