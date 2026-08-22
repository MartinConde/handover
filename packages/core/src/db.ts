import { drizzle } from 'drizzle-orm/d1';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { RedirectRule } from './lifecycle.js';

/**
 * Edits live here, not in git, until they are published. `contents` is the canonical
 * serialised file — the exact bytes a publish would commit — so "nothing pending" is a
 * blob-SHA comparison against `base_blob` rather than a deep-equal of form state.
 */
export const drafts = sqliteTable(
  'drafts',
  {
    siteId: text('site_id').notNull().default('default'),
    path: text('path').notNull(),
    contents: text('contents').notNull(),
    /** Commit the file was loaded from; the diff base of the three-way view. */
    baseSha: text('base_sha').notNull(),
    /** Blob SHA of that file at `base_sha`; conflict detection compares this against HEAD. */
    baseBlob: text('base_blob').notNull(),
    /** Epoch milliseconds. */
    updatedAt: integer('updated_at').notNull(),
    updatedBy: text('updated_by'),
    /** "Not ready yet": the user id holding the entry back, null when it is ready. */
    heldBy: text('held_by'),
    /** Rules this entry adds to redirects.yaml when it is the one being published. */
    pendingRedirects: text('pending_redirects', { mode: 'json' }).$type<RedirectRule[]>(),
    /** The commit this row was published in; the row is cleared once that build is live. */
    publishedSha: text('published_sha'),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.path] })],
);

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
