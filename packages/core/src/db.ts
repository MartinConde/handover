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
