import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { type ContentFile, type ContentIndex, entryKey, indexHasPath } from '../content/entries.js';
import { offeredEntry, parseEntry, stringifyEntry, withSource } from '../content/entry-format.js';
import { batchAll, chunksOf, D1_MAX_BOUND_PARAMETERS, type Db } from '../db.js';
import { blobSha, type GitClient } from '../publishing/git.js';
import { drafts, pathReservations } from '../tables.js';
import { loadDraft, nextRevision, stampOf } from './drafts.js';
import type { PathReservation } from './paths.js';

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
  await batchAll(db, fence ? [fence, ...writes] : writes);
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
