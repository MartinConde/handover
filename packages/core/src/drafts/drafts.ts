import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { entryKey } from '../content/entries.js';
import {
  type LocaleSeed,
  mergeEntry,
  parseEntry,
  stringifyEntry,
  withSource,
} from '../content/entry-format.js';
import { syncLocale } from '../content/locale-sync.js';
import { markTranslation, type TranslationSource } from '../content/provenance.js';
import type { RedirectRule } from '../content/redirects.js';
import { checkReserved } from '../content/reserved.js';
import type { Form } from '../content/schema.js';
import { machineFilled } from '../content/translate.js';
import { batchAll, type Db, type Draft } from '../db.js';
import { blobSha, type GitClient } from '../publishing/git.js';
import { drafts, media, user } from '../tables.js';

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

// SQL conditions for NOT NULL assertions: one false aborts the whole D1 batch.
export const noLiveRow = (siteId: string, path: string) =>
  sql`not exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and (contents <> '' or published_sha is null))`;

export const atRevision = (siteId: string, path: string, revision: string) =>
  sql`exists (select 1 from drafts where site_id = ${siteId} and path = ${path} and revision = ${revision})`;

const unreserved = (siteId: string, path: string) =>
  sql`not exists (select 1 from path_reservations r join operations o on o.site_id = r.site_id and o.id = r.operation_id where r.site_id = ${siteId} and r.path = ${path} and o.state <> 'finalized')`;

const allAt = (siteId: string, expected: readonly { path: string; revision?: string }[]) =>
  sql.join(
    expected.map(({ path, revision }) =>
      revision === undefined ? noLiveRow(siteId, path) : atRevision(siteId, path, revision),
    ),
    sql` and `,
  );

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
        revision: sql`case when ${unreserved(siteId, path)} then ${crypto.randomUUID()} else null end`,
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
  await batchAll(db, writes);
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
  const captured = allAt(siteId, expected);
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
  await batchAll(db, writes);
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
  const matches = revision ? atRevision(siteId, path, revision) : noLiveRow(siteId, path);
  const asserted = sql<string>`case when ${matches} and ${guard} and ${unreserved(siteId, path)} then ${next} else null end`;
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
    ? allAt(
        siteId,
        Object.entries(expected).map(([path, revision]) => ({ path, revision })),
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
          revision: sql`case when ${i === 0 ? captured : sql`true`} and ${noLiveRow(siteId, path)} and ${unreserved(siteId, path)} then lower(hex(randomblob(16))) else null end`,
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
  await batchAll(db, writes);
  return { updated_at: updatedAt };
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
