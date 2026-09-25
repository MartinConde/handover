import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { type ContentFile, type ContentIndex, entryKey, indexHasPath } from '../content/entries.js';
import {
  type LocaleSeed,
  mergeEntry,
  offeredEntry,
  parseEntry,
  stringifyEntry,
  withSource,
  writtenEntry,
} from '../content/entry-format.js';
import { syncLocale } from '../content/locale-sync.js';
import { markTranslation, type TranslationSource } from '../content/provenance.js';
import { type RedirectRule, redirectRule } from '../content/redirects.js';
import { checkReserved } from '../content/reserved.js';
import type { Form } from '../content/schema.js';
import { machineFilled } from '../content/translate.js';
import { chunksOf, D1_MAX_BOUND_PARAMETERS, type Db, type Draft } from '../db.js';
import { blobSha, type GitClient } from '../publishing/git.js';
import { drafts, media, pathReservations, user } from '../tables.js';

// Defined here, not in paths.ts, so recordRenames' signature below needs no cycle back to it.
export interface PathReservation {
  operationId: string;
  paths: string[];
  token: string;
}

// A source change deliberately decides every file's provenance. Keep that decision through
// unrelated draft rewrites; a real translation save writes its own mark into the contents.
// Keep `:` out: durable publish snapshots separate revision, base SHA and blob with that delimiter.
export const SOURCE_CHANGE_REVISION = 'source-change-';
export const nextRevision = (
  current?: string,
  sourceChange = current?.startsWith(SOURCE_CHANGE_REVISION),
) => `${sourceChange ? SOURCE_CHANGE_REVISION : ''}${crypto.randomUUID()}`;

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

export const availableContents = (siteId: string, contents: string) =>
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
  /** The entry's recorded source, written into every file this save writes. */
  stamp?: string;
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
  const revision = nextRevision(loaded.revision);
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
  // Last, so the key also keeps its place after `_version` whatever the merge reordered.
  const stamped = (data: Record<string, unknown>) =>
    sync?.stamp ? withSource(siteId, data, sync.stamp) : data;
  let contents = stringifyEntry(
    siteId,
    stamped(sync && !translated ? syncLocale(siteId, sync.form, sync.locale, edit, after) : after),
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
    const siblingRevision = nextRevision(other.revision);
    revisions[locale] = siblingRevision;
    writes.push(
      upsert(db, siteId, sibling, stringifyEntry(siteId, stamped(synced)), other, updatedAt, {
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

/** Every file in one batch, each at the revision it was read at: one that moved refuses the lot. */
export async function rewriteDrafts(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  files: { path: string; revision?: string; contents: string; preserveProvenance?: boolean }[],
  by?: string,
  expected: readonly { path: string; revision?: string }[] = files,
): Promise<void> {
  const found = await Promise.all(files.map((f) => load(siteId, db, git, f.path)));
  const updatedAt = Date.now();
  const captured = sql.join(
    expected.map(({ path, revision }) =>
      revision === undefined
        ? sql`not exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and (contents <> '' or published_sha is null))`
        : sql`exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and revision = ${revision})`,
    ),
    sql` and `,
  );
  const writes = files.map((f, i) => {
    const loaded = found[i];
    if (!loaded || loaded.revision !== f.revision) throw new DraftRevisionError();
    return upsert(
      db,
      siteId,
      f.path,
      f.contents,
      loaded,
      updatedAt,
      {
        ...stampOf(by),
        ...(f.preserveProvenance ? { revision: nextRevision(undefined, true) } : {}),
      },
      i === 0 ? captured : sql`true`,
    );
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
  source?: string,
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
      offeredEntry(siteId, f.loaded.entry, { offered, locales, source }),
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

/** Each of these is owned by an action of its own, never by a version of the words. */
const KEPT_ON_RESTORE = ['slug', '_status', '_locales', '_source'] as const;

// A key assigned in place lands after the other `_` keys; `_source` sits right after `_version`.
export const keptSource = (siteId: string, entry: Record<string, unknown>) =>
  typeof entry._source === 'string' ? withSource(siteId, entry, entry._source) : entry;

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
    const contents = stringifyEntry(
      siteId,
      keptSource(siteId, writtenEntry(siteId, entry, form.fields)),
    );
    return [upsert(db, siteId, file.path, contents, file.loaded, updatedAt, stampOf(by))];
  });
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
  return { paths: found.filter((f) => f !== undefined).map((f) => f.path) };
}

// A file as the editor has it: its open draft, or the repository when there is none.
export async function load(
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
export function upsert(
  db: Db,
  siteId: string,
  path: string,
  contents: string,
  { open, baseSha, baseBlob, revision }: Loaded,
  updatedAt: number,
  extra: { pendingRedirects?: RedirectRule[] | null; updatedBy?: string; revision?: string } = {},
  guard = sql`true`,
) {
  // A conditional UPDATE would silently succeed; violating NOT NULL aborts the whole D1 batch.
  const next = extra.revision ?? nextRevision(revision);
  const matches = revision
    ? sql`exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and revision = ${revision})`
    : sql`not exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and (contents <> '' or published_sha is null))`;
  const asserted = sql<string>`case when ${matches} and ${guard} and not exists (select 1 from path_reservations r join operations o on o.site_id = r.site_id and o.id = r.operation_id where r.site_id = ${siteId} and r.path = ${path} and o.state <> 'finalized') then ${next} else null end`;
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
export const stampOf = (by?: string) => (by ? { updatedBy: by } : {});

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
  expected?: Readonly<Record<string, string | undefined>>,
): Promise<{ updated_at: number }> {
  return createDrafts(siteId, db, git, [{ path, values }], expected);
}

/** All locale paths of a new entry are claimed in one transaction, including duplicates. */
export async function createDrafts(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getHead'>,
  files: readonly { path: string; values: Record<string, unknown> }[],
  expected?: Readonly<Record<string, string | undefined>>,
): Promise<{ updated_at: number }> {
  const updatedAt = Date.now();
  const baseSha = await git.getHead();
  const captured = expected
    ? sql.join(
        Object.entries(expected).map(([path, revision]) =>
          revision === undefined
            ? sql`not exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and (contents <> '' or published_sha is null))`
            : sql`exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and revision = ${revision})`,
        ),
        sql` and `,
      )
    : sql`true`;
  const writes = files.map(({ path, values }, i) => {
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
          revision: sql`case when ${i === 0 ? captured : sql`true`} and not exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and (contents <> '' or published_sha is null)) and not exists (select 1 from path_reservations r join operations o on o.site_id = r.site_id and o.id = r.operation_id where r.site_id = ${siteId} and r.path = ${path} and o.state <> 'finalized') then lower(hex(randomblob(16))) else null end`,
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
  offer: { offered: string[]; locales: string[]; source?: string },
  commitSha: string,
): Promise<void> {
  const open = await loadDraft(siteId, db, path);
  if (!open) return;
  const entry = offeredEntry(siteId, parseEntry(siteId, open.contents), offer);
  await db
    .update(drafts)
    .set({
      revision: sql`case when ${drafts.revision} = ${open.revision} then ${nextRevision(open.revision)} else null end`,
      contents: stringifyEntry(siteId, entry),
      baseSha: commitSha,
      baseBlob: await blobSha(committed),
    })
    .where(and(eq(drafts.siteId, siteId), eq(drafts.path, path)));
}

/** Recording a source moves the open draft onto its commit, or it would publish the file unmarked. */
export async function recordSource(
  siteId: string,
  db: Db,
  path: string,
  source: string,
  commit?: { sha: string; was: string; contents: string },
): Promise<void> {
  const open = await loadDraft(siteId, db, path);
  if (!open?.contents) return;
  const data = parseEntry(siteId, open.contents);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  let entry = withSource(siteId, data, source);
  if (commit) {
    const was = parseEntry(siteId, commit.was) as Record<string, unknown> | null;
    const now = parseEntry(siteId, commit.contents) as Record<string, unknown> | null;
    // The commit's settled mark, unless the draft had already changed its own.
    if (JSON.stringify(entry._i18n) === JSON.stringify(was?._i18n)) {
      const { _i18n, ...rest } = entry;
      entry = now?._i18n === undefined ? rest : { ...entry, _i18n: now._i18n };
    }
  }
  await db
    .update(drafts)
    .set({
      revision: sql`case when ${drafts.revision} = ${open.revision} then ${nextRevision(open.revision)} else null end`,
      contents: stringifyEntry(siteId, entry),
      ...(commit ? { baseSha: commit.sha, baseBlob: await blobSha(commit.contents) } : {}),
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

/** Not a `saveDraft`: the paths it fills go into `_machine` and stay there until typed over. */
export async function saveTranslated(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  path: string,
  filled: Record<string, string>,
  by?: string,
  expectedRevision?: string,
  provenance?: { form: Form; source: TranslationSource; stamp?: string },
): Promise<{ updated_at: number; pending: boolean } | undefined> {
  const loaded = await load(siteId, db, git, path);
  if (!loaded) return undefined;
  if (expectedRevision !== undefined && loaded.revision !== expectedRevision)
    throw new DraftRevisionError();
  const filledEntry = machineFilled(siteId, loaded.entry, filled);
  let contents = stringifyEntry(
    siteId,
    provenance?.stamp ? withSource(siteId, filledEntry, provenance.stamp) : filledEntry,
  );
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
