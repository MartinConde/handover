import { and, eq, gt, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { entryKey } from '../content/entries.js';
import { parseEntry, stringifyEntry, writtenEntry } from '../content/entry-format.js';
import { REDIRECTS, type RedirectRule } from '../content/redirects.js';
import { chunksOf, D1_MAX_BOUND_PARAMETERS, type Db, type Draft } from '../db.js';
import { loadDraft, nextRevision } from '../drafts/drafts.js';
import { keptSource } from '../drafts/entry-settings.js';
import { drafts, locks } from '../tables.js';
import { blobSha, type GitClient, type PublishFile } from './git.js';
import {
  beginOperation,
  finalizeOperationStatement,
  findOperation,
  markOperationCommitted,
  OperationFinalizationError,
  operationMessage,
  recoverOperationCommit,
} from './operations.js';
import { CommitScopeError, commitScope } from './publish.js';

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

/** Invert only the rules this commit changed; overlapping later edits refuse the whole undo. */
export async function revertRedirects(
  siteId: string,
  git: Pick<GitClient, 'getFile'>,
  at: { commit: string; parent: string; head: string },
): Promise<PublishFile | undefined> {
  const doc = async (ref: string) => {
    const file = await git.getFile(REDIRECTS, ref);
    return file ? (parseEntry(siteId, file.contents) as { rules?: RedirectRule[] }) : undefined;
  };
  const [before, after, head] = await Promise.all([doc(at.parent), doc(at.commit), doc(at.head)]);
  const byId = (rules: readonly RedirectRule[]) => new Map(rules.map((r) => [r._id, r]));
  const was = byId(before?.rules ?? []);
  const wrote = byId(after?.rules ?? []);
  const current = byId(head?.rules ?? []);
  const equal = (a: RedirectRule | undefined, b: RedirectRule | undefined) =>
    JSON.stringify(a && Object.entries(a).sort(([a], [b]) => a.localeCompare(b))) ===
    JSON.stringify(b && Object.entries(b).sort(([a], [b]) => a.localeCompare(b)));
  const changed = [...new Set([...was.keys(), ...wrote.keys()])].filter(
    (id) => !equal(was.get(id), wrote.get(id)),
  );
  if (!changed.length) return undefined;
  for (const id of changed) {
    if (!equal(current.get(id), wrote.get(id))) throw new RevertConflictError([REDIRECTS]);
    const restored = was.get(id);
    // A later rule can claim an address under a different ID too.
    if (
      restored &&
      [...current.values()].some(
        (r) => r._id !== id && !changed.includes(r._id) && r.from === restored.from,
      )
    )
      throw new RevertConflictError([REDIRECTS]);
  }
  for (const id of changed) {
    const restored = was.get(id);
    if (restored) current.set(id, restored);
    else current.delete(id);
  }
  return {
    path: REDIRECTS,
    contents: stringifyEntry(siteId, { ...(head ?? before), rules: [...current.values()] }),
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
            revision: nextRevision(revision),
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
const MARKS = ['_locales', '_i18n', '_source'];

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
    const contents = stringifyEntry(siteId, keptSource(siteId, writtenEntry(siteId, entry)));
    if (contents === open.contents) continue;
    await db
      .update(drafts)
      .set({
        contents,
        revision: sql`case when ${drafts.revision} = ${open.revision} then ${nextRevision(open.revision)} else null end`,
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
  deployment: DeploymentGit,
  now = Date.now(),
): Promise<string[]> {
  let rows = await db
    .select({
      path: drafts.path,
      revision: drafts.revision,
      baseBlob: drafts.baseBlob,
      publishedSha: drafts.publishedSha,
    })
    .from(drafts)
    .where(and(eq(drafts.siteId, siteId), isNotNull(drafts.publishedSha), ne(drafts.contents, '')));
  if (!rows.length) return [];
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
        row.publishedSha && deployedBlobs.get(row.path) !== row.baseBlob ? [row.publishedSha] : [],
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
