import { and, eq, sql } from 'drizzle-orm';
import { type Db, type Draft, heldDrafts, pendingDrafts, SOURCE_CHANGE_REVISION } from './db.js';
import { entryKey } from './entries.js';
import { parseEntry } from './entry-format.js';
import { blobSha, type GitClient, type PublishFile, RefMovedError } from './git.js';
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
import { markTranslation } from './provenance.js';
import { appendRedirects, REDIRECTS, type RedirectRule } from './redirects.js';
import { isLive } from './reserved.js';
import type { Form } from './schema.js';
import { activity, drafts, operations } from './tables.js';

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
  durable?: { userId?: string; baseSha?: string },
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
  // A caller that judged the selection at one revision commits on that one or not at all, and a
  // moved branch is refused before an operation is recorded that every retry would then find.
  const base_sha = existing?.baseSha ?? durable?.baseSha ?? (await git.getHead());
  if (!existing && durable?.baseSha && (await git.getHead()) !== durable.baseSha)
    throw new RefMovedError(`the branch moved past ${durable.baseSha}`);
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
      if (rows[i]?.revision.startsWith(SOURCE_CHANGE_REVISION)) return { path, contents };
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
