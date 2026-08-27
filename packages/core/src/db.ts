import { and, eq, gt, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  applyDrift,
  type DriftChoice,
  markTranslation,
  mergeEntry,
  offeredEntry,
  parseEntry,
  stringifyEntry,
  syncLocale,
  writtenEntry,
} from './content.js';
import { type ContentFile, type ContentIndex, entryKey, indexHasPath } from './entries.js';
import { blobSha, type GitClient, type PublishFile } from './git.js';
import {
  appendRedirects,
  REDIRECTS,
  type RedirectRule,
  redirectRule,
  revertRedirects,
} from './lifecycle.js';
import {
  type Answer,
  applyResolution,
  conflictReport,
  type MergedChange,
  type Question,
  type ThreeWay,
} from './resolve.js';
import type { Form } from './schema.js';
import { drafts, locks, user } from './tables.js';
import { machineFilled } from './translate.js';

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

/** One entry's conflict as it was read: the three sides, and the questions they raise. */
export interface EntryConflict {
  head: string;
  sides: Record<string, ThreeWay>;
  /** locale → the path and the blob HEAD has it at, for the languages that moved. */
  conflicted: Record<string, { path: string; blob: string }>;
  questions: Question[];
  merged: MergedChange[];
}

/**
 * The three sides of one entry, read at the one commit the answer will be written against:
 * the file each draft row was loaded from, the row itself, and the file at HEAD. A language
 * with no draft is read too — its file stands for all three — because a value every language
 * shares is only shared while its files agree.
 *
 * `undefined` when no file of the entry has moved in the repository since it was opened, which
 * is the drawer asking about an entry whose conflict somebody has already settled.
 */
export async function entryConflict(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  form: Form,
  files: Record<string, string>,
): Promise<EntryConflict | undefined> {
  const head = await git.getHead();
  const read = await Promise.all(
    Object.entries(files).map(async ([locale, path]) => {
      const row = await loadDraft(siteId, db, path);
      const at = await git.getFile(path, head);
      const was = row?.baseSha === head ? at : await git.getFile(path, row?.baseSha ?? head);
      if (!row && !at) return undefined;
      return {
        locale,
        path,
        blob: at?.blob_sha ?? '',
        moved: Boolean(row) && (at?.blob_sha ?? '') !== row?.baseBlob,
        side: {
          base: parseEntry(siteId, was?.contents ?? ''),
          ours: parseEntry(siteId, row?.contents ?? at?.contents ?? ''),
          theirs: parseEntry(siteId, at?.contents ?? ''),
        },
      };
    }),
  );
  const found = read.filter((f) => f !== undefined);
  if (!found.some((f) => f.moved)) return undefined;
  const sides = Object.fromEntries(found.map((f) => [f.locale, f.side]));
  return {
    head,
    sides,
    conflicted: Object.fromEntries(
      found.filter((f) => f.moved).map((f) => [f.locale, { path: f.path, blob: f.blob }]),
    ),
    ...conflictReport(siteId, form, sides),
  };
}

/**
 * The answers to one entry's conflict, written to the languages the repository moved under.
 * **The row's base becomes the file at HEAD** — the commit and that file's blob — because the
 * whole point of an answer is that the draft is now measured against what is there rather than
 * against what was there when it was opened. Its contents are the merge, so a resolution that
 * happens to reproduce the repository's file exactly leaves the drawer on its own.
 *
 * It takes the conflict that was read rather than reading it again: holding the answers to the
 * questions is the caller's, and re-reading git between the two would be a different report.
 */
export async function resolveConflict(
  siteId: string,
  db: Db,
  form: Form,
  conflict: EntryConflict,
  answers: Answer[],
): Promise<{ paths: string[] }> {
  const resolved = applyResolution(siteId, form, conflict.sides, answers);
  const updatedAt = Date.now();
  const writes = Object.entries(conflict.conflicted).map(([locale, { path, blob }]) =>
    db
      .update(drafts)
      .set({
        contents: stringifyEntry(siteId, writtenEntry(siteId, resolved[locale], form.fields)),
        baseSha: conflict.head,
        baseBlob: blob,
        publishedSha: null,
        updatedAt,
      })
      .where(and(eq(drafts.siteId, siteId), eq(drafts.path, path))),
  );
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
  return { paths: Object.values(conflict.conflicted).map((c) => c.path) };
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
  // Both sides stamped, so a file the answer leaves alone is not written for the stamp's sake.
  const writes = open.flatMap(({ locale, path, loaded }) => {
    const contents = stringifyEntry(siteId, writtenEntry(siteId, after[locale], form.fields));
    return contents === stringifyEntry(siteId, writtenEntry(siteId, before[locale], form.fields))
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
  const updatedAt = Date.now();
  const writes = found.flatMap((f) => {
    if (!f) return [];
    const contents = stringifyEntry(
      siteId,
      offeredEntry(siteId, f.loaded.entry, { offered, locales }),
    );
    return contents === stringifyEntry(siteId, writtenEntry(siteId, f.loaded.entry))
      ? []
      : [upsert(db, siteId, f.path, contents, f.loaded, updatedAt)];
  });
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
}

/**
 * The address one language serves an entry at: the `slug` key in that language's file, empty
 * taking the key back out and leaving the file name to serve it. One language, because the
 * others' URLs did not move.
 *
 * The redirect the change owes is **stored on the row rather than committed here**: the old
 * address is the live one until this is published, and a client who changes their mind twice
 * before publishing owes one rule, from what the repository has, and not two. `undefined`
 * clears it — an address put back the way it was owes nothing.
 */
export async function setEntryAddress(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  form: Form,
  path: string,
  address: string,
  redirect?: { from: string; to: string; entry: string },
): Promise<{ updated_at: number; pending: boolean } | undefined> {
  const loaded = await load(siteId, db, git, path);
  if (!loaded) return undefined;
  const entry = { ...(loaded.entry as Record<string, unknown>) };
  if (address) entry.slug = address;
  else delete entry.slug;
  // The form is the one the collection is read through, `slug` included: the address is not a
  // field somebody types into, but it is a key the schema declares and it goes where it says.
  const contents = stringifyEntry(siteId, writtenEntry(siteId, entry, form.fields));
  const updatedAt = Date.now();
  const rule = redirect
    ? redirectRule(
        siteId,
        {
          from: redirect.from,
          to: redirect.to,
          status: 301,
          reason: 'slug-change',
          entry: redirect.entry,
        },
        updatedAt,
      )
    : undefined;
  await db.batch([
    upsert(db, siteId, path, contents, loaded, updatedAt, {
      pendingRedirects: rule ? [rule] : null,
    }),
  ]);
  return { updated_at: updatedAt, pending: (await blobSha(contents)) !== loaded.baseBlob };
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
  // The head first and the file at it, rather than both at once: `base_sha` and `base_blob` are
  // one answer about one commit, and taking them from two reads of a moving branch is a conflict
  // on the next publish that nobody made — or none where somebody did.
  const head = await git.getHead();
  const file = await git.getFile(path, head);
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
  extra: { pendingRedirects?: RedirectRule[] | null } = {},
) {
  return db
    .insert(drafts)
    .values({ siteId, path, contents, baseSha, baseBlob, updatedAt, ...extra })
    .onConflictDoUpdate({
      target: [drafts.siteId, drafts.path],
      set: open
        ? { contents, updatedAt, publishedSha: null, ...extra }
        : { contents, baseSha, baseBlob, updatedAt, publishedSha: null, ...extra },
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
 * A file the commit that turned a language off rewrote while somebody had it open: the mark
 * naming the languages the entry is still offered in goes into their draft, which keeps its own
 * words, and the draft is rebased on that commit. Without this it would publish the language
 * back on, against a base blob that has moved. Nothing to do where there is no draft — the
 * repository already says it.
 */
export async function recordOffer(
  siteId: string,
  db: Db,
  path: string,
  committed: string,
  offer: { offered: string[]; locales: string[]; gone: string[] },
  commitSha: string,
): Promise<void> {
  const open = await loadDraft(siteId, db, path);
  if (!open) return;
  const entry = offeredEntry(siteId, parseEntry(siteId, open.contents), offer);
  await db
    .update(drafts)
    .set({
      contents: stringifyEntry(siteId, entry),
      baseSha: commitSha,
      baseBlob: await blobSha(committed),
    })
    .where(and(eq(drafts.siteId, siteId), eq(drafts.path, path)));
}

/**
 * The rows the entry list lays over the built index, dropping the ones the build has caught up
 * with on the way. Only a row that says a path has **gone** is dropped here: that much the
 * index answers on its own, since it is about the path being there or not. A row carrying bytes
 * the repository already has waits for the build status instead — clearing it the moment a
 * title agrees would let the next autosave take whatever HEAD is by then as its base, and
 * somebody else's commit would go in unnoticed.
 */
export async function overlayRows(
  siteId: string,
  db: Db,
  index: ContentIndex,
): Promise<ContentFile[]> {
  const rows = await db.select().from(drafts).where(eq(drafts.siteId, siteId));
  const settled = rows.filter(
    (r) => r.publishedSha && r.contents === '' && !indexHasPath(index, r.path),
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

/**
 * Every draft row as a file. What preview reads: a render is a GET, so it takes the rows as they
 * stand rather than through `overlayRows`, which tidies settled ones away as it goes.
 */
export async function draftFiles(siteId: string, db: Db): Promise<ContentFile[]> {
  const rows = await db.select().from(drafts).where(eq(drafts.siteId, siteId));
  return rows.map(({ path, contents }) => ({ path, contents }));
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

/**
 * "Not ready yet" on one entry, or off it. It is written to the languages the editor names,
 * and read back as the entry's: a hold set on the English file holds the German one too, which
 * is what stops a publish splitting an entry that is only half rewritten.
 */
export async function holdEntry(
  siteId: string,
  db: Db,
  paths: string[],
  heldBy: string | null,
): Promise<void> {
  await db
    .update(drafts)
    .set({ heldBy })
    .where(and(eq(drafts.siteId, siteId), inArray(drafts.path, paths)));
}

/**
 * The entries somebody is holding back, `"listings/mill-house"` → who marked it. Named here
 * rather than in the drawer, since the drawer is where somebody else reads it.
 */
export async function heldDrafts(
  siteId: string,
  db: Db,
): Promise<Record<string, { id: string; name: string | null }>> {
  const rows = await db
    .select({ path: drafts.path, heldBy: drafts.heldBy, name: user.name })
    .from(drafts)
    .leftJoin(user, eq(user.id, drafts.heldBy))
    .where(and(eq(drafts.siteId, siteId), isNotNull(drafts.heldBy)));
  return Object.fromEntries(
    rows.flatMap((row) => {
      const entry = entryKey(row.path);
      return entry && row.heldBy ? [[entry, { id: row.heldBy, name: row.name }] as const] : [];
    }),
  );
}

/**
 * What a publish commits. With nothing chosen it is every pending draft minus the files of an
 * entry somebody marked "Not ready yet"; with a chosen set it is the pending drafts of exactly
 * those entries, hold and all — picking a held entry is how a hold is released, and the entries
 * left out wait with their redirect rules, which are on their own rows.
 *
 * `entries` are entry keys, `"listings/mill-house"`: the unit of selection is the entry and
 * never the file, since one entry's languages share a structure and are committed together.
 */
export async function readyDrafts(
  siteId: string,
  db: Db,
  entries?: readonly string[],
): Promise<Draft[]> {
  const rows = await pendingDrafts(siteId, db);
  if (entries) {
    const chosen = new Set(entries);
    return rows.filter((row) => {
      const entry = entryKey(row.path);
      return entry !== undefined && chosen.has(entry);
    });
  }
  const held = await heldDrafts(siteId, db);
  return rows.filter((row) => {
    const entry = entryKey(row.path);
    return !entry || !(entry in held);
  });
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
 *
 * It answers late because the language an entry is written in is the entry's own — which file
 * it has, not which language the site defaults to — and that is something to go and look up.
 */
export type SourceOf = (
  path: string,
) => Promise<{ locale: string; path: string; form: Form } | undefined>;

/**
 * Commit drafts as one commit and re-seed those rows on it. With no `entries` that is every
 * pending draft an entry on hold is not keeping back; with them it is the chosen entries,
 * whose holds this publish releases. The parent is HEAD, so
 * `base_blob` is what says whether a draft is still safe to write: it is the file as the
 * editor loaded it, and a file that has moved on since is somebody else's work. One
 * mismatch refuses the whole set — the ref update is all-or-nothing anyway.
 *
 * **The rows are re-seeded rather than deleted**, on the bytes the commit actually wrote: a
 * translation is stamped on the way past, so seeding from what the row stored would report a
 * conflict with this very publish next time. `published_sha` is what then keeps them out of
 * the drawer and out of the next commit, and what says an editor whose tab is still open
 * keeps the base this publish gave them rather than silently taking whatever HEAD is by then.
 */
export async function publishDrafts(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead' | 'publish'>,
  sourceOf?: SourceOf,
  entries?: readonly string[],
): Promise<{ commit_sha: string; paths: string[]; released: string[] } | undefined> {
  const rows = await readyDrafts(siteId, db, entries);
  if (!rows.length) return undefined;
  const base_sha = await git.getHead();
  // Every read of this publish is of the commit it is made against, so what the conflict check
  // compares and what the commit's parent is are the same repository.
  const current = await Promise.all(rows.map((r) => git.getFile(r.path, base_sha)));
  const conflicts = rows
    .filter((r, i) => (current[i]?.blob_sha ?? '') !== r.baseBlob)
    .map((r) => r.path);
  if (conflicts.length) throw new DraftConflictError(conflicts);
  const paths = rows.map((r) => r.path);
  const written = await Promise.all(
    rows.map(async ({ path, contents }, i) => {
      const source = await sourceOf?.(path);
      if (!source || source.path === path) return { path, contents };
      // The source language as this commit leaves it: its own draft where the same publish is
      // writing one, and the repository where it is not.
      const drafted = rows.find((r) => r.path === source.path)?.contents;
      const file = drafted
        ? { contents: drafted, blob_sha: await blobSha(drafted) }
        : await git.getFile(source.path, base_sha);
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
  const files: PublishFile[] = [...written];
  // What the address changes in this set owe. Appended here rather than committed when the
  // address was typed: the old URL is live until now, and one commit carries both. The rules of
  // an entry nobody chose are on its own rows and wait there with it.
  const rules = rows.flatMap((r) => r.pendingRedirects ?? []);
  if (rules.length) files.push(await appendRedirects(siteId, git, rules, base_sha));
  const { commit_sha } = await git.publish(files, { base_sha, message: commitMessage(paths) });
  // The blobs first: a drizzle statement is thenable, so awaiting anything beside one inside
  // the map would run it there instead of in the batch.
  const seeded = await Promise.all(
    written.map(async (file) => ({ ...file, blob: await blobSha(file.contents) })),
  );
  const writes = seeded.map(({ path, contents, blob }) =>
    db
      .update(drafts)
      .set({
        contents,
        baseSha: commit_sha,
        baseBlob: blob,
        publishedSha: commit_sha,
        // A hold this publish went through is over: the entry it was keeping back is out.
        heldBy: null,
        // The rules are in the commit now; leaving them on the row writes them again.
        pendingRedirects: null,
      })
      .where(and(eq(drafts.siteId, siteId), eq(drafts.path, path))),
  );
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
  const released = [
    ...new Set(rows.filter((r) => r.heldBy).flatMap((r) => entryKey(r.path) ?? [])),
  ];
  return { commit_sha, paths, released };
}

/**
 * A machine's answers in one language's file. Not a `saveDraft`: that one writes what a form
 * sent back, and this is neither the form's values nor anything a person typed — the paths it
 * fills go into `_machine`, and stay there until somebody types over them.
 *
 * `undefined` when that language has no file; a fill only ever follows a file that is there.
 */
export async function saveTranslated(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  path: string,
  filled: Record<string, string>,
): Promise<{ updated_at: number; pending: boolean } | undefined> {
  const loaded = await load(siteId, db, git, path);
  if (!loaded) return undefined;
  const contents = stringifyEntry(siteId, machineFilled(siteId, loaded.entry, filled));
  const updatedAt = Date.now();
  await db.batch([upsert(db, siteId, path, contents, loaded, updatedAt)]);
  return { updated_at: updatedAt, pending: (await blobSha(contents)) !== loaded.baseBlob };
}

/** A file the revert would write has changed since the commit it is undoing. */
export class RevertConflictError extends Error {
  override name = 'RevertConflictError';
  constructor(readonly paths: string[]) {
    super(
      paths.length === 1
        ? `${paths[0]} has changed since that commit, so it cannot be put back`
        : `${paths.length} files have changed since that commit, so they cannot be put back — ${paths.join(', ')}`,
    );
  }
}

/**
 * One commit undone, as a commit of its own. **Not `git revert`**: the trees API has no
 * three-way merge to run, so the inverse is composed here — every entry file the commit touched
 * goes back to the bytes its blob had at the parent, and a file the commit created is removed.
 * A rename counts as both of its names, so the old one comes back as the new one goes.
 *
 * A file that has **moved on since** is refused rather than overwritten: putting it back would
 * be undoing somebody else's work as well, and the whole set is refused because the ref update
 * is all-or-nothing anyway. `redirects.yaml` is the one exception, recomputed rather than
 * restored ([`revertRedirects`](./lifecycle.ts)) — rules appended since have to stay.
 *
 * Every row at a path this writes is rebased on the revert with `published_sha` nulled, so the
 * changes the commit carried are unpublished again — which is what the confirmation promises.
 * A row that says a path has **gone** while the revert puts the file back is dropped instead:
 * the entry reads from the repository again.
 */
export async function revertCommit(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getCommit' | 'getFile' | 'getHead' | 'publish'>,
  commitSha: string,
): Promise<{ commit_sha: string; paths: string[] }> {
  const commit = await git.getCommit(commitSha);
  const parent = commit.parent;
  if (!parent) throw new Error(`${commitSha} has no commit before it to go back to`);
  const head = await git.getHead();
  const paths = commit.paths.filter((p) => p !== REDIRECTS);
  const [then, now, before] = await Promise.all([
    Promise.all(paths.map((p) => git.getFile(p, commitSha))),
    Promise.all(paths.map((p) => git.getFile(p, head))),
    Promise.all(paths.map((p) => git.getFile(p, parent))),
  ]);
  const moved = paths.filter((_, i) => (now[i]?.blob_sha ?? '') !== (then[i]?.blob_sha ?? ''));
  if (moved.length) throw new RevertConflictError(moved);
  const files: PublishFile[] = paths.map((path, i) => ({
    path,
    contents: before[i]?.contents ?? null,
  }));
  const rules = await revertRedirects(siteId, git, { commit: commitSha, parent, head });
  const { commit_sha } = await git.publish(rules ? [...files, rules] : files, {
    base_sha: head,
    message: `Revert "${commit.message.split('\n')[0]}"\n\nThis reverts commit ${commit.sha}.`,
  });
  const rows = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.siteId, siteId), inArray(drafts.path, paths)));
  // The blobs first: a drizzle statement is thenable, so awaiting one inside the map below
  // would run it there instead of in the batch.
  const rebased = await Promise.all(
    rows.map(async (row) => {
      const restored = files.find((f) => f.path === row.path)?.contents ?? null;
      return {
        path: row.path,
        gone: row.contents === '' && restored !== null,
        blob: restored === null ? '' : await blobSha(restored),
      };
    }),
  );
  const writes = rebased.map(({ path, gone, blob }) => {
    const where = and(eq(drafts.siteId, siteId), eq(drafts.path, path));
    return gone
      ? db.delete(drafts).where(where)
      : db
          .update(drafts)
          .set({ baseSha: commit_sha, baseBlob: blob, publishedSha: null })
          .where(where);
  });
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
  return { commit_sha, paths: files.map((f) => f.path) };
}

/**
 * The rows the build carrying them is now serving, dropped. **Green is not enough**: a row is
 * also what an open tab publishes against, so an entry somebody is still editing keeps its row
 * until their lock runs out and the next reading of the build takes it. A row that says a path
 * has **gone** is not here either — the entry list drops those against the index it can see
 * ([`overlayRows`](#)), and taking one away before the new bundle is serving would put the
 * deleted entry back in the list.
 */
export async function clearPublished(
  siteId: string,
  db: Db,
  commitSha: string,
  now = Date.now(),
): Promise<string[]> {
  const rows = await db
    .select({ path: drafts.path })
    .from(drafts)
    .where(
      and(eq(drafts.siteId, siteId), eq(drafts.publishedSha, commitSha), ne(drafts.contents, '')),
    );
  if (!rows.length) return [];
  const editing = new Set(
    (
      await db
        .select({ entry: locks.entry })
        .from(locks)
        .where(and(eq(locks.siteId, siteId), gt(locks.expiresAt, now)))
    ).map((l) => l.entry),
  );
  // Rows are paths and locks are entries, so the two only meet through the entry a path is of.
  const clear = rows.flatMap(({ path }) => {
    const entry = entryKey(path);
    return entry && editing.has(entry) ? [] : [path];
  });
  if (clear.length)
    await db.delete(drafts).where(and(eq(drafts.siteId, siteId), inArray(drafts.path, clear)));
  return clear;
}
