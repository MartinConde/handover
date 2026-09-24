import { and, eq, sql } from 'drizzle-orm';
import {
  availableContents,
  type Db,
  load,
  loadDraft,
  nextRevision,
  stampOf,
  upsert,
} from './db.js';
import { parseEntry, stringifyEntry, writtenEntry } from './entry-format.js';
import { blobSha, type GitClient } from './git.js';
import { applyDrift, type DriftChoice } from './locale-sync.js';
import {
  type Answer,
  applyResolution,
  conflictReport,
  type MergedChange,
  type Question,
  type ThreeWay,
} from './resolve.js';
import type { Form } from './schema.js';
import { drafts } from './tables.js';

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
        revision: sql`case when ${drafts.revision} = ${revision ?? ''} then ${nextRevision(revision)} else null end`,
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
