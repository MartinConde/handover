import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  applyDrift,
  type DriftChoice,
  markTranslation,
  mergeEntry,
  parseEntry,
  stringifyEntry,
  syncLocale,
} from './content.js';
import { type ContentFile, type ContentIndex, indexHasPath } from './entries.js';
import { blobSha, type GitClient } from './git.js';
import type { RedirectRule } from './lifecycle.js';
import type { Form } from './schema.js';

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

/**
 * Bumped whenever a table above changes. `handover db generate` records it in
 * `migrations/handover.json`; the build refuses to go out with a stale one, so a package
 * upgrade that forgot to generate fails there rather than at the first query.
 */
export const SCHEMA_VERSION = 1;

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

/** The entry's other languages, so one save can keep their structure in step with this one. */
export interface LocaleSync {
  form: Form;
  /** The language the form was drawn from. */
  locale: string;
  /** The entry's other languages, locale → path. Empty on a save of a translation. */
  siblings: Record<string, string>;
  /**
   * This save is of a language the entry is translated into. Only the values that language
   * owns are taken from it and the structure is the file's own, so a browser cannot move a
   * block, change a shared value or add a field the default language keeps to itself.
   */
  translation?: boolean;
}

/**
 * One autosave. `base_*` are read from git the first time a row is written and never sent
 * by the browser — a tab left open across someone else's publish would report a stale base.
 * `undefined` when the path is not in the repo.
 *
 * With `sync`, the entry's other languages are brought into line with the structure this save
 * has and written in the same batch: a block added, removed or moved is one edit to every
 * language. A save that touched neither the structure nor a shared value does not touch them
 * at all, and a language the entry has no file in is not created here — that is Create from
 * English, further along.
 *
 * With `sync.translation`, this is a save of one of those other languages instead: it writes
 * that language's own words into its own file and nothing else moves.
 */
export async function saveDraft(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  path: string,
  values: Record<string, unknown>,
  sync?: LocaleSync,
): Promise<{ updated_at: number; pending: boolean } | undefined> {
  const loaded = await load(siteId, db, git, path);
  if (!loaded) return undefined;
  const before = loaded.entry;
  const translated = sync?.translation ? sync.form : undefined;
  const after = mergeEntry(siteId, before, values, translated);
  const edit = { before, after };
  const updatedAt = Date.now();
  const contents = stringifyEntry(
    siteId,
    sync && !translated ? syncLocale(siteId, sync.form, sync.locale, edit, after) : after,
  );
  const writes = [upsert(db, siteId, path, contents, loaded, updatedAt)];
  // A translation changes no structure, so the other languages have nothing to follow.
  for (const [locale, sibling] of Object.entries(translated ? {} : (sync?.siblings ?? {}))) {
    if (!sync) break;
    const projection = (data: unknown) => skeleton(siteId, sync.form, locale, data);
    if (projection(before) === projection(after)) continue;
    const other = await load(siteId, db, git, sibling);
    if (!other) continue;
    const synced = syncLocale(siteId, sync.form, locale, edit, other.entry);
    writes.push(upsert(db, siteId, sibling, stringifyEntry(siteId, synced), other, updatedAt));
  }
  // One batch: an entry's languages reach the drafts table together or not at all.
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
  return { updated_at: updatedAt, pending: (await blobSha(contents)) !== loaded.baseBlob };
}

/**
 * The answers to one entry's drift, written to every language they change in one batch. A
 * `saveDraft` cannot make this write: it carries the default language's values and has no way
 * to say a block comes out of German. The languages an answer leaves alone are not written at
 * all, so reconciling one block does not make every file of the entry pending.
 *
 * `files` is the entry's languages that have a file, locale → path; nothing is created here.
 */
export async function resolveDrift(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  form: Form,
  locales: string[],
  files: Record<string, string>,
  choices: DriftChoice[],
): Promise<void> {
  const found = await Promise.all(
    Object.entries(files).map(async ([locale, path]) => {
      const loaded = await load(siteId, db, git, path);
      return loaded && { locale, path, loaded };
    }),
  );
  const open = found.filter((f) => f !== undefined);
  const before = Object.fromEntries(open.map((f) => [f.locale, f.loaded.entry]));
  const after = applyDrift(siteId, form, locales, before, choices);
  const updatedAt = Date.now();
  const writes = open.flatMap(({ locale, path, loaded }) => {
    const contents = stringifyEntry(siteId, after[locale]);
    return contents === stringifyEntry(siteId, before[locale])
      ? []
      : [upsert(db, siteId, path, contents, loaded, updatedAt)];
  });
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
}

/**
 * The languages one entry is offered in, written into every file it has. A language nobody
 * offers it in gets no file, so the decision has to live in the files there are — the site
 * builds from git alone, and the entry list has to read it long after the browser that made it
 * has gone. `locales` is the site's declared languages: an entry offered in all of them carries
 * no mark at all, the same rule a block's `_locales` follows.
 */
export async function setEntryLocales(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  paths: string[],
  offered: string[],
  locales: string[],
): Promise<void> {
  const found = await Promise.all(
    paths.map(async (path) => {
      const loaded = await load(siteId, db, git, path);
      return loaded && { path, loaded };
    }),
  );
  const kept = locales.filter((l) => offered.includes(l));
  const updatedAt = Date.now();
  const writes = found.flatMap((f) => {
    if (!f) return [];
    const entry = { ...(f.loaded.entry as Record<string, unknown>) };
    if (kept.length === locales.length) delete entry._locales;
    else entry._locales = kept;
    const contents = stringifyEntry(siteId, entry);
    return contents === stringifyEntry(siteId, f.loaded.entry)
      ? []
      : [upsert(db, siteId, f.path, contents, f.loaded, updatedAt)];
  });
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
}

// A file as the editor has it: its open draft, or the repository when there is none.
async function load(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  path: string,
) {
  const row = await loadDraft(siteId, db, path);
  if (row)
    return {
      open: true,
      baseSha: row.baseSha,
      baseBlob: row.baseBlob,
      entry: parseEntry(siteId, row.contents),
    };
  const [file, head] = await Promise.all([git.getFile(path), git.getHead()]);
  if (!file) return undefined;
  return {
    open: false,
    baseSha: head,
    baseBlob: file.blob_sha,
    entry: parseEntry(siteId, file.contents),
  };
}

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

// The base moves only when it was just read from git — a row the editor is working on keeps
// the one it was loaded against, and the row a delete left has none worth keeping.
function upsert(
  db: Db,
  siteId: string,
  path: string,
  contents: string,
  { open, baseSha, baseBlob }: Loaded,
  updatedAt: number,
) {
  return db
    .insert(drafts)
    .values({ siteId, path, contents, baseSha, baseBlob, updatedAt })
    .onConflictDoUpdate({
      target: [drafts.siteId, drafts.path],
      set: open
        ? { contents, updatedAt, publishedSha: null }
        : { contents, baseSha, baseBlob, updatedAt, publishedSha: null },
    });
}

// What a save of one language would put in another, values it does not own left out: two of
// these being equal is what says the other languages have nothing to write.
const skeleton = (siteId: string, form: Form, locale: string, data: unknown) =>
  stringifyEntry(siteId, syncLocale(siteId, form, locale, { before: data, after: data }, {}));

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
    super(
      paths.length === 1
        ? `${paths[0]} changed in the repository after it was opened`
        : `${paths.length} files changed in the repository after they were opened — ${paths.join(', ')}`,
    );
  }
}

const commitMessage = (paths: string[]) =>
  paths.length === 1 && paths[0]
    ? `Update ${paths[0].replace(/^src\/content\//, '').replace(/\.[^.]+$/, '')}`
    : `Update ${paths.length} files\n\n${paths.map((p) => `- ${p}`).join('\n')}`;

/**
 * Which language a file was translated from, for the publish about to commit it: that
 * language's name, its own file of the same entry and the form that says which of its values a
 * translation is made from. Nothing for the source language's own file, for a path no
 * collection owns, or on a site that declares one language.
 */
export type SourceOf = (path: string) => { locale: string; path: string; form: Form } | undefined;

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
  sourceOf?: SourceOf,
): Promise<{ commit_sha: string; paths: string[] } | undefined> {
  const rows = await pendingDrafts(siteId, db);
  if (!rows.length) return undefined;
  const base_sha = await git.getHead();
  const current = await Promise.all(rows.map((r) => git.getFile(r.path)));
  const conflicts = rows
    .filter((r, i) => (current[i]?.blob_sha ?? '') !== r.baseBlob)
    .map((r) => r.path);
  if (conflicts.length) throw new DraftConflictError(conflicts);
  const paths = rows.map((r) => r.path);
  const files = await Promise.all(
    rows.map(async ({ path, contents }, i) => {
      const source = sourceOf?.(path);
      if (!source || source.path === path) return { path, contents };
      // The source language as this commit leaves it: its own draft where the same publish is
      // writing one, and the repository where it is not.
      const drafted = rows.find((r) => r.path === source.path)?.contents;
      const file = drafted
        ? { contents: drafted, blob_sha: await blobSha(drafted) }
        : await git.getFile(source.path);
      if (!file) return { path, contents };
      const marked = await markTranslation(
        siteId,
        source.form,
        { locale: source.locale, ...file },
        contents,
        current[i]?.contents,
      );
      return { path, contents: marked };
    }),
  );
  const { commit_sha } = await git.publish(files, { base_sha, message: commitMessage(paths) });
  await db.delete(drafts).where(and(eq(drafts.siteId, siteId), inArray(drafts.path, paths)));
  return { commit_sha, paths };
}
