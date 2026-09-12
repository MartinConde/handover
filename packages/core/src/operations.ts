import { and, desc, eq, ne } from 'drizzle-orm';
import type { Db } from './db.js';
import { type GitClient, RefMovedError } from './git.js';
import { operations } from './tables.js';

export type Operation = typeof operations.$inferSelect;

/** Git is immutable and succeeded; retrying this operation resumes only its D1 finalization. */
export class OperationFinalizationError extends Error {
  override name = 'OperationFinalizationError';
  constructor(
    readonly operationId: string,
    readonly commitSha: string,
    options?: ErrorOptions,
  ) {
    super(
      'The commit succeeded, but its database finalization still needs to be retried.',
      options,
    );
  }
}

export interface OperationIntent {
  retryKey: string;
  kind: string;
  paths: string[];
  revisions?: Record<string, string>;
  baseSha: string;
  userId?: string | null;
  subject?: string | null;
  detail?: unknown;
}

/** Recovery records are authority, not telemetry, and therefore have no automatic expiry. */
export async function findOperation(
  siteId: string,
  db: Db,
  retryKey: string,
): Promise<Operation | undefined> {
  const [found] = await db
    .select()
    .from(operations)
    .where(and(eq(operations.siteId, siteId), eq(operations.retryKey, retryKey)))
    .limit(1);
  return found;
}

/** Small bounded recovery scan for requests whose generated subject is not in the retry body. */
export async function recentOperations(siteId: string, db: Db, kind: string): Promise<Operation[]> {
  return db
    .select()
    .from(operations)
    .where(and(eq(operations.siteId, siteId), eq(operations.kind, kind)))
    .orderBy(desc(operations.createdAt), desc(operations.id))
    .limit(20);
}

/** Insert intent before Git. A racing identical request joins the row that won. */
export async function beginOperation(
  siteId: string,
  db: Db,
  intent: OperationIntent,
): Promise<Operation> {
  const id = crypto.randomUUID();
  await db
    .insert(operations)
    .values({
      id,
      siteId,
      retryKey: intent.retryKey,
      kind: intent.kind,
      state: 'intent',
      paths: [...new Set(intent.paths)].sort(),
      revisions: intent.revisions ?? {},
      baseSha: intent.baseSha,
      userId: intent.userId ?? null,
      subject: intent.subject ?? null,
      detail: intent.detail ?? null,
      createdAt: Date.now(),
    })
    .onConflictDoNothing({ target: [operations.siteId, operations.retryKey] });
  const found = await findOperation(siteId, db, intent.retryKey);
  if (!found) throw new Error('The operation intent could not be recorded');
  return found;
}

const TRAILER = 'Handover-Operation';

/** The marker lets a retry recognize Git success even when its response never arrived. */
export const operationMessage = (message: string, id: string): string =>
  `${message}\n\n${TRAILER}: ${id}`;

const marks = (message: string, id: string) =>
  message.split('\n').some((line) => line.trim() === `${TRAILER}: ${id}`);

type RecoveryGit = Pick<GitClient, 'getHead'> &
  Partial<Pick<GitClient, 'getCommit' | 'fileCommits'>>;

/** Find an immutable Git result, or prove that the original base is still safe to write. */
export async function recoverOperationCommit(
  siteId: string,
  db: Db,
  git: RecoveryGit,
  operation: Operation,
): Promise<string | undefined> {
  if (operation.commitSha) return operation.commitSha;
  const [latest] = await db
    .select({ commitSha: operations.commitSha })
    .from(operations)
    .where(and(eq(operations.siteId, siteId), eq(operations.id, operation.id)))
    .limit(1);
  if (latest?.commitSha) return latest.commitSha;
  const head = await git.getHead();
  const candidates = new Set<string>([head]);
  const firstPath = operation.paths[0];
  if (firstPath && git.fileCommits) {
    for (const commit of await git.fileCommits(firstPath, { perPage: 20 }))
      if (marks(commit.message, operation.id)) candidates.add(commit.sha);
  }
  if (git.getCommit) {
    for (const sha of candidates) {
      const commit = await git.getCommit(sha).catch(() => undefined);
      if (!commit || !marks(commit.message, operation.id)) continue;
      if (
        commit.parent !== operation.baseSha ||
        commit.paths.some((path) => !operation.paths.includes(path))
      )
        throw new Error('The recovered commit is outside its recorded operation scope');
      await markOperationCommitted(siteId, db, operation.id, sha, operation.result);
      return sha;
    }
  }
  if (head !== operation.baseSha) throw new RefMovedError();
  return undefined;
}

export async function markOperationCommitted(
  siteId: string,
  db: Db,
  id: string,
  commitSha: string,
  result: unknown,
): Promise<void> {
  const [row] = await db
    .select({ commitSha: operations.commitSha })
    .from(operations)
    .where(and(eq(operations.siteId, siteId), eq(operations.id, id)))
    .limit(1);
  if (row?.commitSha && row.commitSha !== commitSha)
    throw new Error('The operation already names a different commit');
  await db
    .update(operations)
    .set({ state: 'committed', commitSha, result, committedAt: Date.now() })
    .where(
      and(eq(operations.siteId, siteId), eq(operations.id, id), ne(operations.state, 'finalized')),
    );
}

/** Appended to the domain writes so D1 never says finalized without their success. */
export const finalizeOperationStatement = (siteId: string, db: Db, id: string) =>
  db
    .update(operations)
    .set({ state: 'finalized', finalizedAt: Date.now() })
    .where(
      and(eq(operations.siteId, siteId), eq(operations.id, id), eq(operations.state, 'committed')),
    );

export async function finalizeOperation(siteId: string, db: Db, id: string): Promise<void> {
  await finalizeOperationStatement(siteId, db, id);
}
