import { desc } from 'drizzle-orm';
import { blob, index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { RedirectRule } from './lifecycle.js';

// Better Auth owns those five. `auth-schema.ts` is written by
// `npx auth generate` (see scripts/auth-config.ts) and is committed exactly as the
// generator emits it — biome skips it — so the next upgrade's regenerate is a clean diff.
export * from './auth-schema.js';

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
    /** When the hold was set, epoch milliseconds — the drawer's *· 2 days*. Null with `held_by`. */
    heldAt: integer('held_at'),
    /** Rules this entry adds to redirects.yaml when it is the one being published. */
    pendingRedirects: text('pending_redirects', { mode: 'json' }).$type<RedirectRule[]>(),
    /** The commit this row was published in; the row is cleared once that build is live. */
    publishedSha: text('published_sha'),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.path] })],
);

/** Uploaded originals. The bytes are in R2; this row is what the library and search read. */
export const media = sqliteTable('media', {
  /** sha256 of the bytes, so uploading the same file twice is one object and one row. */
  id: text('id').primaryKey(),
  siteId: text('site_id').notNull().default('default'),
  r2Key: text('r2_key').notNull(),
  /** Original upload name, kept for search rather than for addressing the object. */
  filename: text('filename'),
  mime: text('mime'),
  bytes: integer('bytes'),
  width: integer('width'),
  height: integer('height'),
  /** Library defaults; the content file wins where it sets its own. */
  alt: text('alt'),
  focalX: real('focal_x').default(0.5),
  focalY: real('focal_y').default(0.5),
  tags: text('tags', { mode: 'json' }).$type<string[]>(),
  derivedFrom: text('derived_from'),
  archived: integer('archived').default(0),
  createdAt: integer('created_at').notNull(),
});

/** Soft locks: advisory, heartbeat-extended, and keyed on the entry rather than the file. */
export const locks = sqliteTable(
  'locks',
  {
    siteId: text('site_id').notNull().default('default'),
    /** collection/slug — locale-agnostic, so both languages of an entry lock together. */
    entry: text('entry').notNull(),
    userId: text('user_id').notNull(),
    /** Which of that person's tabs holds it: a random id the tab made up and beats with. */
    tab: text('tab').notNull().default(''),
    /** Epoch milliseconds, pushed ~2 min ahead by each heartbeat. */
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.entry] })],
);

/** The half of "who changed this?" that never reaches git: logins, uploads, take-overs. */
export const activity = sqliteTable(
  'activity',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id').notNull().default('default'),
    at: integer('at').notNull(),
    /** Null for cron and other system events. */
    userId: text('user_id'),
    kind: text('kind').notNull(),
    /** Entry path, media id or user id, depending on the kind. */
    subject: text('subject'),
    /** Small json, never file contents. */
    detail: text('detail', { mode: 'json' }),
    commitSha: text('commit_sha'),
  },
  // Every read is `WHERE site_id = ? ORDER BY at DESC LIMIT 50`; D1 bills rows scanned.
  (t) => [index('activity_site_at').on(t.siteId, desc(t.at))],
);

/** The one writable settings section: credentials the client owns and may swap themselves. */
export const settings = sqliteTable(
  'settings',
  {
    siteId: text('site_id').notNull().default('default'),
    /** From the package's fixed allow-list: 'deepl' | 'assist'. */
    key: text('key').notNull(),
    /** AES-256-GCM under HANDOVER_SETTINGS_KEY, IV prepended; never sent to the browser. */
    ciphertext: blob('ciphertext', { mode: 'buffer' }).$type<Uint8Array>().notNull(),
    /** Last 4 characters, so the UI can show which key is set without holding it. */
    hint: text('hint'),
    updatedAt: integer('updated_at').notNull(),
    updatedBy: text('updated_by'),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.key] })],
);

/**
 * One row per registered cron job. The dispatcher runs on a single schedule and each job
 * declares its own interval, so `last_run` is what decides whether this tick is that job's.
 * Failures are not here — they are `cron-<job>` rows in the activity log.
 */
export const cronState = sqliteTable(
  'cron_state',
  {
    siteId: text('site_id').notNull().default('default'),
    job: text('job').notNull(),
    /** Epoch milliseconds of the last run the dispatcher completed. */
    lastRun: integer('last_run').notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.job] })],
);

/**
 * Bumped whenever a table above changes. `handover db generate` records it in
 * `migrations/handover.json`; the build refuses to go out with a stale one, so a package
 * upgrade that forgot to generate fails there rather than at the first query.
 */
export const SCHEMA_VERSION = 4;

const GENERATE = 'run `npx handover db generate` and commit migrations/';

/** Why `migrations/handover.json` (its text, or undefined when missing) is out of date. */
export function schemaVersionError(marker: string | undefined): string | undefined {
  if (marker === undefined) return `migrations/ has no handover.json: ${GENERATE}`;
  const at = (JSON.parse(marker) as { schemaVersion?: unknown }).schemaVersion;
  if (at === SCHEMA_VERSION) return undefined;
  if (typeof at === 'number' && at > SCHEMA_VERSION)
    return `migrations/ was generated for schema version ${at} but astro-handover's tables are at ${SCHEMA_VERSION}: the package is older than the migrations`;
  return `astro-handover's tables are at schema version ${SCHEMA_VERSION} but migrations/ was generated for ${at}: ${GENERATE}`;
}
