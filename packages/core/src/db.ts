import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  applyDrift,
  type DriftChoice,
  type LocaleSeed,
  markTranslation,
  mergeEntry,
  offeredEntry,
  parseEntry,
  stringifyEntry,
  syncLocale,
  type TranslationSource,
  writtenEntry,
} from './content.js';
import { chunksOf, D1_MAX_BOUND_PARAMETERS } from './d1-limits.js';
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
import {
  beginOperation,
  finalizeOperationStatement,
  findOperation,
  markOperationCommitted,
  OperationFinalizationError,
  operationMessage,
  recentOperations,
  recoverOperationCommit,
} from './operations.js';
import { checkReserved, isLive } from './reserved.js';
import {
  type Answer,
  applyResolution,
  conflictReport,
  type MergedChange,
  type Question,
  type ThreeWay,
} from './resolve.js';
import type { Form } from './schema.js';
import { activity, drafts, locks, media, operations, pathReservations, user } from './tables.js';
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

/** The database assertion makes the media state and draft write one ordered decision. */
export function isMediaRace(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  return /NOT NULL constraint failed: drafts.contents/.test(message);
}

const availableContents = (siteId: string, contents: string) =>
  sql<string>`case when not exists (select 1 from ${media} where ${media.siteId} = ${siteId} and ${media.state} <> 'active' and instr(${contents}, ${media.r2Key}) > 0) then ${contents} else null end`;

/** Seed precisely the immutable file shown on GET; concurrent opens share the winning row. */
export async function openDraft(
  siteId: string,
  db: Db,
  path: string,
  head: string,
  file: { contents: string; blob_sha: string } | undefined,
): Promise<Draft | undefined> {
  if (file) {
    // A failed open must not leave unreadable repository bytes behind as a durable draft row.
    if (file.contents) parseEntry(siteId, file.contents);
    await db
      .insert(drafts)
      .values({
        siteId,
        path,
        revision: sql`case when not exists (select 1 from path_reservations r join operations o on o.site_id = r.site_id and o.id = r.operation_id where r.site_id = ${siteId} and r.path = ${path} and o.state <> 'finalized') then ${crypto.randomUUID()} else null end`,
        contents: file.contents,
        baseSha: head,
        baseBlob: file.blob_sha,
        updatedAt: Date.now(),
      })
      .onConflictDoNothing();
  }
  return loadDraft(siteId, db, path);
}

export interface PathReservation {
  operationId: string;
  paths: string[];
  token: string;
}

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
      token: sql`case when not exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and (contents <> '' or published_sha is null)) then ${token} else null end`,
    }),
  );
  const [first, ...rest] = writes;
  try {
    if (first) await db.batch([first, ...rest]);
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

/** The entry's other languages, so one save can keep their structure in step with this one. */
export interface LocaleSync {
  form: Form;
  /** The language the form was drawn from. */
  locale: string;
  /** locale → path of the entry's other languages; empty on a save of a translation. */
  siblings: Record<string, string>;
  /** A translation's save takes only the values its language owns, never the structure. */
  translation?: boolean;
  /** Top-level values owned by a dedicated server operation, not by ordinary saves. */
  managed?: readonly string[];
  /** The immutable source bytes visible when this translated save was dispatched. */
  source?: TranslationSource;
  /** Locale-owned subtrees used only when structural history restores or duplicates rows. */
  restoration?: {
    /** The complete locale revision set captured with the restoration seeds. */
    revisions: Readonly<Record<string, string>>;
    /** locale → saved rows that may fill newly inserted source rows. */
    seeds: Readonly<Record<string, readonly LocaleSeed[]>>;
  };
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
  // Managed values never enter the ordinary write contract, including when a stale or malformed
  // client carries a full document snapshot forward.
  const managed = new Set(sync?.managed ?? []);
  const submitted = Object.fromEntries(Object.entries(values).filter(([key]) => !managed.has(key)));
  // Validate submitted row identities before locale pairing can make an ambiguous edit appear valid.
  checkReserved(submitted);
  const locale = sync?.locale ?? path.split('/').at(-2) ?? '';
  const siblings = Object.entries(sync?.translation ? {} : (sync?.siblings ?? {}));
  const loadedSiblings = sync?.restoration
    ? await Promise.all(
        siblings.map(
          async ([siblingLocale, sibling]) =>
            [siblingLocale, await load(siteId, db, git, sibling)] as const,
        ),
      )
    : undefined;
  if (sync?.restoration) {
    const present = new Map<string, Loaded>([[locale, loaded]]);
    for (const [siblingLocale, other] of loadedSiblings ?? [])
      if (other) present.set(siblingLocale, other);
    const expected = sync.restoration.revisions;
    if (
      Object.keys(expected).length !== present.size ||
      [...present].some(
        ([presentLocale, file]) =>
          expected[presentLocale] === undefined || expected[presentLocale] !== file.revision,
      ) ||
      Object.keys(sync.restoration.seeds).some((seedLocale) => !present.has(seedLocale))
    )
      throw new DraftRevisionError();
  }
  const revision = crypto.randomUUID();
  const revisions: Record<string, string> = {
    [locale]: revision,
  };
  const before = loaded.entry;
  const translated = sync?.translation ? sync.form : undefined;
  let after = mergeEntry(siteId, before, submitted, translated);
  const current = (before ?? {}) as Record<string, unknown>;
  if (managed.size) {
    const currentKeys = Object.keys(current);
    const entries = Object.entries(after).filter(([key]) => !managed.has(key));
    for (const [position, key] of currentKeys.entries()) {
      if (!managed.has(key)) continue;
      const next = currentKeys
        .slice(position + 1)
        .find((candidate) => entries.some(([present]) => present === candidate));
      const at = next ? entries.findIndex(([present]) => present === next) : entries.length;
      entries.splice(at, 0, [key, current[key]]);
    }
    after = Object.fromEntries(entries);
  }
  const edit = { before, after };
  const updatedAt = Date.now();
  let contents = stringifyEntry(
    siteId,
    sync && !translated ? syncLocale(siteId, sync.form, sync.locale, edit, after) : after,
  );
  if (translated && sync?.source)
    contents = await markTranslation(siteId, translated, sync.source, contents, loaded.contents);
  const stamp = { ...stampOf(by), revision };
  const writes = [upsert(db, siteId, path, contents, loaded, updatedAt, stamp)];
  // A translation changes no structure, so the other languages have nothing to follow.
  for (const [locale, sibling] of translated ? [] : siblings) {
    if (!sync) break;
    const projection = (data: unknown) => skeleton(siteId, sync.form, locale, data);
    if (projection(before) === projection(after)) continue;
    const other = loadedSiblings
      ? loadedSiblings.find(([loadedLocale]) => loadedLocale === locale)?.[1]
      : await load(siteId, db, git, sibling);
    if (!other) continue;
    const synced = syncLocale(siteId, sync.form, locale, edit, other.entry, {
      seeds: sync.restoration?.seeds[locale],
    });
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
        contents: availableContents(
          siteId,
          stringifyEntry(siteId, writtenEntry(siteId, resolved[locale], form.fields)),
        ),
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
      contents: row.contents,
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
    contents: file.contents,
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
  const asserted = sql<string>`case when ${matches} and not exists (select 1 from path_reservations r join operations o on o.site_id = r.site_id and o.id = r.operation_id where r.site_id = ${siteId} and r.path = ${path} and o.state <> 'finalized') then ${next} else null end`;
  const available = availableContents(siteId, contents);
  return db
    .insert(drafts)
    .values({
      siteId,
      path,
      contents: available,
      baseSha,
      baseBlob,
      updatedAt,
      ...extra,
      revision: asserted,
    })
    .onConflictDoUpdate({
      target: [drafts.siteId, drafts.path],
      set: {
        contents: available,
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
          contents: availableContents(siteId, contents),
          baseSha,
          baseBlob: '',
          updatedAt,
          revision: sql`case when not exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and (contents <> '' or published_sha is null)) and not exists (select 1 from path_reservations r join operations o on o.site_id = r.site_id and o.id = r.operation_id where r.site_id = ${siteId} and r.path = ${path} and o.state <> 'finalized') then lower(hex(randomblob(16))) else null end`,
        })
        // Only a removed row can be at this path: a name a live row holds is never picked again.
        .onConflictDoUpdate({
          target: [drafts.siteId, drafts.path],
          set: {
            contents: availableContents(siteId, contents),
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
  expectedRevision?: string,
): Promise<void> {
  const [current] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.siteId, siteId), eq(drafts.path, path)))
    .limit(1);
  if (current?.publishedSha === commitSha && current.contents === '') return;
  // A save after intent survives, rebased on the commit that removed the old repository file.
  if (expectedRevision !== undefined && current && current.revision !== expectedRevision) {
    await db
      .update(drafts)
      .set({ baseSha: commitSha, baseBlob: '', publishedSha: null })
      .where(
        and(
          eq(drafts.siteId, siteId),
          eq(drafts.path, path),
          eq(drafts.revision, current.revision),
        ),
      );
    return;
  }
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
  await recordRenames(siteId, db, [{ from, to, contents }], commitSha, by);
}

/** Every repository file and unpublished locale changes identity in one D1 transaction. */
export async function recordRenames(
  siteId: string,
  db: Db,
  moves: readonly { from: string; to: string; contents?: string }[],
  commitSha: string,
  by?: string,
  reservation?: PathReservation,
): Promise<void> {
  const captured = await Promise.all(
    moves.map(async (move) => ({
      ...move,
      row: await db.query.drafts.findFirst({
        where: and(eq(drafts.siteId, siteId), eq(drafts.path, move.from)),
      }),
      blob: move.contents === undefined ? '' : await blobSha(move.contents),
    })),
  );
  const updatedAt = Date.now();
  const writes = captured.flatMap(({ from, to, contents, row, blob }) => {
    const hasFile = contents !== undefined;
    const hasDraft = row !== undefined && (row.contents !== '' || row.publishedSha === null);
    // A deletion marker has no locale to move and must keep masking the old built index.
    if (!hasFile && !hasDraft) return [];
    const clearDestination = db
      .delete(drafts)
      .where(and(eq(drafts.siteId, siteId), eq(drafts.path, to), eq(drafts.contents, '')));
    const destination = hasDraft
      ? db
          .update(drafts)
          .set({
            path: to,
            baseSha: commitSha,
            baseBlob: hasFile ? blob : '',
            ...stampOf(by),
          })
          .where(and(eq(drafts.siteId, siteId), eq(drafts.path, from)))
      : db
          .insert(drafts)
          .values({
            siteId,
            path: to,
            revision: crypto.randomUUID(),
            contents: contents ?? '',
            baseSha: commitSha,
            baseBlob: blob,
            updatedAt,
            publishedSha: commitSha,
          })
          .onConflictDoNothing({ target: [drafts.siteId, drafts.path] });
    if (!hasFile) return [clearDestination, destination];
    const gone = {
      revision: crypto.randomUUID(),
      contents: '',
      baseSha: commitSha,
      baseBlob: '',
      updatedAt,
    };
    const source = db
      .insert(drafts)
      .values({ siteId, path: from, ...gone, publishedSha: commitSha })
      .onConflictDoUpdate({
        target: [drafts.siteId, drafts.path],
        set: { ...gone, publishedSha: commitSha },
      });
    return [clearDestination, destination, source];
  });
  // The insert conflicts harmlessly with the live claim. Its NOT NULL expression makes a
  // missing/replaced claim fail the whole D1 batch before any destination row can change.
  const fence = reservation
    ? db
        .insert(pathReservations)
        .values({
          siteId,
          path: reservation.paths[0] ?? '',
          operationId: reservation.operationId,
          token: sql`case when (select count(*) from path_reservations where site_id = ${siteId} and operation_id = ${reservation.operationId} and token = ${reservation.token} and ${inArray(pathReservations.path, reservation.paths)}) = ${reservation.paths.length} then ${reservation.token} else null end`,
        })
        .onConflictDoNothing({ target: [pathReservations.siteId, pathReservations.path] })
    : undefined;
  const guarded = fence ? [fence, ...writes] : writes;
  const [first, ...rest] = guarded;
  if (first) await db.batch([first, ...rest]);
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
  // Site and empty contents take two bindings; each guarded row takes another three.
  const perQuery = Math.floor((D1_MAX_BOUND_PARAMETERS - 2) / 3);
  for (const chunk of chunksOf(settled, perQuery))
    await db
      .delete(drafts)
      .where(
        and(
          eq(drafts.siteId, siteId),
          eq(drafts.contents, ''),
          or(
            ...chunk.map((r) =>
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

/** Only unchanged rows abandoned by the repository are disposable without user recovery. */
export async function sweepOrphans(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'> | undefined,
  now = Date.now(),
): Promise<number> {
  // A site whose App is not configured cannot be asked what the tree holds, so nothing is deleted.
  if (!git) return 0;
  const rows = await db
    .select({
      path: drafts.path,
      revision: drafts.revision,
      contents: drafts.contents,
      baseBlob: drafts.baseBlob,
    })
    .from(drafts)
    .where(
      and(
        eq(drafts.siteId, siteId),
        ne(drafts.baseBlob, ''),
        isNull(drafts.heldBy),
        lt(drafts.updatedAt, now - ORPHAN_AGE),
      ),
    );
  if (!rows.length) return 0;
  // One commit for all of them, so a moving tree cannot split the answers across two repositories.
  const head = await git.getHead();
  let removed = 0;
  for (const row of rows) {
    if ((await blobSha(row.contents)) !== row.baseBlob || (await git.getFile(row.path, head)))
      continue;
    const deleted = await db
      .delete(drafts)
      .where(
        and(
          eq(drafts.siteId, siteId),
          eq(drafts.path, row.path),
          eq(drafts.revision, row.revision),
          eq(drafts.contents, row.contents),
          eq(drafts.baseBlob, row.baseBlob),
          isNull(drafts.heldBy),
          lt(drafts.updatedAt, now - ORPHAN_AGE),
          sql`not exists (select 1 from locks where site_id = ${siteId} and entry = ${entryKey(row.path) ?? ''} and expires_at > ${now})`,
        ),
      )
      .returning({ path: drafts.path });
    removed += deleted.length;
  }
  return removed;
}

/** Throw away the unpublished edits for one path; a deleted entry must not come back. */
export async function discardDraft(
  siteId: string,
  db: Db,
  path: string,
  expectedRevision?: string,
): Promise<void> {
  await db
    .delete(drafts)
    .where(
      and(
        eq(drafts.siteId, siteId),
        eq(drafts.path, path),
        expectedRevision === undefined ? undefined : eq(drafts.revision, expectedRevision),
      ),
    );
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
  durable?: { userId?: string },
): Promise<{ commit_sha: string; paths: string[]; released: string[] } | undefined> {
  let rows = snapshot ?? (await readyDrafts(siteId, db, entries));
  if (!rows.length) return undefined;
  const retryKey = `publish:${rows
    .map((row) => `${row.path}\u0000${row.revision}\u0000${row.baseSha}\u0000${row.baseBlob}`)
    .sort()
    .join('\u0001')}`;
  let existing = durable ? await findOperation(siteId, db, retryKey) : undefined;
  if (durable && !existing) {
    const selected = new Set(rows.map((row) => row.path));
    existing = (await recentOperations(siteId, db, 'publish')).find(
      (operation) =>
        operation.state !== 'finalized' &&
        Object.keys(operation.revisions).every((path) => selected.has(path)),
    );
  }
  if (existing) {
    const captured = new Set(Object.keys(existing.revisions));
    rows = rows.filter((row) => captured.has(row.path));
  }
  const completed = existing?.result as {
    commit_sha?: unknown;
    paths?: unknown;
    released?: unknown;
  } | null;
  if (
    existing?.state === 'finalized' &&
    typeof completed?.commit_sha === 'string' &&
    Array.isArray(completed.paths) &&
    Array.isArray(completed.released)
  )
    return {
      commit_sha: completed.commit_sha,
      paths: completed.paths.filter((path): path is string => typeof path === 'string'),
      released: completed.released.filter((entry): entry is string => typeof entry === 'string'),
    };
  const base_sha = existing?.baseSha ?? (await git.getHead());
  // Every read is of the commit the publish is made against, so the check and the parent agree.
  const current = await Promise.all(rows.map((r) => git.getFile(r.path, base_sha)));
  if (!existing) {
    const conflicts = rows
      .filter((r, i) => (current[i]?.blob_sha ?? '') !== r.baseBlob)
      .map((r) => r.path);
    if (conflicts.length) throw new DraftConflictError(conflicts);
  }
  const paths = rows.map((r) => r.path);
  let written = await Promise.all(
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
        true,
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
  const released = [
    ...new Set(rows.filter((r) => r.heldBy).flatMap((r) => entryKey(r.path) ?? [])),
  ];
  const operation = durable
    ? (existing ??
      (await beginOperation(siteId, db, {
        retryKey,
        kind: 'publish',
        paths: files.map((file) => file.path),
        revisions: Object.fromEntries(
          rows.map((row) => [row.path, `${row.revision}:${row.baseSha}:${row.baseBlob}`]),
        ),
        baseSha: base_sha,
        userId: durable.userId,
        subject: paths.length === 1 ? (paths[0] ?? null) : null,
        detail: {
          files: paths.length,
          entries: [...new Set(paths.flatMap((path) => entryKey(path) ?? []))].slice(0, 8),
          paths,
        },
      })))
    : undefined;
  let commit_sha = operation?.commitSha;
  if (operation && !commit_sha)
    commit_sha = await recoverOperationCommit(siteId, db, git, operation);
  if (!commit_sha) {
    const published = await git.publish(files, {
      base_sha,
      message: operation
        ? operationMessage(commitMessage(paths), operation.id)
        : commitMessage(paths),
    });
    commit_sha = published.commit_sha;
  }
  if (operation && (operation.commitSha || (existing && commit_sha)))
    written = await Promise.all(
      rows
        .filter((row) => row.path in operation.revisions)
        .map(async (row) => ({
          path: row.path,
          contents: (await git.getFile(row.path, commit_sha))?.contents ?? '',
        })),
    );
  const result = {
    commit_sha,
    paths,
    released,
  };
  if (operation) await markOperationCommitted(siteId, db, operation.id, commit_sha, result);
  // Await the blobs first: a drizzle statement is thenable and would run outside the batch.
  const finalizedRows = operation
    ? written.map((file) => {
        const currentRow = rows.find((row) => row.path === file.path);
        const [revision, baseSha, baseBlob] = (operation.revisions[file.path] ?? '').split(':');
        if (!currentRow || !revision || baseSha === undefined || baseBlob === undefined)
          throw new Error(`Missing captured revision for ${file.path}`);
        return { ...currentRow, revision, baseSha, baseBlob };
      })
    : rows;
  const seeded = await Promise.all(
    written.map(async (file) => ({ ...file, blob: await blobSha(file.contents) })),
  );
  const writes = seeded.map(({ path, contents, blob }, i) => {
    const row = finalizedRows[i];
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
  const statements = operation
    ? [...writes, finalizeOperationStatement(siteId, db, operation.id)]
    : writes;
  const [first, ...rest] = statements;
  if (first)
    try {
      await db.batch([first, ...rest]);
    } catch (cause) {
      if (operation) throw new OperationFinalizationError(operation.id, commit_sha, { cause });
      throw cause;
    }
  return result;
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
  provenance?: { form: Form; source: TranslationSource },
): Promise<{ updated_at: number; pending: boolean } | undefined> {
  const loaded = await load(siteId, db, git, path);
  if (!loaded) return undefined;
  if (expectedRevision !== undefined && loaded.revision !== expectedRevision)
    throw new DraftRevisionError();
  let contents = stringifyEntry(siteId, machineFilled(siteId, loaded.entry, filled));
  if (provenance)
    contents = await markTranslation(
      siteId,
      provenance.form,
      provenance.source,
      contents,
      loaded.contents,
    );
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
  const durable = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.siteId, siteId),
        eq(operations.commitSha, sha),
        eq(operations.state, 'finalized'),
      ),
    );
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
  const event = [...durable, ...events].find((e) => kinds.includes(e.kind));
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
      'paths' in event && Array.isArray(event.paths)
        ? event.paths.includes(path)
        : path === REDIRECTS ||
          (Array.isArray(detail?.paths)
            ? detail.paths.includes(path)
            : keys.has(entryKey(path) ?? '')),
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
  durable?: { userId?: string },
): Promise<{ commit_sha: string; paths: string[]; files: PublishFile[]; operation_id?: string }> {
  const scope = await commitScope(siteId, db, commitSha, restoring);
  const commit = await git.getCommit(commitSha);
  if (!commit.paths.every((path) => scope.allows(path) && allowedPath(path)))
    throw new CommitScopeError();
  const parent = commit.parent;
  if (!parent) throw new Error(`${commitSha} has no commit before it to go back to`);
  const retryKey = `${restoring ? 'restore' : 'revert'}:${commitSha}`;
  const existing = durable ? await findOperation(siteId, db, retryKey) : undefined;
  const head = existing?.baseSha ?? (await git.getHead());
  const paths = commit.paths.filter((p) => p !== REDIRECTS);
  const [then, now, before] = await Promise.all([
    Promise.all(paths.map((p) => git.getFile(p, commitSha))),
    Promise.all(paths.map((p) => git.getFile(p, head))),
    Promise.all(paths.map((p) => git.getFile(p, parent))),
  ]);
  if (!existing) {
    const moved = paths.filter((_, i) => (now[i]?.blob_sha ?? '') !== (then[i]?.blob_sha ?? ''));
    if (moved.length) throw new RevertConflictError(moved);
  }
  const files: PublishFile[] = paths.map((path, i) => ({
    path,
    contents: before[i]?.contents ?? null,
  }));
  const rules = await revertRedirects(siteId, git, { commit: commitSha, parent, head });
  const changed = rules ? [...files, rules] : files;
  const rows: Draft[] = [];
  // Reading candidates is independent; the later revision-guarded writes remain one batch.
  for (const chunk of chunksOf(paths, D1_MAX_BOUND_PARAMETERS - 1))
    rows.push(
      ...(await db
        .select()
        .from(drafts)
        .where(and(eq(drafts.siteId, siteId), inArray(drafts.path, chunk)))),
    );
  const operation = durable
    ? await beginOperation(siteId, db, {
        retryKey,
        kind: restoring ? 'restore' : 'revert',
        paths: changed.map((file) => file.path),
        revisions: Object.fromEntries(
          rows.map((row) => [row.path, `${row.revision}:${row.baseSha}:${row.baseBlob}`]),
        ),
        baseSha: head,
        userId: durable.userId,
        detail: { of: commitSha, files: paths.length, ...(restoring ? { restore: true } : {}) },
      })
    : undefined;
  const completed = operation?.result as { commit_sha?: unknown; paths?: unknown } | null;
  if (
    operation?.state === 'finalized' &&
    typeof completed?.commit_sha === 'string' &&
    Array.isArray(completed.paths)
  )
    return {
      commit_sha: completed.commit_sha,
      paths: completed.paths.filter((path): path is string => typeof path === 'string'),
      files,
      operation_id: operation.id,
    };
  let commit_sha = operation?.commitSha;
  if (operation && !commit_sha)
    commit_sha = await recoverOperationCommit(siteId, db, git, operation);
  if (!commit_sha) {
    const message = `Revert "${commit.message.split('\n')[0]}"\n\nThis reverts commit ${commit.sha}.`;
    const published = await git.publish(changed, {
      base_sha: head,
      message: operation ? operationMessage(message, operation.id) : message,
    });
    commit_sha = published.commit_sha;
  }
  const result = {
    commit_sha,
    paths: files.map((file) => file.path),
    ...(operation ? { operation_id: operation.id } : {}),
  };
  if (operation) await markOperationCommitted(siteId, db, operation.id, commit_sha, result);
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
          .where(and(where, eq(drafts.revision, revision)));
  });
  const publishWrites =
    scope.kind === 'publish'
      ? then.flatMap((published, i) => {
          const path = paths[i];
          if (!published || !path) return [];
          return [
            db
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
              .onConflictDoNothing(),
          ];
        })
      : [];
  const statements = [
    ...writes,
    ...publishWrites,
    ...(operation && !restoring ? [finalizeOperationStatement(siteId, db, operation.id)] : []),
  ];
  const [first, ...rest] = statements;
  if (first)
    try {
      await db.batch([first, ...rest]);
    } catch (cause) {
      if (operation) throw new OperationFinalizationError(operation.id, commit_sha, { cause });
      throw cause;
    }
  // ⚠️ `files` carries file contents for `restoreCommit`; a route must never answer with it.
  return { ...result, files };
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
  durable?: { userId?: string },
): Promise<{ commit_sha: string; paths: string[]; operation_id?: string }> {
  const { commit_sha, paths, files, operation_id } = await revertCommit(
    siteId,
    db,
    git,
    commitSha,
    allowedPath,
    true,
    durable,
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
  return { commit_sha, paths, ...(operation_id ? { operation_id } : {}) };
}

type DeploymentGit = Pick<GitClient, 'compareCommits' | 'contentFiles'>;

/** Green is not enough: an entry still being edited keeps its row until its lock runs out. */
export async function clearPublished(
  siteId: string,
  db: Db,
  deployedSha: string,
  deploymentOrNow: DeploymentGit | number = Date.now(),
  currentTime = Date.now(),
): Promise<string[]> {
  const deployment = typeof deploymentOrNow === 'number' ? undefined : deploymentOrNow;
  const now = typeof deploymentOrNow === 'number' ? deploymentOrNow : currentTime;
  let rows = await db
    .select({
      path: drafts.path,
      revision: drafts.revision,
      baseBlob: drafts.baseBlob,
      publishedSha: drafts.publishedSha,
    })
    .from(drafts)
    .where(
      and(
        eq(drafts.siteId, siteId),
        deployment ? isNotNull(drafts.publishedSha) : eq(drafts.publishedSha, deployedSha),
        ne(drafts.contents, ''),
      ),
    );
  if (!rows.length) return [];
  if (deployment) {
    const deployed = new Map(
      (await deployment.contentFiles(deployedSha)).map((file) => [file.path, file.contents]),
    );
    const deployedBlobs = new Map(
      await Promise.all(
        rows.flatMap((row) => {
          const contents = deployed.get(row.path);
          return contents === undefined
            ? []
            : [blobSha(contents).then((blob) => [row.path, blob] as const)];
        }),
      ),
    );
    const unresolved = [
      ...new Set(
        rows.flatMap((row) =>
          row.publishedSha && deployedBlobs.get(row.path) !== row.baseBlob
            ? [row.publishedSha]
            : [],
        ),
      ),
    ];
    const ancestry = new Map(
      await Promise.all(
        unresolved.map(
          async (publishedSha) =>
            [publishedSha, await deployment.compareCommits(publishedSha, deployedSha)] as const,
        ),
      ),
    );
    // A descendant supersedes the overlay even if it changed the file. Outside that history,
    // byte equality is the only proof that removing the overlay reveals what is actually live.
    rows = rows.filter(
      (row) =>
        deployedBlobs.get(row.path) === row.baseBlob ||
        ancestry.get(row.publishedSha ?? '') === 'ahead' ||
        ancestry.get(row.publishedSha ?? '') === 'identical',
    );
    if (!rows.length) return [];
  }
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
  const selected = new Set(clear);
  const candidates = rows.filter((r) => selected.has(r.path));
  // Site is one binding. Each row adds path, revision, publish/blob identity, and the three
  // lock-subquery values, so fourteen rows use 99 of D1's 100 available bindings.
  const perQuery = Math.floor((D1_MAX_BOUND_PARAMETERS - 1) / 7);
  const removed: { path: string }[] = [];
  for (const chunk of chunksOf(candidates, perQuery))
    removed.push(
      ...(await db
        .delete(drafts)
        .where(
          and(
            eq(drafts.siteId, siteId),
            or(
              ...chunk.map((r) =>
                and(
                  eq(drafts.path, r.path),
                  eq(drafts.revision, r.revision),
                  eq(drafts.publishedSha, r.publishedSha ?? deployedSha),
                  eq(drafts.baseBlob, r.baseBlob),
                  sql`not exists (select 1 from locks where site_id = ${siteId} and entry = ${entryKey(r.path) ?? ''} and expires_at > ${now})`,
                ),
              ),
            ),
          ),
        )
        .returning({ path: drafts.path })),
    );
  return removed.map((row) => row.path);
}
