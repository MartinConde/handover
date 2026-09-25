import config from 'virtual:handover/config';
import index from 'virtual:handover/index';
import type { IndexEntry } from '@handover/core';
import {
  addressError,
  beginOperation,
  changeSource,
  collectionEntries,
  DraftRevisionError,
  deleteLocales,
  discardDraft,
  driftReport,
  entryAddress,
  entrySource,
  entryUrl,
  finalizeOperation,
  findOperation,
  formOf,
  isDraftRace,
  loadDraft,
  lockHolder,
  logActivity,
  markOperationCommitted,
  OperationFinalizationError,
  overlayRows,
  parseEntry,
  recordDelete,
  recordOffer,
  recoverOperationCommit,
  resolveDrift,
  rewriteDrafts,
  setEntryAddress,
  setEntryLocales,
  setEntryStatus,
  sourceOnlyConflicts,
  stringifyEntry,
} from '@handover/core';
import { formSchema } from '../../../index.js';
import { entryProblems } from '../../../problems.js';
import { readJson } from '../body.js';
import {
  codedError,
  entryFiles,
  entryLocales,
  entryPath,
  entrySourceFor,
  entrySubject,
  formFor,
  heldByAnother,
  isHolder,
  localeData,
  locationOf,
  offeredIn,
  schemaOf,
  sourceRefusal,
  tabOf,
} from '../content.js';
import type { RequestContext } from '../environment.js';
import { object, unresolvedSource } from './editing.js';
import { entryNotFound } from './reading.js';

/** The mark lives in the files, so turning off a published language commits a delete. */
export async function offering(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const body = (await readJson(request)) as
    | { locales?: unknown; redirect?: { kind?: unknown; value?: unknown } }
    | undefined;
  const wanted = Array.isArray(body?.locales) ? body.locales : [];
  const offered = config.i18n.locales.filter((locale) => wanted.includes(locale));
  const answer = body?.redirect ?? { kind: 'index' };
  const retryKey = `locale-off:${collection}/${slug}:${offered.join(',')}:${JSON.stringify(answer)}`;
  const database = ctx.db();
  const git = ctx.git();
  const existing = await findOperation('default', database, retryKey);
  const completed = existing?.result as { commit_sha?: unknown } | null;
  if (existing?.state === 'finalized' && typeof completed?.commit_sha === 'string')
    return Response.json({ commit_sha: completed.commit_sha });
  const baseSha = existing?.baseSha ?? (await git.getHead());
  const capturedFiles = await entryFiles(git, collection, slug, baseSha);
  const capturedRows = await Promise.all(
    capturedFiles.map(({ path }) => loadDraft('default', database, path)),
  );
  const written = capturedFiles
    .filter(({ file }, index) => file || capturedRows[index])
    .map(({ locale }) => locale);
  if (!written.length) return new Response('Not found', { status: 404 });
  const going = written.filter((locale) => !offered.includes(locale));
  const staying = written.filter((locale) => offered.includes(locale));
  const effective = Object.fromEntries(
    capturedFiles.flatMap(({ locale, file }, index) => {
      const contents = capturedRows[index]?.contents || file?.contents;
      return contents || file ? [[locale, parseEntry('default', contents ?? '') ?? {}]] : [];
    }),
  );
  const resolved = entrySource('default', config.i18n, effective);
  if (resolved && 'problem' in resolved) return sourceRefusal(resolved, effective);
  // A change to the set of files is when an inferred source must be frozen into the ones kept.
  const stamp =
    resolved && 'locale' in resolved && (going.length || resolved.recorded)
      ? resolved.locale
      : undefined;
  const files = going.length ? capturedFiles : [];
  // A draft-only language cannot stand in for a published one this commit takes away.
  const published = files.filter((f) => f.file).map((f) => f.locale);
  const left = published.length ? published.filter((l) => !going.includes(l)) : staying;
  if (going.length && !left.length)
    return Response.json(
      staying.length
        ? {
            code: 'ENTRY_LOCALE_LAST_PUBLISHED',
            error: `Turning ${going.join(', ')} off would leave this entry with no published file: publish ${staying.join(', ')} first, or Delete the entry`,
            locales: going,
            remaining: staying,
          }
        : {
            code: 'ENTRY_LOCALE_LAST_FILE',
            error: `Turning ${going.join(', ')} off would leave this entry with no file in any language: Delete the entry instead, which asks where its readers should go`,
            locales: going,
          },
      { status: 409 },
    );
  // Only a deliberate change of source may leave the entry without the language it is written in.
  if (resolved && 'locale' in resolved && going.includes(resolved.locale))
    return Response.json(
      {
        code: 'ENTRY_LOCALE_IS_SOURCE',
        error: `${resolved.locale} is the language this entry is written in, so it cannot be turned off`,
        locale: resolved.locale,
      },
      { status: 409 },
    );
  const pathsOf = (locales: string[]) => locales.map((l) => entryPath(collection, slug, l));
  if (published.some((locale) => going.includes(locale))) {
    // The same question a hide asks, resolved the same way per language.
    const picked =
      answer.kind === 'entry'
        ? collectionEntries(
            'default',
            index,
            String(answer.value ?? '').split('/')[0] ?? '',
            await overlayRows('default', database, index),
          )
        : undefined;
    const revisions = Object.fromEntries(
      files.map(({ path }, index) => [path, capturedRows[index]?.revision ?? '']),
    );
    const operation =
      existing ??
      (await beginOperation('default', database, {
        retryKey,
        kind: 'locale-off',
        paths: [...files.map((file) => file.path), 'src/content/redirects.yaml'],
        revisions,
        baseSha,
        userId: session?.user.id,
        subject: files.find((file) => file.file)?.path ?? files[0]?.path ?? null,
        detail: { locales: going },
      }));
    let commit_sha: string | undefined = operation.commitSha ?? undefined;
    if (!commit_sha) commit_sha = await recoverOperationCommit('default', database, git, operation);
    let kept: { path: string; contents: string }[];
    if (!commit_sha) {
      const committed = await deleteLocales(
        'default',
        git,
        locationOf(collection),
        slug,
        going,
        offered,
        (locale) => redirectTarget(answer, collected, picked, locale),
        { baseSha: operation.baseSha, operationId: operation.id, source: stamp },
      );
      commit_sha = committed.commit_sha;
      kept = committed.kept;
    } else {
      kept = (
        await Promise.all(
          staying.map(async (locale) => {
            const path = entryPath(collection, slug, locale);
            const file = await git.getFile(path, commit_sha);
            return file ? { path, contents: file.contents } : undefined;
          }),
        )
      ).filter((file): file is { path: string; contents: string } => Boolean(file));
    }
    const result = { commit_sha };
    await markOperationCommitted('default', database, operation.id, commit_sha, result);
    const offer = { offered, locales: config.i18n.locales, source: stamp };
    try {
      for (const { locale, path, file } of files) {
        if (!going.includes(locale)) continue;
        // A language with a draft and a file loses both, or the row would republish the file.
        if (file)
          await recordDelete('default', database, path, commit_sha, operation.revisions[path]);
        else await discardDraft('default', database, path, operation.revisions[path]);
      }
      for (const file of kept)
        await recordOffer('default', database, file.path, file.contents, offer, commit_sha);
      // A staying language with only a draft is not in the commit, so its draft takes the mark.
      const drafted = staying.filter((l) => !files.some((f) => f.locale === l && f.file));
      if (drafted.length)
        await setEntryLocales(
          'default',
          database,
          git,
          pathsOf(drafted),
          offered,
          config.i18n.locales,
          stamp,
        );
      await finalizeOperation('default', database, operation.id);
    } catch (cause) {
      throw new OperationFinalizationError(operation.id, commit_sha, { cause });
    }
    // Logged so the Deleted view can say what it would put back without asking git.
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'locale-off',
      subject: await entrySubject(ctx, collection, slug),
      detail: { locales: going },
      commitSha: commit_sha,
    });
    return Response.json(result);
  }
  // Nothing that goes is in the repository, so there is nothing to commit or redirect.
  for (const { locale, path } of files)
    if (going.includes(locale)) await discardDraft('default', database, path);
  await setEntryLocales(
    'default',
    database,
    git,
    pathsOf(staying),
    offered,
    config.i18n.locales,
    stamp,
  );
  return Response.json({});
}

/** Other entries' file names count too: clearing an address falls back to the name. */
async function takenAddresses(
  ctx: RequestContext,
  collection: string,
  locale: string,
  slug: string,
): Promise<string[]> {
  const rows = await overlayRows('default', ctx.db(), index);
  return collectionEntries('default', index, collection, rows)
    .filter((entry) => entry.id !== slug)
    .flatMap((entry) => [entry.id, entry.locales[locale]?.slug ?? '']);
}

/** A moved address's redirect waits on the draft: the old URL is live until publish. */
export async function address(
  ctx: RequestContext,
  collection: string,
  slug: string,
  locale: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected?.localizedSlugs || !config.i18n.locales.includes(locale))
    return new Response('Not found', { status: 404 });
  const body = (await readJson(request)) as { address?: unknown } | undefined;
  const wanted = typeof body?.address === 'string' ? body.address.trim() : '';
  const bad = addressError('default', wanted);
  if (bad)
    return Response.json(
      {
        code: wanted.length > 80 ? 'ENTRY_ADDRESS_TOO_LONG' : 'ENTRY_ADDRESS_INVALID',
        error: bad,
        ...(wanted.length > 80 ? { limit: 80 } : {}),
      },
      { status: 422 },
    );
  const path = entryPath(collection, slug, locale);
  const git = ctx.git();
  const [file, row] = await Promise.all([git.getFile(path), loadDraft('default', ctx.db(), path)]);
  if (!file && !row) return new Response('Not found', { status: 404 });
  const refused = await unresolvedSource(ctx, collection, slug);
  if (refused) return refused;
  // Empty falls back to the file name, so that is the address being claimed either way.
  const after = wanted || slug;
  if ((await takenAddresses(ctx, collection, locale, slug)).includes(after))
    return Response.json(
      {
        code: 'ENTRY_ADDRESS_TAKEN',
        error: `${JSON.stringify(after)} is already the web address of another entry in ${collection} in ${locale}`,
        address: after,
        collection,
        locale,
      },
      { status: 409 },
    );
  // Only a published address can have been followed, and only via the collection's route.
  const was = file ? entryAddress('default', parseEntry('default', file.contents), slug) : after;
  const from = entryUrl('default', config.i18n, collected.route, was, locale);
  const to = entryUrl('default', config.i18n, collected.route, after, locale);
  await setEntryAddress(
    'default',
    ctx.db(),
    git,
    // The whole form, `slug` included: the file writes it where the schema says.
    formOf('default', formSchema(collected.schema)),
    path,
    wanted,
    from && to && from !== to ? { from, to, entry: `${collection}/${slug}` } : undefined,
    session?.user.id,
  );
  return Response.json({});
}

/** Resolved per language; a picked entry missing there falls back to its index, then home. */
export function redirectTarget(
  target: { kind?: unknown; value?: unknown } | undefined,
  collected: { index?: string },
  entries: IndexEntry[] | undefined,
  locale: string,
): string | undefined {
  const value = typeof target?.value === 'string' ? target.value : '';
  if (target?.kind === 'url') return value || undefined;
  if (target?.kind === 'index')
    return entryUrl('default', config.i18n, collected.index, '', locale);
  if (target?.kind !== 'entry') return undefined;
  const [name = '', id = ''] = value.split('/');
  const picked = config.collections[name];
  if (!picked) return undefined;
  const found = entries?.find((e) => e.id === id);
  const address = picked.localizedSlugs ? (found?.locales[locale]?.slug ?? id) : id;
  return (
    (found?.locales[locale] && entryUrl('default', config.i18n, picked.route, address, locale)) ||
    entryUrl('default', config.i18n, picked.index, '', locale) ||
    entryUrl('default', config.i18n, '/', '', locale)
  );
}

/** Nothing commits here: the redirects wait on the rows and go out with the publish. */
export async function setStatus(
  ctx: RequestContext,
  collection: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const body = (await readJson(request)) as
    | { entries?: unknown; hidden?: unknown; redirect?: { kind?: unknown; value?: unknown } }
    | undefined;
  const slugs = Array.isArray(body?.entries)
    ? body.entries.filter((e): e is string => typeof e === 'string')
    : [];
  if (!slugs.length) return new Response('Name the entries to hide or show', { status: 400 });
  const hidden = body?.hidden === true;
  // Before any of them is written: a batch half hidden is worse than one refused.
  for (const slug of slugs) {
    const held = await heldByAnother(ctx, collection, slug, session, hidden ? 'hidden' : 'shown');
    if (held) return held;
    const refused = await unresolvedSource(ctx, collection, slug);
    if (refused) return refused;
  }
  const database = ctx.db();
  const git = ctx.git();
  // The bulk dialog is answered once, so the entries a rule could point at are read once too.
  const picked =
    hidden && body?.redirect?.kind === 'entry'
      ? collectionEntries(
          'default',
          index,
          String(body.redirect.value ?? '').split('/')[0] ?? '',
          await overlayRows('default', database, index),
        )
      : undefined;
  // The whole form, `slug` included: the rewrite must leave it where the schema puts it.
  const form = formOf('default', formSchema(collected.schema));
  for (const slug of slugs) {
    const files = await entryFiles(git, collection, slug);
    await setEntryStatus(
      'default',
      database,
      git,
      form,
      files.map(({ locale, path, file }) => {
        // A language with no committed file owes no redirect: nobody could have followed it.
        const was = file
          ? entryUrl(
              'default',
              config.i18n,
              collected.route,
              entryAddress('default', parseEntry('default', file.contents), slug),
              locale,
            )
          : undefined;
        const to = hidden ? redirectTarget(body?.redirect, collected, picked, locale) : undefined;
        return { path, redirect: was && to && was !== to ? { from: was, to } : undefined };
      }),
      hidden,
    );
  }
  return Response.json({});
}

/** Nothing is marked resolved: the next read's empty report is what clears the banner. */
export async function reconcile(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const schema = schemaOf(collection, slug);
  if (!schema) return new Response('Not found', { status: 404 });
  const body = (await readJson(request)) as { choices?: unknown } | undefined;
  const choices = (Array.isArray(body?.choices) ? body.choices : []).filter(
    (choice): choice is { path: string; locales: string[] } =>
      typeof choice?.path === 'string' &&
      Array.isArray(choice.locales) &&
      choice.locales.every((locale: unknown) => typeof locale === 'string'),
  );
  const form = formFor(collection, slug);
  const locales = localeData(await entryLocales(ctx, collection, slug, config.i18n.locales));
  const source = entrySource('default', config.i18n, locales);
  if (source && 'problem' in source) return sourceRefusal(source, locales);
  const drift = new Set(driftReport('default', form, locales).map((row) => row.path));
  // A row the languages agree about has nothing to answer: the report moved on under the tab.
  if (!choices.length || choices.some((choice) => !drift.has(choice.path)))
    return new Response("Those are not the blocks this entry's languages disagree about", {
      status: 409,
    });
  await resolveDrift(
    'default',
    ctx.db(),
    ctx.git(),
    form,
    config.i18n.locales,
    Object.fromEntries(Object.keys(locales).map((l) => [l, entryPath(collection, slug, l)])),
    choices,
    session?.user.id,
  );
  return Response.json({});
}

/** Drafts only: the site and the build keep the old source until the entry publishes whole. */
export async function changeEntrySource(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!session) return new Response('Unauthorized', { status: 401 });
  const body = (await readJson(request)) as
    | { locale?: unknown; tab?: unknown; revisions?: unknown }
    | undefined;
  const holder = await lockHolder('default', ctx.db(), `${collection}/${slug}`);
  if (holder && !isHolder(holder, session, tabOf(body)))
    return Response.json(
      {
        held_by: { id: holder.userId, name: holder.name },
        mine: false,
        expires_at: holder.expiresAt,
      },
      { status: 409 },
    );
  const schema = schemaOf(collection, slug);
  const revisions = body?.revisions;
  if (
    revisions !== undefined &&
    (!object(revisions) || Object.values(revisions).some((r) => typeof r !== 'string'))
  )
    return new Response('Bad request', { status: 400 });
  const { loaded, source } = schema
    ? await entrySourceFor(ctx, collection, slug)
    : { loaded: {}, source: undefined };
  if (!schema || !source) return entryNotFound();
  const to = body?.locale;
  if (typeof to !== 'string' || !config.i18n.locales.includes(to))
    return codedError(
      400,
      'ENTRY_SOURCE_TARGET_UNDECLARED',
      `${String(to)} is not a language this site declares`,
    );
  // Without one (the files disagree or name a language they cannot have) this is the recovery.
  const from = 'locale' in source ? source.locale : undefined;
  if (to === from)
    return codedError(409, 'ENTRY_SOURCE_UNCHANGED', `This entry is already written in ${to}`);
  const files = localeData(loaded);
  const present = config.i18n.locales.filter((locale) => locale in files);
  // Off before missing: a language turned off has no file either, and "off" is why.
  if (!offeredIn(files[from ?? present[0] ?? ''], present).offered.includes(to))
    return codedError(409, 'ENTRY_SOURCE_TARGET_OFF', `This entry is not offered in ${to}`);
  if (!(to in files))
    return codedError(
      409,
      'ENTRY_SOURCE_TARGET_MISSING',
      `This entry has no ${to} file yet: create it before making it the source`,
    );
  // A recovery has no revisions to send, as the entry never opened; the write still asserts them.
  const expected = (revisions ?? (from === undefined ? undefined : {})) as
    | Record<string, string>
    | undefined;
  const moved = () =>
    codedError(
      409,
      'ENTRY_SOURCE_REVISION',
      'This entry changed since it was opened. Reload it and choose again.',
    );
  if (
    expected &&
    [...new Set([...Object.keys(expected), ...Object.keys(loaded)])].some(
      (locale) => expected[locale] !== loaded[locale]?.revision,
    )
  )
    return moved();
  const form = formFor(collection, slug);
  if (from !== undefined && driftReport('default', form, files).length)
    return codedError(
      409,
      'ENTRY_SOURCE_DRIFT',
      "This entry's languages disagree about which blocks it has. Reconcile them first.",
    );
  const paths = from === undefined ? [] : sourceOnlyConflicts(form, files[from], files[to]);
  if (paths.length)
    return codedError(
      409,
      'ENTRY_SOURCE_ONLY_CONFLICT',
      `The ${to} file has its own values in fields only the source keeps: clear them first`,
      { paths },
    );
  const changed = await changeSource('default', form, files, {
    from,
    to,
    at: new Date().toISOString(),
  });
  const problems = from === undefined ? [] : entryProblems(schema, changed[to]);
  if (problems.length)
    return codedError(
      422,
      'ENTRY_SOURCE_TARGET_INVALID',
      `The ${to} file would not pass the site's checks as the source: fix it first`,
      { problems },
    );
  try {
    await rewriteDrafts(
      'default',
      ctx.db(),
      ctx.git(),
      Object.entries(changed).map(([locale, data]) => ({
        path: entryPath(collection, slug, locale),
        revision: loaded[locale]?.revision,
        contents: stringifyEntry('default', data),
        preserveProvenance: true,
      })),
      session.user.id,
      config.i18n.locales.map((locale) => ({
        path: entryPath(collection, slug, locale),
        revision: loaded[locale]?.revision,
      })),
    );
  } catch (err) {
    if (err instanceof DraftRevisionError || isDraftRace(err)) return moved();
    throw err;
  }
  await logActivity('default', ctx.db(), {
    userId: session.user.id,
    kind: 'entry-source',
    subject: entryPath(collection, slug, to),
    detail: { from: from ?? null, to },
  });
  return Response.json({ source: to });
}
