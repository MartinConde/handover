import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
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
  RevertConflictError,
  redirectRule,
  revertRedirects,
} from './lifecycle.js';
import { isLive } from './reserved.js';
import {
  type Answer,
  applyResolution,
  conflictReport,
  type MergedChange,
  type Question,
  type ThreeWay,
} from './resolve.js';
import type { Form } from './schema.js';
import { activity, drafts, locks, pathReservations, user } from './tables.js';
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

/** Published empty rows are deletion markers; an unpublished empty file can still be edited. */
export function loadDraft(siteId: string, db: Db, path: string): Promise<Draft | undefined> {
  return db.query.drafts.findFirst({
    where: and(
      eq(drafts.siteId, siteId),
      eq(drafts.path, path),
      or(ne(drafts.contents, ''), isNull(drafts.publishedSha)),
    ),
  });
}

/** A stale writer must retain its local edits and reload/reconcile before retrying. */
export class DraftRevisionError extends Error {
  override name = 'DraftRevisionError';
  constructor() {
    super(
      'This entry changed while you were editing. Your changes are not saved; keep them before reloading.',
    );
  }
}

/** D1 rolls the entire batch back on a failed revision/reservation assertion. */
export function isDraftRace(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  return /NOT NULL constraint failed: (drafts.revision|path_reservations.token)|UNIQUE constraint failed: path_reservations/.test(
    message,
  );
}

/** Seed precisely the immutable file shown on GET; concurrent opens share the winning row. */
export async function openDraft(
  siteId: string,
  db: Db,
  path: string,
  head: string,
  file: { contents: string; blob_sha: string } | undefined,
): Promise<Draft | undefined> {
  if (file)
    await db
      .insert(drafts)
      .values({
        siteId,
        path,
        revision: sql`case when not exists (select 1 from path_reservations where site_id = ${siteId} and path = ${path}) then ${crypto.randomUUID()} else null end`,
        contents: file.contents,
        baseSha: head,
        baseBlob: file.blob_sha,
        updatedAt: Date.now(),
      })
      .onConflictDoNothing();
  return loadDraft(siteId, db, path);
}

/** Reserve every locale destination together, refusing both drafts and other reservations. */
export async function reservePaths(siteId: string, db: Db, paths: string[]): Promise<string> {
  const token = crypto.randomUUID();
  const writes = paths.map((path) =>
    db.insert(pathReservations).values({
      siteId,
      path,
      token: sql`case when not exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and (contents <> '' or published_sha is null)) then ${token} else null end`,
    }),
  );
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
  return token;
}
export async function releasePaths(siteId: string, db: Db, token: string): Promise<void> {
  await db
    .delete(pathReservations)
    .where(and(eq(pathReservations.siteId, siteId), eq(pathReservations.token, token)));
}

/** The entry's other languages, so one save can keep their structure in step with this one. */
export interface LocaleSync {
  form: Form;
  /** The language the form was drawn from. */
  locale: string;
  /** locale → path of the entry's other languages; empty on a save of a translation. */
  siblings: Record<string, string>;
  /** A translation's save takes only the values its language owns, never the structure. */
  translation?: boolean;
}

/** Every write re-asserts the revision in SQL, synced siblings included. */
export async function saveDraft(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  path: string,
  values: Record<string, unknown>,
  sync?: LocaleSync,
  /** Whoever typed this, for the *last edited by* line; nothing where a route has no session. */
  by?: string,
  expectedRevision?: string,
): Promise<
  | { updated_at: number; pending: boolean; revision: string; revisions: Record<string, string> }
  | undefined
> {
  const loaded = await load(siteId, db, git, path);
  if (!loaded) return undefined;
  if (expectedRevision !== undefined && loaded.revision !== expectedRevision)
    throw new DraftRevisionError();
  const revision = crypto.randomUUID();
  const revisions: Record<string, string> = {
    [sync?.locale ?? path.split('/').at(-2) ?? '']: revision,
  };
  const before = loaded.entry;
  const translated = sync?.translation ? sync.form : undefined;
  const after = mergeEntry(siteId, before, values, translated);
  const edit = { before, after };
  const updatedAt = Date.now();
  const contents = stringifyEntry(
    siteId,
    sync && !translated ? syncLocale(siteId, sync.form, sync.locale, edit, after) : after,
  );
  const stamp = { ...stampOf(by), revision };
  const writes = [upsert(db, siteId, path, contents, loaded, updatedAt, stamp)];
  // A translation changes no structure, so the other languages have nothing to follow.
  for (const [locale, sibling] of Object.entries(translated ? {} : (sync?.siblings ?? {}))) {
    if (!sync) break;
    const projection = (data: unknown) => skeleton(siteId, sync.form, locale, data);
    if (projection(before) === projection(after)) continue;
    const other = await load(siteId, db, git, sibling);
    if (!other) continue;
    const synced = syncLocale(siteId, sync.form, locale, edit, other.entry);
    const siblingRevision = crypto.randomUUID();
    revisions[locale] = siblingRevision;
    writes.push(
      upsert(db, siteId, sibling, stringifyEntry(siteId, synced), other, updatedAt, {
        ...stamp,
        revision: siblingRevision,
      }),
    );
  }
  // One batch: an entry's languages reach the drafts table together or not at all.
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
  return {
    updated_at: updatedAt,
    pending: (await blobSha(contents)) !== loaded.baseBlob,
    revision,
    revisions,
  };
}

/** One entry's conflict as it was read: the three sides, and the questions they raise. */
export interface EntryConflict {
  head: string;
  version?: string;
  snapshots?: { path: string; revision?: string }[];
  sides: Record<string, ThreeWay>;
  /** locale → the path and the blob HEAD has it at, for the languages that moved. */
  conflicted: Record<string, { path: string; blob: string; revision?: string }>;
  questions: Question[];
  merged: MergedChange[];
}

/** Languages with no draft are read too: a shared value is only shared while its files agree. */
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
        revision: row?.revision,
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
    version: await blobSha(JSON.stringify({ head, files: read })),
    snapshots: Object.values(files).map((path) => ({
      path,
      revision: found.find((f) => f.path === path)?.revision,
    })),
    sides,
    conflicted: Object.fromEntries(
      found
        .filter((f) => f.moved)
        .map((f) => [f.locale, { path: f.path, blob: f.blob, revision: f.revision }]),
    ),
    ...conflictReport(siteId, form, sides),
  };
}

/** The row's base becomes the file at HEAD: the draft is now measured against what is there. */
export async function resolveConflict(
  siteId: string,
  db: Db,
  form: Form,
  conflict: EntryConflict,
  answers: Answer[],
): Promise<{ paths: string[] }> {
  const resolved = applyResolution(siteId, form, conflict.sides, answers);
  const updatedAt = Date.now();
  const writes = Object.entries(conflict.conflicted).map(([locale, { path, blob, revision }]) =>
    db
      .update(drafts)
      .set({
        revision: sql`case when ${drafts.revision} = ${revision ?? ''} then ${crypto.randomUUID()} else null end`,
        contents: stringifyEntry(siteId, writtenEntry(siteId, resolved[locale], form.fields)),
        baseSha: conflict.head,
        baseBlob: blob,
        publishedSha: null,
        updatedAt,
      })
      .where(and(eq(drafts.siteId, siteId), eq(drafts.path, path))),
  );
  const [first, ...rest] = writes;
  if (first) {
    const anchor = Object.values(conflict.conflicted)[0];
    if (!anchor) return { paths: [] };
    const matches = sql.join(
      (conflict.snapshots ?? Object.values(conflict.conflicted)).map(({ path, revision }) =>
        revision === undefined
          ? sql`not exists (select 1 from drafts where site_id = ${siteId} and path = ${path})`
          : sql`exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and revision = ${revision})`,
      ),
      sql` and `,
    );
    // The insert's NOT NULL assertion runs even when its conflict handler leaves the row alone.
    const guard = db
      .insert(drafts)
      .values({
        siteId,
        path: anchor.path,
        contents: '',
        baseSha: '',
        baseBlob: '',
        updatedAt,
        revision: sql`case when ${matches} then ${anchor.revision ?? ''} else null end`,
      })
      .onConflictDoNothing();
    await db.batch([guard, first, ...rest]);
  }
  return { paths: Object.values(conflict.conflicted).map((c) => c.path) };
}

/** Not a saveDraft: that carries one language's values and cannot move a block out of German. */
export async function resolveDrift(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  form: Form,
  locales: string[],
  files: Record<string, string>,
  choices: DriftChoice[],
  by?: string,
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
      : [upsert(db, siteId, path, contents, loaded, updatedAt, stampOf(by))];
  });
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
}

/** In the files, since the site builds from git alone; offered everywhere means no mark at all. */
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

/** The redirect is stored on the row, not committed: the old address is live until publish. */
export async function setEntryAddress(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  form: Form,
  path: string,
  address: string,
  redirect?: { from: string; to: string; entry: string },
  by?: string,
): Promise<{ updated_at: number; pending: boolean } | undefined> {
  const loaded = await load(siteId, db, git, path);
  if (!loaded) return undefined;
  const entry = { ...(loaded.entry as Record<string, unknown>) };
  if (address) entry.slug = address;
  else delete entry.slug;
  // `slug` is a key the schema declares, so it goes where the form says.
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
  const rules = loaded.redirects.filter((r) => r.reason !== 'slug-change');
  if (rule) rules.push(rule);
  await db.batch([
    upsert(db, siteId, path, contents, loaded, updatedAt, {
      pendingRedirects: rules.length ? rules : null,
      ...stampOf(by),
    }),
  ]);
  return { updated_at: updatedAt, pending: (await blobSha(contents)) !== loaded.baseBlob };
}

/** Hide redirects are stored on the rows, not committed: the page is live until publish. */
export async function setEntryStatus(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  form: Form,
  files: readonly { path: string; redirect?: { from: string; to: string } }[],
  hidden: boolean,
  deps: { now?: () => number } = {},
): Promise<void> {
  const found = await Promise.all(
    files.map(async (file) => {
      const loaded = await load(siteId, db, git, file.path);
      return loaded && { ...file, loaded };
    }),
  );
  const updatedAt = deps.now?.() ?? Date.now();
  const writes = found.flatMap((file) => {
    if (!file) return [];
    const entry = { ...(file.loaded.entry as Record<string, unknown>) };
    if (hidden) entry._status = 'hidden';
    else delete entry._status;
    const rules = file.loaded.redirects.filter((rule) => rule.reason !== 'hidden');
    if (hidden && file.redirect)
      rules.push(
        redirectRule(
          siteId,
          {
            ...file.redirect,
            status: 301,
            reason: 'hidden',
            entry: entryKey(file.path),
          },
          updatedAt,
        ),
      );
    return [
      upsert(
        db,
        siteId,
        file.path,
        stringifyEntry(siteId, writtenEntry(siteId, entry, form.fields)),
        file.loaded,
        updatedAt,
        { pendingRedirects: rules.length ? rules : null },
      ),
    ];
  });
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
}

/** Each of these is owned by a route that commits redirect rules beside it. */
const KEPT_ON_RESTORE = ['slug', '_status', '_locales'] as const;

/** The base stays where it was, so the publish that follows is an ordinary forward commit. */
export async function restoreDraft(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  form: Form,
  files: readonly { path: string; entry: Record<string, unknown> }[],
  by?: string,
): Promise<{ paths: string[] }> {
  const found = await Promise.all(
    files.map(async (file) => {
      const loaded = await load(siteId, db, git, file.path);
      return loaded && { ...file, loaded };
    }),
  );
  const updatedAt = Date.now();
  const writes = found.flatMap((file) => {
    if (!file) return [];
    const now = (file.loaded.entry ?? {}) as Record<string, unknown>;
    // Assigned in place so a key the version also had keeps its position in the file.
    const entry = { ...file.entry };
    for (const key of KEPT_ON_RESTORE) {
      if (key in now) entry[key] = now[key];
      else delete entry[key];
    }
    const contents = stringifyEntry(siteId, writtenEntry(siteId, entry, form.fields));
    return [upsert(db, siteId, file.path, contents, file.loaded, updatedAt, stampOf(by))];
  });
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
  return { paths: found.filter((f) => f !== undefined).map((f) => f.path) };
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
      revision: row.revision,
      baseSha: row.baseSha,
      baseBlob: row.baseBlob,
      entry: parseEntry(siteId, row.contents),
      redirects: row.pendingRedirects ?? [],
    };
  // Head first, then the file at it: `base_sha` and `base_blob` must describe one commit.
  const head = await git.getHead();
  const file = await git.getFile(path, head);
  if (!file) return undefined;
  return {
    open: false,
    revision: undefined,
    baseSha: head,
    baseBlob: file.blob_sha,
    entry: parseEntry(siteId, file.contents),
    redirects: [] as RedirectRule[],
  };
}

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

// The base moves only when just read from git; an open row keeps the one it was loaded against.
function upsert(
  db: Db,
  siteId: string,
  path: string,
  contents: string,
  { open, baseSha, baseBlob, revision }: Loaded,
  updatedAt: number,
  extra: { pendingRedirects?: RedirectRule[] | null; updatedBy?: string; revision?: string } = {},
) {
  // A conditional UPDATE would silently succeed; violating NOT NULL aborts the whole D1 batch.
  const next = extra.revision ?? crypto.randomUUID();
  const matches = revision
    ? sql`exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and revision = ${revision})`
    : sql`not exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and (contents <> '' or published_sha is null))`;
  const asserted = sql<string>`case when ${matches} and not exists (select 1 from path_reservations where site_id = ${siteId} and path = ${path}) then ${next} else null end`;
  return db
    .insert(drafts)
    .values({ siteId, path, contents, baseSha, baseBlob, updatedAt, ...extra, revision: asserted })
    .onConflictDoUpdate({
      target: [drafts.siteId, drafts.path],
      set: {
        contents,
        ...(open ? {} : { baseSha, baseBlob }),
        updatedAt,
        publishedSha: null,
        ...extra,
        revision: next,
      },
    });
}

// A write with nobody signed in leaves the last name standing rather than blanking it.
const stampOf = (by?: string) => (by ? { updatedBy: by } : {});

// Two equal skeletons mean the other languages have nothing to write.
const skeleton = (siteId: string, form: Form, locale: string, data: unknown) =>
  stringifyEntry(siteId, syncLocale(siteId, form, locale, { before: data, after: data }, {}));

/** An empty base blob matches nothing in the repository, so the row is pending from the start. */
export async function createDraft(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getHead'>,
  path: string,
  values: Record<string, unknown>,
): Promise<{ updated_at: number }> {
  return createDrafts(siteId, db, git, [{ path, values }]);
}

/** All locale paths of a new entry are claimed in one transaction, including duplicates. */
export async function createDrafts(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getHead'>,
  files: readonly { path: string; values: Record<string, unknown> }[],
): Promise<{ updated_at: number }> {
  const updatedAt = Date.now();
  const baseSha = await git.getHead();
  const writes = files.map(({ path, values }) => {
    const contents = stringifyEntry(siteId, values);
    return (
      db
        .insert(drafts)
        .values({
          siteId,
          path,
          contents,
          baseSha,
          baseBlob: '',
          updatedAt,
          revision: sql`case when not exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and (contents <> '' or published_sha is null)) and not exists (select 1 from path_reservations where site_id = ${siteId} and path = ${path}) then lower(hex(randomblob(16))) else null end`,
        })
        // Only a removed row can be at this path: a name a live row holds is never picked again.
        .onConflictDoUpdate({
          target: [drafts.siteId, drafts.path],
          set: {
            contents,
            baseSha,
            baseBlob: '',
            updatedAt,
            publishedSha: null,
            pendingRedirects: null,
            heldBy: null,
            heldAt: null,
            updatedBy: null,
            revision: crypto.randomUUID(),
          },
        })
    );
  });
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
  return { updated_at: updatedAt };
}

/** The index lags the build, so an empty row says the path has gone until the build is live. */
export async function recordDelete(
  siteId: string,
  db: Db,
  path: string,
  commitSha: string,
): Promise<void> {
  const gone = {
    revision: crypto.randomUUID(),
    contents: '',
    baseSha: commitSha,
    baseBlob: '',
    updatedAt: Date.now(),
  };
  await db
    .insert(drafts)
    .values({ siteId, path, ...gone, publishedSha: commitSha })
    .onConflictDoUpdate({
      target: [drafts.siteId, drafts.path],
      set: { ...gone, publishedSha: commitSha },
    });
}

/** An open draft moves over: the commit carried its loaded bytes, so `base_blob` still holds. */
export async function recordRename(
  siteId: string,
  db: Db,
  from: string,
  to: string,
  contents: string,
  commitSha: string,
  by?: string,
): Promise<void> {
  const open = await loadDraft(siteId, db, from);
  // Only a removed row can be at the new path: a rename takes a free name.
  await db
    .delete(drafts)
    .where(and(eq(drafts.siteId, siteId), eq(drafts.path, to), eq(drafts.contents, '')));
  if (open)
    await db
      .update(drafts)
      .set({ path: to, baseSha: commitSha, ...stampOf(by) })
      .where(and(eq(drafts.siteId, siteId), eq(drafts.path, from)));
  else
    await db.insert(drafts).values({
      siteId,
      path: to,
      revision: crypto.randomUUID(),
      contents,
      baseSha: commitSha,
      baseBlob: await blobSha(contents),
      updatedAt: Date.now(),
      publishedSha: commitSha,
    });
  await recordDelete(siteId, db, from, commitSha);
}

/** Without this the open draft would publish the language back on against a moved base blob. */
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
      revision: sql`case when ${drafts.revision} = ${open.revision} then ${crypto.randomUUID()} else null end`,
      contents: stringifyEntry(siteId, entry),
      baseSha: commitSha,
      baseBlob: await blobSha(committed),
    })
    .where(and(eq(drafts.siteId, siteId), eq(drafts.path, path)));
}

/** Only gone rows are dropped; a row with bytes waits for the build so autosave keeps its base. */
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
    await db
      .delete(drafts)
      .where(
        and(
          eq(drafts.siteId, siteId),
          eq(drafts.contents, ''),
          or(
            ...settled.map((r) =>
              and(
                eq(drafts.path, r.path),
                eq(drafts.revision, r.revision),
                eq(drafts.publishedSha, r.publishedSha ?? ''),
              ),
            ),
          ),
        ),
      );
  return rows.filter((r) => !settled.includes(r)).map(({ path, contents }) => ({ path, contents }));
}

/** What preview reads: a render is a GET, so it does not tidy rows the way `overlayRows` does. */
export async function draftFiles(siteId: string, db: Db): Promise<ContentFile[]> {
  const rows = await db.select().from(drafts).where(eq(drafts.siteId, siteId));
  return rows.map(({ path, contents }) => ({ path, contents }));
}

/** A rename or delete is a commit then a D1 write; this must not race the second half. */
const ORPHAN_AGE = 24 * 60 * 60 * 1000;

/** An empty `base_blob` says the row was never a file, and those rows must survive this sweep. */
export async function sweepOrphans(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'> | undefined,
  now = Date.now(),
): Promise<number> {
  // A site whose App is not configured cannot be asked what the tree holds, so nothing is deleted.
  if (!git) return 0;
  const rows = await db
    .select({ path: drafts.path })
    .from(drafts)
    .where(
      and(
        eq(drafts.siteId, siteId),
        ne(drafts.baseBlob, ''),
        lt(drafts.updatedAt, now - ORPHAN_AGE),
      ),
    );
  if (!rows.length) return 0;
  // One commit for all of them, so a moving tree cannot split the answers across two repositories.
  const head = await git.getHead();
  const gone: string[] = [];
  for (const { path } of rows) if (!(await git.getFile(path, head))) gone.push(path);
  if (gone.length)
    await db.delete(drafts).where(and(eq(drafts.siteId, siteId), inArray(drafts.path, gone)));
  return gone.length;
}

/** Throw away the unpublished edits for one path; a deleted entry must not come back. */
export async function discardDraft(siteId: string, db: Db, path: string): Promise<void> {
  await db.delete(drafts).where(and(eq(drafts.siteId, siteId), eq(drafts.path, path)));
}

/** A row a commit left behind is not pending: it is what the repository already holds. */
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

/** Read back as the entry's: a hold on the English file holds the German one too. */
export async function holdEntry(
  siteId: string,
  db: Db,
  paths: string[],
  heldBy: string | null,
  now = Date.now(),
): Promise<void> {
  await db
    .update(drafts)
    .set({ heldBy, heldAt: heldBy ? now : null })
    .where(and(eq(drafts.siteId, siteId), inArray(drafts.path, paths)));
}

/** Named here rather than in the drawer, since the drawer is where somebody else reads it. */
export async function heldDrafts(
  siteId: string,
  db: Db,
): Promise<Record<string, { id: string; name: string | null; since: number | null }>> {
  const rows = await db
    .select({ path: drafts.path, heldBy: drafts.heldBy, heldAt: drafts.heldAt, name: user.name })
    .from(drafts)
    .leftJoin(user, eq(user.id, drafts.heldBy))
    .where(and(eq(drafts.siteId, siteId), isNotNull(drafts.heldBy)));
  return Object.fromEntries(
    rows.flatMap((row) => {
      const entry = entryKey(row.path);
      return entry && row.heldBy
        ? [[entry, { id: row.heldBy, name: row.name, since: row.heldAt }] as const]
        : [];
    }),
  );
}

/** One read with the name joined on, rather than the member list read to name one id. */
export async function draftEditors(siteId: string, db: Db): Promise<Record<string, string | null>> {
  const rows = await db
    .select({ path: drafts.path, name: user.name })
    .from(drafts)
    .leftJoin(user, eq(user.id, drafts.updatedBy))
    .where(and(eq(drafts.siteId, siteId), isNotNull(drafts.updatedBy)));
  return Object.fromEntries(rows.map((row) => [row.path, row.name]));
}

/** Picking a held entry releases its hold; the unit of selection is the entry, never the file. */
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

/** Async: the language an entry is written in is the entry's own, not the site's default. */
export type SourceOf = (
  path: string,
) => Promise<{ locale: string; path: string; form: Form } | undefined>;

/** Rows are re-seeded on the committed bytes: a translation is stamped on the way past. */
export async function publishDrafts(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead' | 'publish'>,
  sourceOf?: SourceOf,
  entries?: readonly string[],
  snapshot?: readonly Draft[],
): Promise<{ commit_sha: string; paths: string[]; released: string[] } | undefined> {
  const rows = snapshot ?? (await readyDrafts(siteId, db, entries));
  if (!rows.length) return undefined;
  const base_sha = await git.getHead();
  // Every read is of the commit the publish is made against, so the check and the parent agree.
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
      // The source language as this commit leaves it: its own draft if this publish writes one.
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
  // A moved but hidden page never served its pending address, so it owes no slug-change redirect.
  const rules = rows.flatMap((r) =>
    (r.pendingRedirects ?? []).filter(
      (rule) => rule.reason !== 'slug-change' || isLive(siteId, parseEntry(siteId, r.contents)),
    ),
  );
  // An entry this commit puts back on the site takes its hide rules with it.
  const back = new Set(
    rows.flatMap((r, i) =>
      current[i] &&
      !isLive(siteId, parseEntry(siteId, current[i]?.contents ?? '')) &&
      isLive(siteId, parseEntry(siteId, r.contents))
        ? (entryKey(r.path) ?? [])
        : [],
    ),
  );
  const undone = (rule: RedirectRule) =>
    rule.reason === 'hidden' && rule.entry !== undefined && back.has(rule.entry);
  if (rules.length || back.size) {
    const file = await appendRedirects(siteId, git, rules, base_sha, undone);
    if (file) files.push(file);
  }
  const { commit_sha } = await git.publish(files, { base_sha, message: commitMessage(paths) });
  // Await the blobs first: a drizzle statement is thenable and would run outside the batch.
  const seeded = await Promise.all(
    written.map(async (file) => ({ ...file, blob: await blobSha(file.contents) })),
  );
  const writes = seeded.map(({ path, contents, blob }, i) => {
    const row = rows[i];
    if (!row) throw new Error('Missing published snapshot');
    const unchanged = eq(drafts.revision, row.revision);
    return db
      .update(drafts)
      .set({
        contents: sql`case when ${unchanged} then ${contents} else ${drafts.contents} end`,
        baseSha: commit_sha,
        baseBlob: blob,
        publishedSha: sql`case when ${unchanged} then ${commit_sha} else null end`,
        heldBy: sql`case when ${unchanged} then null else ${drafts.heldBy} end`,
        heldAt: sql`case when ${unchanged} then null else ${drafts.heldAt} end`,
        pendingRedirects: sql`case when ${unchanged} then null else ${drafts.pendingRedirects} end`,
      })
      .where(
        and(
          eq(drafts.siteId, siteId),
          eq(drafts.path, path),
          eq(drafts.baseSha, row.baseSha),
          eq(drafts.baseBlob, row.baseBlob),
        ),
      );
  });
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
  const released = [
    ...new Set(rows.filter((r) => r.heldBy).flatMap((r) => entryKey(r.path) ?? [])),
  ];
  return { commit_sha, paths, released };
}

/** Not a `saveDraft`: the paths it fills go into `_machine` and stay there until typed over. */
export async function saveTranslated(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  path: string,
  filled: Record<string, string>,
  by?: string,
  expectedRevision?: string,
): Promise<{ updated_at: number; pending: boolean } | undefined> {
  const loaded = await load(siteId, db, git, path);
  if (!loaded) return undefined;
  if (expectedRevision !== undefined && loaded.revision !== expectedRevision)
    throw new DraftRevisionError();
  const contents = stringifyEntry(siteId, machineFilled(siteId, loaded.entry, filled));
  const updatedAt = Date.now();
  await db.batch([upsert(db, siteId, path, contents, loaded, updatedAt, stampOf(by))]);
  return { updated_at: updatedAt, pending: (await blobSha(contents)) !== loaded.baseBlob };
}

export { RevertConflictError } from './lifecycle.js';

/** The operation record and exact configured paths jointly bound repository write authority. */
export class CommitScopeError extends Error {
  override name = 'CommitScopeError';
  constructor() {
    super('This commit is not an eligible CMS operation, or contains paths outside its scope.');
  }
}
export async function commitScope(siteId: string, db: Db, sha: string, restore = false) {
  const events = await db
    .select()
    .from(activity)
    .where(and(eq(activity.siteId, siteId), eq(activity.commitSha, sha)));
  const kinds = restore
    ? ['entry-delete', 'locale-off']
    : [
        'publish',
        'entry-delete',
        'locale-off',
        'entry-rename',
        'redirect-added',
        'redirect-changed',
        'redirect-deleted',
      ];
  const event = events.find((e) => kinds.includes(e.kind));
  if (!event) throw new CommitScopeError();
  const detail = event.detail as { entries?: string[]; from?: string; paths?: string[] } | null;
  const keys = new Set(Array.isArray(detail?.entries) ? detail.entries : []);
  const subject = entryKey(event.subject ?? '');
  if (subject) keys.add(subject);
  if (event.kind === 'entry-rename' && subject && typeof detail?.from === 'string')
    keys.add(`${subject.split('/')[0]}/${detail.from}`);
  return {
    kind: event.kind,
    allows: (path: string) =>
      path === REDIRECTS ||
      (Array.isArray(detail?.paths) ? detail.paths.includes(path) : keys.has(entryKey(path) ?? '')),
  };
}

/** Not `git revert`: the trees API has no three-way merge, so the inverse is composed here. */
export async function revertCommit(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getCommit' | 'getFile' | 'getHead' | 'publish'>,
  commitSha: string,
  allowedPath: (path: string) => boolean = (path) =>
    /^src\/content\/[\w-]+\/[\w-]+\/[\w-]+\.yaml$/.test(path) || path === REDIRECTS,
  restoring = false,
): Promise<{ commit_sha: string; paths: string[]; files: PublishFile[] }> {
  const scope = await commitScope(siteId, db, commitSha, restoring);
  const commit = await git.getCommit(commitSha);
  if (!commit.paths.every((path) => scope.allows(path) && allowedPath(path)))
    throw new CommitScopeError();
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
  // Await the blobs first: a drizzle statement is thenable and would run outside the batch.
  const rebased = await Promise.all(
    rows.map(async (row) => {
      const restored = files.find((f) => f.path === row.path)?.contents ?? null;
      return {
        path: row.path,
        revision: row.revision,
        gone: row.contents === '' && Boolean(row.publishedSha) && restored !== null,
        blob: restored === null ? '' : await blobSha(restored),
      };
    }),
  );
  const writes = rebased.map(({ path, revision, gone, blob }) => {
    const where = and(eq(drafts.siteId, siteId), eq(drafts.path, path));
    return gone
      ? db.delete(drafts).where(and(where, eq(drafts.revision, revision)))
      : db
          .update(drafts)
          .set({
            baseSha: commit_sha,
            baseBlob: blob,
            publishedSha: null,
            revision: crypto.randomUUID(),
          })
          .where(where);
  });
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
  if (scope.kind === 'publish') {
    for (const [i, path] of paths.entries()) {
      const published = then[i];
      if (!published) continue;
      await db
        .insert(drafts)
        .values({
          siteId,
          path,
          revision: crypto.randomUUID(),
          contents: published.contents,
          baseSha: commit_sha,
          baseBlob: before[i]?.blob_sha ?? '',
          updatedAt: Date.now(),
        })
        .onConflictDoNothing();
    }
  }
  // ⚠️ `files` carries file contents for `restoreCommit`; a route must never answer with it.
  return { commit_sha, paths: files.map((f) => f.path), files };
}

/** The `_` keys a turn-off rewrites, which are the ones a restore has to put back. */
const MARKS = ['_locales', '_i18n'];

/** Open drafts take the restored marks, or the next publish writes the language off again. */
export async function restoreCommit(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getCommit' | 'getFile' | 'getHead' | 'publish'>,
  commitSha: string,
  allowedPath?: (path: string) => boolean,
): Promise<{ commit_sha: string; paths: string[] }> {
  const { commit_sha, paths, files } = await revertCommit(
    siteId,
    db,
    git,
    commitSha,
    allowedPath,
    true,
  );
  for (const file of files) {
    if (file.contents === null) continue;
    const open = await loadDraft(siteId, db, file.path);
    if (!open) continue;
    const entry = writtenEntry(siteId, parseEntry(siteId, open.contents));
    const restored = parseEntry(siteId, file.contents) as Record<string, unknown>;
    for (const mark of MARKS) {
      if (mark in restored) entry[mark] = restored[mark];
      else delete entry[mark];
    }
    const contents = stringifyEntry(siteId, writtenEntry(siteId, entry));
    if (contents === open.contents) continue;
    await db
      .update(drafts)
      .set({
        contents,
        revision: sql`case when ${drafts.revision} = ${open.revision} then ${crypto.randomUUID()} else null end`,
      })
      .where(and(eq(drafts.siteId, siteId), eq(drafts.path, file.path)));
  }
  return { commit_sha, paths };
}

/** Green is not enough: an entry still being edited keeps its row until its lock runs out. */
export async function clearPublished(
  siteId: string,
  db: Db,
  commitSha: string,
  now = Date.now(),
): Promise<string[]> {
  const rows = await db
    .select({ path: drafts.path, revision: drafts.revision })
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
  if (!clear.length) return [];
  const removed = await db
    .delete(drafts)
    .where(
      and(
        eq(drafts.siteId, siteId),
        eq(drafts.publishedSha, commitSha),
        or(
          ...rows
            .filter((r) => clear.includes(r.path))
            .map((r) =>
              and(
                eq(drafts.path, r.path),
                eq(drafts.revision, r.revision),
                sql`not exists (select 1 from locks where site_id = ${siteId} and entry = ${entryKey(r.path) ?? ''} and expires_at > ${now})`,
              ),
            ),
        ),
      ),
    )
    .returning({ path: drafts.path });
  return removed.map((row) => row.path);
}
