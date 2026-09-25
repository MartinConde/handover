import config from 'virtual:handover/config';
import index from 'virtual:handover/index';
import {
  beginOperation,
  collectionEntries,
  createDrafts,
  deleteEntry,
  discardDraft,
  dropLock,
  duplicateEntry,
  entryName,
  finalizeOperation,
  findOperation,
  loadDraft,
  logActivity,
  markOperationCommitted,
  moveLock,
  OperationFinalizationError,
  overlayRows,
  parseEntry,
  RenameCollisionError,
  recordDelete,
  recordRenames,
  recoverOperationCommit,
  releaseOperationPaths,
  releasePaths,
  renameEntry,
  reservePaths,
} from '@handover/core';
import type { RequestContext } from '../../../environment.js';
import { readJson } from '../body.js';
import {
  entryFiles,
  entryPath,
  entrySubject,
  heldByAnother,
  locationOf,
  pendingLocales,
  redirectTarget,
  schemaOf,
  takenNames,
  unresolvedSource,
} from '../content.js';

// Same derivation as a new entry's: a rename cannot produce a name the CMS could not create.
export async function rename(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!config.collections[collection]) return new Response('Not found', { status: 404 });
  const held = await heldByAnother(ctx, collection, slug, session, 'renamed');
  if (held) return held;
  const body = (await readJson(request)) as { to?: unknown } | undefined;
  const database = ctx.db();
  const git = ctx.git();
  const taken = (await takenNames(collection, database)).filter((id) => id !== slug);
  const to = entryName('default', typeof body?.to === 'string' ? body.to : '', taken);
  if (to === slug) return Response.json({ slug });
  const retryKey = `entry-rename:${collection}/${slug}:${to}`;
  const existing = await findOperation('default', database, retryKey);
  const completed = existing?.result as { commit_sha?: unknown; slug?: unknown } | null;
  if (
    existing?.state === 'finalized' &&
    typeof completed?.commit_sha === 'string' &&
    completed.slug === to
  ) {
    await releaseOperationPaths('default', database, existing.id);
    return Response.json({ slug: to, commit_sha: completed.commit_sha });
  }
  // A rename already under way is finished, not refused halfway.
  if (!existing) {
    const refused = await unresolvedSource(ctx, collection, slug);
    if (refused) return refused;
  }
  const baseSha = existing?.baseSha ?? (await git.getHead());
  const files = await entryFiles(git, collection, slug, baseSha);
  if (!files.some((f) => f.file) && !existing)
    return new Response('Publish this entry before renaming it', { status: 409 });
  const revisionEntries = await Promise.all(
    files.map(async ({ path }) => {
      const row = await loadDraft('default', database, path);
      return row ? ([path, `${row.revision}:${row.baseSha}:${row.baseBlob}`] as const) : undefined;
    }),
  );
  const revisions = Object.fromEntries(revisionEntries.flatMap((entry) => (entry ? [entry] : [])));
  const operation =
    existing ??
    (await beginOperation('default', database, {
      retryKey,
      kind: 'entry-rename',
      paths: [
        ...config.i18n.locales.flatMap((locale) => [
          entryPath(collection, slug, locale),
          entryPath(collection, to, locale),
        ]),
        'src/content/redirects.yaml',
      ],
      revisions,
      baseSha,
      userId: session?.user.id,
      subject: entryPath(collection, to, config.i18n.defaultLocale),
      detail: { from: slug },
    }));
  const reservation = await reservePaths(
    'default',
    database,
    config.i18n.locales.map((locale) => entryPath(collection, to, locale)),
    operation.id,
  );
  let finalized = false;
  let safelyAborted = false;
  try {
    let commit_sha: string | undefined = operation.commitSha ?? undefined;
    if (!commit_sha) commit_sha = await recoverOperationCommit('default', database, git, operation);
    if (!commit_sha) {
      let committed: Awaited<ReturnType<typeof renameEntry>>;
      try {
        committed = await renameEntry('default', git, locationOf(collection), slug, to, {
          baseSha: operation.baseSha,
          operationId: operation.id,
        });
      } catch (error) {
        // This check happens before publish, so unlike an unknown provider failure it proves
        // that no external mutation needs recovery and the destination can be released.
        if (error instanceof RenameCollisionError) safelyAborted = true;
        throw error;
      }
      commit_sha = committed.commit_sha;
    }
    const result = { slug: to, commit_sha };
    await markOperationCommitted('default', database, operation.id, commit_sha, result);
    const latest = await findOperation('default', database, retryKey);
    if (latest?.state === 'finalized') {
      finalized = true;
      return Response.json(result);
    }
    const committed = (
      await Promise.all(
        config.i18n.locales.map(async (locale) => {
          const file = await git.getFile(entryPath(collection, to, locale), commit_sha);
          return file ? { locale, contents: file.contents } : undefined;
        }),
      )
    ).filter((file): file is { locale: string; contents: string } => Boolean(file));
    const contents = new Map(committed.map((file) => [file.locale, file.contents]));
    try {
      await recordRenames(
        'default',
        database,
        files.map(({ locale, path, file }) => ({
          from: path,
          to: entryPath(collection, to, locale),
          // The retry reads the committed result; the first request can reuse its
          // already captured base bytes if a test double or provider omits that read.
          contents: contents.get(locale) ?? file?.contents,
        })),
        commit_sha,
        session?.user.id,
        reservation,
      );
      // Whoever has the entry open keeps it under its new name.
      await moveLock('default', database, `${collection}/${slug}`, `${collection}/${to}`);
      await finalizeOperation('default', database, operation.id);
      finalized = true;
    } catch (cause) {
      throw new OperationFinalizationError(operation.id, commit_sha, { cause });
    }
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'entry-rename',
      subject: await entrySubject(ctx, collection, to),
      detail: { from: slug },
      commitSha: commit_sha,
    });
    return Response.json(result);
  } finally {
    // A committed-but-unfinalized operation keeps owning its destination across restarts.
    if (finalized || safelyAborted) await releasePaths('default', database, reservation);
  }
}

/** Hidden and without stale marks; `drafts` copies unpublished bytes over the commit. */
export async function duplicate(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!config.collections[collection]) return new Response('Not found', { status: 404 });
  const refused = await unresolvedSource(ctx, collection, slug);
  if (refused) return refused;
  const body = (await readJson(request)) as { to?: unknown; drafts?: unknown } | undefined;
  const database = ctx.db();
  const git = ctx.git();
  const files = await entryFiles(git, collection, slug);
  // Same refusal as a rename: what is copied is what the repository has.
  if (!files.some((f) => f.file))
    return new Response('Publish this entry before duplicating it', { status: 409 });
  const wanted = typeof body?.to === 'string' && body.to ? body.to : `${slug}-copy`;
  const to = entryName('default', wanted, await takenNames(collection, database));
  const drafted: Record<string, string> = {};
  if (body?.drafts === true)
    for (const { locale, path } of files) {
      const row = await loadDraft('default', database, path);
      if (row?.contents) drafted[locale] = row.contents;
    }
  const copies = await duplicateEntry('default', git, locationOf(collection), slug, to, drafted);
  await createDrafts(
    'default',
    database,
    git,
    copies.map((copy) => {
      const values = parseEntry('default', copy.contents) as Record<string, unknown>;
      delete values._i18n;
      values._status = 'hidden';
      return { path: copy.path, values };
    }),
  );
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'entry-duplicate',
    // Read off the copies: nothing of the copy is in the repository yet.
    subject: copies[0]?.path ?? null,
    detail: { from: slug },
  });
  return Response.json({ slug: to });
}

/** A delete commits now, so the redirect rules go into the commit that takes the files away. */
export async function remove(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request | undefined,
  session: App.Locals['handover'],
): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const held = await heldByAnother(ctx, collection, slug, session, 'deleted');
  if (held) return held;
  const body = (request ? await readJson(request) : undefined) as
    | { redirect?: { kind?: unknown; value?: unknown } }
    | undefined;
  const answer = body?.redirect ?? { kind: 'index' };
  const git = ctx.git();
  const database = ctx.db();
  const entry = `${collection}/${slug}`;
  const retryKey = `entry-delete:${entry}:${JSON.stringify(answer)}`;
  const existing = await findOperation('default', database, retryKey);
  const completed = existing?.result as { commit_sha?: unknown } | null;
  if (existing?.state === 'finalized' && typeof completed?.commit_sha === 'string')
    return Response.json({ commit_sha: completed.commit_sha });
  const baseSha = existing?.baseSha ?? (await git.getHead());
  const files = await entryFiles(git, collection, slug, baseSha);
  if (!files.some((f) => f.file)) {
    if (existing) throw new Error('The recorded delete no longer has its captured files');
    for (const { path } of files) await discardDraft('default', database, path);
    await dropLock('default', database, entry);
    return Response.json({});
  }
  // Read before the commit: afterwards no language is left to name the entry by.
  const subject = await entrySubject(ctx, collection, slug);
  const revisions = Object.fromEntries(
    await Promise.all(
      files.map(async ({ path }) => {
        const row = await loadDraft('default', database, path);
        return [path, row?.revision ?? ''] as const;
      }),
    ),
  );
  const operation =
    existing ??
    (await beginOperation('default', database, {
      retryKey,
      kind: 'entry-delete',
      paths: [...files.map((file) => file.path), 'src/content/redirects.yaml'],
      revisions,
      baseSha,
      userId: session?.user.id,
      subject,
      detail: { locales: files.filter((file) => file.file).map((file) => file.locale) },
    }));
  const picked =
    answer.kind === 'entry'
      ? collectionEntries(
          'default',
          index,
          String(answer.value ?? '').split('/')[0] ?? '',
          await overlayRows('default', database, index),
        )
      : undefined;
  let commit_sha: string | undefined = operation.commitSha ?? undefined;
  if (!commit_sha) commit_sha = await recoverOperationCommit('default', database, git, operation);
  if (!commit_sha) {
    const committed = await deleteEntry(
      'default',
      git,
      locationOf(collection),
      slug,
      (locale) => redirectTarget(answer, collected, picked, locale),
      { baseSha: operation.baseSha, operationId: operation.id },
    );
    commit_sha = committed.commit_sha;
  }
  const result = { commit_sha };
  await markOperationCommitted('default', database, operation.id, commit_sha, result);
  try {
    // A draft-only language is not in the commit, so its captured row goes here.
    for (const { path, file } of files)
      if (file)
        await recordDelete('default', database, path, commit_sha, operation.revisions[path]);
      else await discardDraft('default', database, path, operation.revisions[path]);
    await dropLock('default', database, entry);
    await finalizeOperation('default', database, operation.id);
  } catch (cause) {
    throw new OperationFinalizationError(operation.id, commit_sha, { cause });
  }
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'entry-delete',
    subject,
    detail: { locales: files.filter((f) => f.file).map((f) => f.locale) },
    commitSha: commit_sha,
  });
  return Response.json(result);
}

// The way out of a publish conflict; picking field by field is later.
export async function discard(
  ctx: RequestContext,
  collection: string,
  slug: string,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const database = ctx.db();
  // Read before the rows go: a draft-only entry has no file to name it by afterwards.
  const [subject, went] = await Promise.all([
    entrySubject(ctx, collection, slug),
    pendingLocales(collection, slug, database),
  ]);
  // Every language of it: the others hold the structure this edit gave them.
  for (const locale of config.i18n.locales)
    await discardDraft('default', database, entryPath(collection, slug, locale));
  // Somebody's words went, which typing never records; nothing pending is nothing thrown away.
  if (went.length)
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'draft-discard',
      subject,
      detail: { locales: went },
    });
  return Response.json({});
}
