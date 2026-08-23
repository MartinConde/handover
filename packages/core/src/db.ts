import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { mergeEntry, parseEntry, stringifyEntry } from './content.js';
import { type ContentFile, type ContentIndex, indexHasPath } from './entries.js';
import { blobSha, type GitClient } from './git.js';
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

export type Db = ReturnType<typeof openDb>;
export type Draft = typeof drafts.$inferSelect;

/** A row with no contents is a path a commit removed, not a draft anyone can open. */
export function loadDraft(siteId: string, db: Db, path: string): Promise<Draft | undefined> {
  return db.query.drafts.findFirst({
    where: and(eq(drafts.siteId, siteId), eq(drafts.path, path), ne(drafts.contents, '')),
  });
}

/**
 * One autosave. `base_*` are read from git the first time a row is written and never sent
 * by the browser — a tab left open across someone else's publish would report a stale base.
 * `undefined` when the path is not in the repo.
 */
export async function saveDraft(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  path: string,
  values: Record<string, unknown>,
): Promise<{ updated_at: number; pending: boolean } | undefined> {
  const row = await loadDraft(siteId, db, path);
  let base: { sha: string; blob: string };
  let entry: unknown;
  if (row) {
    base = { sha: row.baseSha, blob: row.baseBlob };
    entry = parseEntry(siteId, row.contents);
  } else {
    const [file, head] = await Promise.all([git.getFile(path), git.getHead()]);
    if (!file) return undefined;
    base = { sha: head, blob: file.blob_sha };
    entry = parseEntry(siteId, file.contents);
  }
  const contents = stringifyEntry(siteId, mergeEntry(siteId, entry, values));
  const updatedAt = Date.now();
  await db
    .insert(drafts)
    .values({ siteId, path, contents, baseSha: base.sha, baseBlob: base.blob, updatedAt })
    // The base moves only when it was just read from git — a row the editor is working on
    // keeps the one it was loaded against, and the row a delete left has none worth keeping.
    .onConflictDoUpdate({
      target: [drafts.siteId, drafts.path],
      set: row
        ? { contents, updatedAt, publishedSha: null }
        : { contents, baseSha: base.sha, baseBlob: base.blob, updatedAt, publishedSha: null },
    });
  return { updated_at: updatedAt, pending: (await blobSha(contents)) !== base.blob };
}

/**
 * A new entry. There is no file behind it, so the base blob is the empty string: nothing in
 * the repository hashes to that, which is what makes the row pending and its first publish
 * create the path — and what turns someone else getting there first into a conflict.
 */
export async function createDraft(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getHead'>,
  path: string,
  values: Record<string, unknown>,
): Promise<{ updated_at: number }> {
  const updatedAt = Date.now();
  const contents = stringifyEntry(siteId, values);
  const baseSha = await git.getHead();
  await db
    .insert(drafts)
    .values({ siteId, path, contents, baseSha, baseBlob: '', updatedAt })
    // Only a removed row can be at this path: a name a live row holds is never picked again.
    .onConflictDoUpdate({
      target: [drafts.siteId, drafts.path],
      set: { contents, baseSha, baseBlob: '', updatedAt, publishedSha: null },
    });
  return { updated_at: updatedAt };
}

/**
 * What a commit removed, kept for the entry list: the index is made at build time, so until
 * the build that carries the commit is live it still has the file. An empty row says the path
 * has gone, and `published_sha` keeps it out of the drawer and out of the next publish.
 */
export async function recordDelete(
  siteId: string,
  db: Db,
  path: string,
  commitSha: string,
): Promise<void> {
  const gone = { contents: '', baseSha: commitSha, baseBlob: '', updatedAt: Date.now() };
  await db
    .insert(drafts)
    .values({ siteId, path, ...gone, publishedSha: commitSha })
    .onConflictDoUpdate({
      target: [drafts.siteId, drafts.path],
      set: { ...gone, publishedSha: commitSha },
    });
}

/**
 * The same for a rename, which is a delete and a write. An open draft moves onto the new path
 * with its edits — the commit carried the loaded bytes over untouched, so `base_blob` still
 * describes the file there; without one the committed bytes are stored so the row can name the
 * entry in the list.
 */
export async function recordRename(
  siteId: string,
  db: Db,
  from: string,
  to: string,
  contents: string,
  commitSha: string,
): Promise<void> {
  const open = await loadDraft(siteId, db, from);
  // Only a removed row can be at the new path — a rename takes a free name, and a delete is
  // what frees one before the build.
  await db.delete(drafts).where(and(eq(drafts.siteId, siteId), eq(drafts.path, to)));
  if (open)
    await db
      .update(drafts)
      .set({ path: to, baseSha: commitSha })
      .where(and(eq(drafts.siteId, siteId), eq(drafts.path, from)));
  else
    await db.insert(drafts).values({
      siteId,
      path: to,
      contents,
      baseSha: commitSha,
      baseBlob: await blobSha(contents),
      updatedAt: Date.now(),
      publishedSha: commitSha,
    });
  await recordDelete(siteId, db, from, commitSha);
}

/**
 * The rows the entry list lays over the built index, dropping the ones the build has caught up
 * with on the way: what a rename or a delete leaves behind is about a path being there or not,
 * so the index having it is the whole test.
 */
export async function overlayRows(
  siteId: string,
  db: Db,
  index: ContentIndex,
): Promise<ContentFile[]> {
  const rows = await db.select().from(drafts).where(eq(drafts.siteId, siteId));
  const settled = rows.filter(
    (r) => r.publishedSha && indexHasPath(index, r.path) === (r.contents !== ''),
  );
  if (settled.length)
    await db.delete(drafts).where(
      and(
        eq(drafts.siteId, siteId),
        inArray(
          drafts.path,
          settled.map((r) => r.path),
        ),
      ),
    );
  return rows.filter((r) => !settled.includes(r)).map(({ path, contents }) => ({ path, contents }));
}

/** Throw away the unpublished edits for one path; a deleted entry must not come back. */
export async function discardDraft(siteId: string, db: Db, path: string): Promise<void> {
  await db.delete(drafts).where(and(eq(drafts.siteId, siteId), eq(drafts.path, path)));
}

/**
 * Drafts whose stored bytes differ from the file they were loaded from, newest first. A row a
 * commit left behind is not one: it is what the repository already holds.
 */
export async function pendingDrafts(siteId: string, db: Db): Promise<Draft[]> {
  const rows = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.siteId, siteId), isNull(drafts.publishedSha)));
  const pending = await Promise.all(
    rows.map(async (r) => (await blobSha(r.contents)) !== r.baseBlob),
  );
  return rows.filter((_, i) => pending[i]).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A file someone changed in the repository after the editor loaded it. */
export class DraftConflictError extends Error {
  override name = 'DraftConflictError';
  constructor(readonly paths: string[]) {
    super(`Changed in the repository since they were opened: ${paths.join(', ')}`);
  }
}

const commitMessage = (paths: string[]) =>
  paths.length === 1 && paths[0]
    ? `Update ${paths[0].replace(/^src\/content\//, '').replace(/\.[^.]+$/, '')}`
    : `Update ${paths.length} files\n\n${paths.map((p) => `- ${p}`).join('\n')}`;

/**
 * Commit every pending draft as one commit and clear those rows. The parent is HEAD, so
 * `base_blob` is what says whether a draft is still safe to write: it is the file as the
 * editor loaded it, and a file that has moved on since is somebody else's work. One
 * mismatch refuses the whole set — the ref update is all-or-nothing anyway.
 */
export async function publishDrafts(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead' | 'publish'>,
): Promise<{ commit_sha: string; paths: string[] } | undefined> {
  const rows = await pendingDrafts(siteId, db);
  if (!rows.length) return undefined;
  const base_sha = await git.getHead();
  const changed = await Promise.all(
    rows.map(async (r) =>
      ((await git.getFile(r.path))?.blob_sha ?? '') === r.baseBlob ? '' : r.path,
    ),
  );
  const conflicts = changed.filter(Boolean);
  if (conflicts.length) throw new DraftConflictError(conflicts);
  const paths = rows.map((r) => r.path);
  const { commit_sha } = await git.publish(
    rows.map(({ path, contents }) => ({ path, contents })),
    { base_sha, message: commitMessage(paths) },
  );
  await db.delete(drafts).where(and(eq(drafts.siteId, siteId), inArray(drafts.path, paths)));
  return { commit_sha, paths };
}
