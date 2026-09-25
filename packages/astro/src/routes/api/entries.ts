import config from 'virtual:handover/config';
import index from 'virtual:handover/index';
import type { Form, IndexEntry, LocaleSeed } from '@handover/core';
import {
  addressError,
  beginOperation,
  changeSource,
  claimLock,
  collectionEntries,
  createDrafts,
  DraftRevisionError,
  deletedEntries,
  deleteEntry,
  deleteLocales,
  discardDraft,
  driftReport,
  dropLock,
  duplicateEntry,
  entryAddress,
  entryKey,
  entryName,
  entrySource,
  entryUrl,
  finalizeOperation,
  findOperation,
  formOf,
  holdEntry,
  isDraftRace,
  isLive,
  isMediaRace,
  loadDraft,
  lockHolder,
  logActivity,
  markOperationCommitted,
  moveLock,
  OperationFinalizationError,
  overlayRows,
  parseEntry,
  RenameCollisionError,
  readRedirects,
  recordDelete,
  recordOffer,
  recordRenames,
  recoverOperationCommit,
  releaseOperationPaths,
  releasePaths,
  renameEntry,
  reservePaths,
  resolveDrift,
  resolveFieldTarget,
  rewriteDrafts,
  saveDraft,
  setEntryAddress,
  setEntryLocales,
  setEntryStatus,
  sourceOnlyConflicts,
  staleLocales,
  stringifyEntry,
  takeLock,
} from '@handover/core';
import { formSchema } from '../../index.js';
import { entryProblems } from '../../problems.js';
import { readJson } from './body.js';
import {
  codedError,
  entryFiles,
  entryLocales,
  entryPath,
  entrySourceFor,
  entrySubject,
  formFor,
  globalLabel,
  globalOf,
  heldByAnother,
  isHolder,
  localeData,
  locationOf,
  offeredIn,
  pendingLocales,
  schemaOf,
  siblingPaths,
  siteSeoDefaults,
  sourceRefusal,
  tabOf,
  takenNames,
  translationSource,
  translator,
} from './content.js';
import type { RequestContext } from './context.js';

/** Committed and draft rules are both read; empty means the client answered "nowhere". */
async function hideTargets(
  ctx: RequestContext,
  collection: string,
  slug: string,
  loaded: Awaited<ReturnType<typeof entryLocales>>,
): Promise<Record<string, string>> {
  // Read at the branch tip `entryLocales` read from, so both sides of the match are one commit.
  const committed = await readRedirects('default', ctx.git());
  const key = `${collection}/${slug}`;
  const rules = [...committed, ...Object.values(loaded).flatMap((l) => l.redirects)].filter(
    (rule) => rule.reason === 'hidden' && rule.entry === key,
  );
  return Object.fromEntries(
    Object.entries(loaded).flatMap(([locale, l]) => {
      const to = rules.find((rule) => rule.from === l.url)?.to;
      return to ? [[locale, to]] : [];
    }),
  );
}

// The draft wins over the file; no sha goes to the browser, bases are compared server-side.
const entryNotFound = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'x-handover-error-code': 'ENTRY_NOT_FOUND' },
  });

export async function getEntry(
  ctx: RequestContext,
  collection: string,
  slug: string,
): Promise<Response> {
  const collected = config.collections[collection];
  const global = globalOf(collection, slug);
  if (!collected && !global) return entryNotFound();
  const schema = global ?? collected?.schema;
  if (!schema) return entryNotFound();
  // One read of every language answers drift, staleness and pending drafts alike.
  const { loaded, source: answer } = await entrySourceFor(ctx, collection, slug, true);
  if (!answer) return entryNotFound();
  if ('problem' in answer) return sourceRefusal(answer, localeData(loaded));
  const source = answer.locale;
  const data = loaded[source]?.data;
  const hidden = !isLive('default', data);
  const form = formFor(collection, slug);
  const offer = offeredIn(data, Object.keys(loaded));
  const languages = localeData(loaded);
  const translations = Object.fromEntries(
    Object.entries(languages).filter(([locale]) => locale !== source),
  );
  return Response.json({
    ...form,
    data,
    // From the same read, so a second column is not a request of its own.
    translations,
    revisions: Object.fromEntries(
      Object.entries(loaded).map(([locale, file]) => [locale, file.revision]),
    ),
    // A translation drafted on its own is the entry's to publish too.
    pending: config.i18n.locales.filter((locale) => loaded[locale]?.pending),
    // The hold is written per file but holds the whole entry back.
    held: Object.values(loaded).some((l) => l.held),
    problems: entryProblems(schema, data),
    // Only an entry with an SEO panel pays the globals read.
    ...(form.fields.some((f) => f.type === 'seo')
      ? { seoDefaults: await siteSeoDefaults(ctx) }
      : {}),
    // `_status` is the entry's, not one language's.
    hidden,
    ...(hidden ? { redirects: await hideTargets(ctx, collection, slug, loaded) } : {}),
    titleField: collected?.titleField,
    // A global has nothing to hide, rename or duplicate; it is drawn under the dev's label.
    ...(global
      ? {
          singleton: true,
          label: globalLabel(slug, global).label,
          labels: globalLabel(slug, global).labels,
        }
      : {}),
    // Decides whether the editor draws the multi-language controls at all.
    locales: config.i18n.locales,
    // The site's, which is what says whether a language's URLs carry its segment.
    defaultLocale: config.i18n.defaultLocale,
    // The entry's own, which is the site default only where that file exists.
    sourceLocale: source,
    // A language not offered is turned off, not missing.
    offered: offer.offered,
    // Reported rather than acted on, so the list and the form read the same thing.
    offerProblems: offer.problems,
    drift: driftReport('default', form, languages),
    // A warning next to the language, never a reason to refuse anything.
    stale: await staleLocales('default', form, languages, source),
    // With nothing configured the Translate buttons are not drawn.
    translator: (await translator(ctx)) !== undefined,
    // The languages the repository has a file for; the rest only the preview can show.
    published: config.i18n.locales.filter((locale) => loaded[locale]?.live),
    // What the editor builds the address row from.
    route: collected?.route,
    index: collected?.index,
    prefixDefaultLocale: config.i18n.prefixDefaultLocale ?? false,
    // Empty where a language serves it under the file name; absent draws no address row.
    ...(collected?.localizedSlugs
      ? {
          localizedSlugs: true,
          addresses: Object.fromEntries(
            Object.entries(languages).map(([locale, file]) => [
              locale,
              (file as { slug?: unknown })?.slug ?? '',
            ]),
          ),
        }
      : {}),
  });
}

/** One lock per entry: `read` never takes it, `beat` extends ours, `take` moves it. */
export async function lockState(
  ctx: RequestContext,
  collection: string,
  slug: string,
  session: App.Locals['handover'],
  mode: 'read' | 'beat' | 'take',
  tab: string,
): Promise<Response> {
  if (!session) return new Response('Unauthorized', { status: 401 });
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const database = ctx.db();
  const entry = `${collection}/${slug}`;
  if (mode === 'take')
    return Response.json(await takeOver(ctx, collection, slug, entry, session, tab));
  const taken =
    mode === 'beat' ? await claimLock('default', database, entry, session.user.id, tab) : undefined;
  const holder = taken ? undefined : await lockHolder('default', database, entry);
  return Response.json({
    held_by: holder ? { id: holder.userId, name: holder.name } : null,
    // The lock belongs to the tab, so a second tab of the same person sees `mine` false.
    mine: taken !== undefined || isHolder(holder, session, tab),
    expires_at: taken ?? holder?.expiresAt ?? null,
  });
}

/** Logged only when it moves between people; an unheld entry is not a take-over. */
async function takeOver(
  ctx: RequestContext,
  collection: string,
  slug: string,
  entry: string,
  session: NonNullable<App.Locals['handover']>,
  tab: string,
) {
  const database = ctx.db();
  const holder = await lockHolder('default', database, entry);
  const expiresAt = await takeLock('default', database, entry, session.user.id, tab);
  if (holder && holder.userId !== session.user.id) {
    await logActivity('default', database, {
      userId: session.user.id,
      kind: 'lock-takeover',
      subject: await entrySubject(ctx, collection, slug),
      detail: { from: holder.name },
    });
  }
  return {
    held_by: null,
    mine: true,
    expires_at: expiresAt,
  };
}

// For the routes that write without reading the entry; a one-language site still reads nothing.
async function unresolvedSource(ctx: RequestContext, collection: string, slug: string) {
  if (config.i18n.locales.length < 2) return undefined;
  const { loaded, source } = await entrySourceFor(ctx, collection, slug);
  return source && 'problem' in source ? sourceRefusal(source, localeData(loaded)) : undefined;
}

/** Every possible language in one statement; a language with no draft has no row to hit. */
export async function hold(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!session) return new Response('Unauthorized', { status: 401 });
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const refused = await unresolvedSource(ctx, collection, slug);
  if (refused) return refused;
  const body = (await request.json().catch(() => undefined)) as { hold?: unknown } | undefined;
  const held = body?.hold === true;
  const database = ctx.db();
  await holdEntry(
    'default',
    database,
    config.i18n.locales.map((locale) => entryPath(collection, slug, locale)),
    held ? session.user.id : null,
  );
  // Only the release is logged: that is the half the other person wants to read about.
  if (!held) {
    await logActivity('default', database, {
      userId: session.user.id,
      kind: 'hold-released',
      subject: await entrySubject(ctx, collection, slug),
      detail: null,
    });
  }
  return Response.json({ held });
}

// A browser posting `_status` must not set it: the `_` keys are read off the file as it stands.
function editable(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')));
}

type StructuralSave = {
  containers: string[];
  revisions: Record<string, string>;
  seeds: Record<string, LocaleSeed[]>;
};

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const rowField = (type: string) => type === 'blocks' || type === 'array' || type === 'menus';

// Structural history may restore locale-owned rows, but never arbitrary entry metadata.
function structuralSave(
  value: unknown,
  form: Form,
  data: Record<string, unknown>,
  source: string,
): StructuralSave | undefined {
  if (!object(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.every((key) => ['containers', 'revisions', 'seeds'].includes(key)))
    return undefined;
  const containers = value.containers;
  if (
    !Array.isArray(containers) ||
    !containers.length ||
    containers.some((address) => typeof address !== 'string' || !address) ||
    new Set(containers).size !== containers.length
  )
    return undefined;
  for (const address of containers) {
    const resolved = resolveFieldTarget('default', form, address, data);
    if (
      !resolved.ok ||
      resolved.target.address !== address ||
      !rowField(resolved.target.field.type)
    )
      return undefined;
  }

  if (!object(value.revisions)) return undefined;
  const revisionEntries = Object.entries(value.revisions);
  if (
    !revisionEntries.length ||
    !revisionEntries.some(([locale]) => locale === source) ||
    revisionEntries.some(
      ([locale, revision]) =>
        !config.i18n.locales.includes(locale) || typeof revision !== 'string' || !revision,
    )
  )
    return undefined;
  const revisions = Object.fromEntries(revisionEntries) as Record<string, string>;

  if (!object(value.seeds)) return undefined;
  const seeds: Record<string, LocaleSeed[]> = {};
  for (const [locale, candidates] of Object.entries(value.seeds)) {
    if (
      locale === source ||
      !config.i18n.locales.includes(locale) ||
      !(locale in value.revisions) ||
      !Array.isArray(candidates)
    )
      return undefined;
    const seen = new Set<string>();
    seeds[locale] = [];
    for (const candidate of candidates) {
      if (!object(candidate)) return undefined;
      const seedKeys = Object.keys(candidate);
      if (
        !seedKeys.every((key) => ['address', 'value', 'machine'].includes(key)) ||
        !seedKeys.includes('address') ||
        !seedKeys.includes('value') ||
        typeof candidate.address !== 'string' ||
        !candidate.address ||
        !object(candidate.value) ||
        typeof candidate.value._id !== 'string' ||
        !candidate.value._id ||
        '_machine' in candidate.value ||
        seen.has(candidate.address)
      )
        return undefined;
      const suffix = `[_id=${candidate.value._id}]`;
      const container = candidate.address.endsWith(suffix)
        ? candidate.address.slice(0, -suffix.length)
        : undefined;
      const resolved = resolveFieldTarget('default', form, candidate.address, data);
      if (
        !container ||
        !containers.includes(container) ||
        !resolved.ok ||
        resolved.target.address !== candidate.address ||
        !rowField(resolved.target.field.type)
      )
        return undefined;
      if (
        candidate.machine !== undefined &&
        (!Array.isArray(candidate.machine) ||
          new Set(candidate.machine).size !== candidate.machine.length ||
          candidate.machine.some(
            (path) => typeof path !== 'string' || !path.startsWith(`${candidate.address}.`),
          ))
      )
        return undefined;
      seen.add(candidate.address);
      seeds[locale].push({
        address: candidate.address,
        value: candidate.value,
        ...(candidate.machine === undefined ? {} : { machine: candidate.machine as string[] }),
      });
    }
  }
  return { containers: containers as string[], revisions, seeds };
}

/** Drafts keep what was typed whether the schema accepts it or not; publish decides. */
export async function autosave(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
  locale?: string,
): Promise<Response> {
  const schema = schemaOf(collection, slug);
  if (!schema || (locale !== undefined && !config.i18n.locales.includes(locale)))
    return new Response('Not found', { status: 404 });
  // The lock is enforced here: a tab that lost a take-over keeps typing and finds out on save.
  const holder = await lockHolder('default', ctx.db(), `${collection}/${slug}`);
  const body = (await readJson(request)) as
    | { data?: unknown; tab?: unknown; revision?: unknown; structure?: unknown }
    | undefined;
  if (holder && !isHolder(holder, session, tabOf(body)))
    return Response.json(
      {
        held_by: { id: holder.userId, name: holder.name },
        mine: false,
        expires_at: holder.expiresAt,
      },
      { status: 409 },
    );
  const data = editable(body?.data);
  if (!data) return new Response('Bad request', { status: 400 });
  if (typeof body?.revision !== 'string' || !body.revision)
    return Response.json(
      { error: 'Reopen this entry before saving.', reason: 'revision' },
      { status: 409 },
    );

  // The server works out the source language; a stale tab may believe an outranked one.
  const many = config.i18n.locales.length > 1;
  const read = many ? await entrySourceFor(ctx, collection, slug) : undefined;
  const answer = read ? read.source : { locale: config.i18n.defaultLocale, recorded: false };
  if (!answer) return new Response('Not found', { status: 404 });
  if ('problem' in answer) return sourceRefusal(answer, localeData(read?.loaded ?? {}));
  const source = answer.locale;
  const at = locale ?? source;
  // Only a source-language save carries structure into the sibling files.
  const translation = at !== source;
  const managed = config.collections[collection]?.localizedSlugs ? ['slug'] : [];
  const provenance = translation
    ? await translationSource(ctx, collection, slug, source)
    : undefined;
  if (translation && !provenance) return new Response('Not found', { status: 404 });
  if (translation && body?.structure !== undefined)
    return new Response('Bad request', { status: 400 });
  const structure =
    body?.structure === undefined
      ? undefined
      : structuralSave(body.structure, formFor(collection, slug), data, source);
  if (body?.structure !== undefined && !structure)
    return new Response('Bad request', { status: 400 });
  if (!translation && read) {
    // Read at dispatch: a tab may have opened before external drift appeared.
    // Intentional locale-only rows and entries with one file produce no report and keep saving.
    if (driftReport('default', formFor(collection, slug), localeData(read.loaded)).length)
      return Response.json(
        {
          error:
            "This entry's languages disagree about which blocks it has. Reconcile them before editing.",
          reason: 'drift',
        },
        { status: 409 },
      );
  }
  const siblings = translation ? {} : siblingPaths(collection, slug, source);
  let saved: Awaited<ReturnType<typeof saveDraft>>;
  try {
    saved = await saveDraft(
      'default',
      ctx.db(),
      ctx.git(),
      entryPath(collection, slug, at),
      data,
      translation || managed.length || Object.keys(siblings).length || structure
        ? {
            form: formFor(collection, slug),
            locale: at,
            siblings,
            translation,
            ...(managed.length ? { managed } : {}),
            ...(provenance ? { source: provenance } : {}),
            // An unrecorded entry stays unrecorded until a translation or turn-off freezes it.
            ...(answer.recorded ? { stamp: source } : {}),
            ...(structure
              ? { restoration: { revisions: structure.revisions, seeds: structure.seeds } }
              : {}),
          }
        : undefined,
      session?.user.id,
      body.revision,
    );
  } catch (err) {
    if (err instanceof DraftRevisionError || isDraftRace(err))
      return Response.json(
        { error: new DraftRevisionError().message, reason: 'revision' },
        { status: 409 },
      );
    if (isMediaRace(err))
      return Response.json(
        {
          error: 'That media item is being deleted. Choose another file before saving.',
          reason: 'media',
        },
        { status: 409 },
      );
    // A shape the serialiser cannot write (a nested array) is refused with its reason.
    return new Response(err instanceof Error ? err.message : 'Bad request', { status: 400 });
  }
  if (!saved) return new Response('Not found', { status: 404 });
  return Response.json({ ...saved, problems: entryProblems(schema, data) });
}

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
  const body = (await request.json().catch(() => undefined)) as
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
  const body = (await request.json().catch(() => undefined)) as { address?: unknown } | undefined;
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
function redirectTarget(
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
  const body = (await request.json().catch(() => undefined)) as
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
  const body = (await request.json().catch(() => undefined)) as { choices?: unknown } | undefined;
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
  const body = (await request.json().catch(() => undefined)) as
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
  const body = (await request.json().catch(() => undefined)) as { to?: unknown } | undefined;
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
  const body = (await request.json().catch(() => undefined)) as
    | { to?: unknown; drafts?: unknown }
    | undefined;
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
  const body = (await request?.json().catch(() => undefined)) as
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

/** A query against the log: a deleted entry is in neither the index nor the draft rows. */
export async function deletedList(ctx: RequestContext, collection: string): Promise<Response> {
  if (!config.collections[collection]) return new Response('Not found', { status: 404 });
  const database = ctx.db();
  const events = await deletedEntries('default', database, collection);
  const rows = await overlayRows('default', database, index);
  const here = new Set(
    collectionEntries('default', index, collection, rows).flatMap((e) =>
      Object.values(e.locales).map((l) => l.path),
    ),
  );
  return Response.json({
    deleted: events.flatMap((event) => {
      const slug = entryKey(event.subject ?? '')?.split('/')[1];
      if (!slug) return [];
      const detail = event.detail as { locales?: unknown } | null;
      const locales = Array.isArray(detail?.locales) ? detail.locales.map(String) : [];
      const taken = locales
        .map((locale) => entryPath(collection, slug, locale))
        .filter((path) => here.has(path));
      return [
        {
          id: event.id,
          at: event.at,
          by: event.user?.name || event.user?.email || null,
          slug,
          locales,
          // The whole entry, or one language of one.
          whole: event.kind === 'entry-delete',
          commit_sha: event.commitSha,
          blocked: taken.length
            ? `There is a file at ${taken.join(', ')} again, so this cannot be put back over it.`
            : undefined,
        },
      ];
    }),
  });
}
