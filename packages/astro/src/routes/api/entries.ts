import config from 'virtual:handover/config';
import index, { stale, templates } from 'virtual:handover/index';
import type { Db, EntryEdit, IndexEntry } from '@handover/core';
import {
  addressError,
  claimLock,
  collectionEntries,
  createDraft,
  createDrafts,
  DraftRevisionError,
  deletedEntries,
  deleteEntry,
  deleteLocales,
  discardDraft,
  draftEditors,
  driftReport,
  dropLock,
  duplicateEntry,
  entryAddress,
  entryKey,
  entryName,
  entryOffer,
  entryUrl,
  FORMAT_VERSION,
  formOf,
  heldDrafts,
  holdEntry,
  humanise,
  isDraftRace,
  isLive,
  lastCommit,
  loadDraft,
  lockHolder,
  lockHolders,
  logActivity,
  moveLock,
  overlayRows,
  parseEntry,
  pendingDrafts,
  publishedEntries,
  readRedirects,
  recordDelete,
  recordOffer,
  recordRename,
  regenerateIds,
  releasePaths,
  renameEntry,
  reservePaths,
  resolveDrift,
  saveDraft,
  savedTemplates,
  saveTranslated,
  setEntryAddress,
  setEntryLocales,
  setEntryStatus,
  staleLocales,
  stringifyEntry,
  syncLocale,
  takeLock,
  translatableText,
} from '@handover/core';
import { formSchema } from '../../index.js';
import { entryProblems } from '../../problems.js';
import {
  ENTRY_FILE,
  entryFiles,
  entryHref,
  entryLocales,
  entryPath,
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
  pickable,
  schemaOf,
  siblingPaths,
  siteSeoDefaults,
  sourceFor,
  sourceIn,
  sourceOrder,
  tabOf,
  takenNames,
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
export async function getEntry(
  ctx: RequestContext,
  collection: string,
  slug: string,
): Promise<Response> {
  const collected = config.collections[collection];
  const global = globalOf(collection, slug);
  if (!collected && !global) return new Response('Not found', { status: 404 });
  const schema = global ?? collected?.schema;
  if (!schema) return new Response('Not found', { status: 404 });
  // One read of every language answers drift, staleness and pending drafts alike.
  const loaded = await entryLocales(ctx, collection, slug, config.i18n.locales, true);
  const source = sourceIn(loaded);
  if (!source) return new Response('Not found', { status: 404 });
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
    ...(global ? { singleton: true, label: globalLabel(slug, global).label } : {}),
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
    stale: await staleLocales('default', form, languages),
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
  const body = (await request.json().catch(() => undefined)) as
    | { data?: unknown; tab?: unknown; revision?: unknown }
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
  const source = await sourceFor(ctx, collection, slug);
  if (!source) return new Response('Not found', { status: 404 });
  const at = locale ?? source;
  // Only a source-language save carries structure into the sibling files.
  const translation = at !== source;
  const siblings = translation ? {} : siblingPaths(collection, slug, source);
  let saved: Awaited<ReturnType<typeof saveDraft>>;
  try {
    saved = await saveDraft(
      'default',
      ctx.db(),
      ctx.git(),
      entryPath(collection, slug, at),
      data,
      translation || Object.keys(siblings).length
        ? { form: formFor(collection, slug), locale: at, siblings, translation }
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
    // A shape the serialiser cannot write (a nested array) is refused with its reason.
    return new Response(err instanceof Error ? err.message : 'Bad request', { status: 400 });
  }
  if (!saved) return new Response('Not found', { status: 404 });
  return Response.json({ ...saved, problems: entryProblems(schema, data) });
}

/** Structure and shared values from the source file, none of its words, as a draft. */
export async function createTranslation(
  ctx: RequestContext,
  collection: string,
  slug: string,
  locale: string,
): Promise<Response> {
  const schema = schemaOf(collection, slug);
  if (!schema || !config.i18n.locales.includes(locale))
    return new Response('Not found', { status: 404 });
  const loaded = await entryLocales(ctx, collection, slug, config.i18n.locales);
  // A missing default language is exactly what this route is for, so no extra guard on it.
  if (loaded[locale]) return new Response('That language already has a file', { status: 409 });
  const source = sourceIn(loaded);
  const data = source === undefined ? undefined : loaded[source]?.data;
  if (data === undefined) return new Response('Not found', { status: 404 });
  const { offered, problems } = offeredIn(data, Object.keys(loaded));
  // A mark the files contradict is answered before the offer it would otherwise be read as.
  if (problems.length) return new Response(problems.join('\n'), { status: 409 });
  if (!offered.includes(locale))
    return new Response(`This entry is not offered in ${locale}`, { status: 409 });
  const form = formFor(collection, slug);
  const made = syncLocale('default', form, locale, { before: data, after: data }, {});
  if (offered.length < config.i18n.locales.length) made._locales = offered;
  await createDraft('default', ctx.db(), ctx.git(), entryPath(collection, slug, locale), made);
  return Response.json({});
}

/** Answers land in `_machine`, so the badge stands until somebody types over the field. */
export async function machineTranslate(
  ctx: RequestContext,
  collection: string,
  slug: string,
  locale: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const schema = schemaOf(collection, slug);
  if (!schema || !config.i18n.locales.includes(locale))
    return new Response('Not found', { status: 404 });
  // Checked before the entry is read: having no translator is about the site, not this entry.
  const translate = await translator(ctx);
  if (!translate)
    return new Response(
      'This site has nothing to translate with: paste a DeepL key in Settings, set DEEPL_API_KEY, or hand in an i18n.translate in cms.config.ts',
      { status: 409 },
    );
  const loaded = await entryLocales(ctx, collection, slug, config.i18n.locales);
  const from = sourceIn(loaded);
  const source = from === undefined ? undefined : loaded[from];
  if (!from || !source || from === locale || !loaded[locale])
    return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { paths?: unknown } | undefined;
  const named = Array.isArray(body?.paths) ? body.paths.map(String) : undefined;
  const form = formFor(collection, slug);
  // A pre-fill is for the gaps; a Translate button names its field whether filled or not.
  const written = new Set(
    translatableText('default', form, loaded[locale].data).map((v) => v.path),
  );
  const wanted = translatableText('default', form, source.data).filter((v) =>
    named ? named.includes(v.path) : !written.has(v.path),
  );
  if (wanted.length) {
    const answers = await translate(
      wanted.map((v) => v.text),
      from,
      locale,
    );
    await saveTranslated(
      'default',
      ctx.db(),
      ctx.git(),
      entryPath(collection, slug, locale),
      Object.fromEntries(wanted.map((v, i) => [v.path, answers[i] ?? v.text])),
      session?.user.id,
      loaded[locale].revision,
    );
  }
  // The column redraws from this, so an edit in the other column survives a pre-fill.
  const after = await entryLocales(ctx, collection, slug, [locale]);
  return Response.json(after[locale] ?? {});
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
  const written = Object.keys(await entryLocales(ctx, collection, slug, config.i18n.locales));
  if (!written.length) return new Response('Not found', { status: 404 });
  const going = written.filter((locale) => !offered.includes(locale));
  const staying = written.filter((locale) => offered.includes(locale));
  const git = ctx.git();
  const database = ctx.db();
  const files = going.length ? await entryFiles(git, collection, slug) : [];
  // A draft-only language cannot stand in for a published one this commit takes away.
  const published = files.filter((f) => f.file).map((f) => f.locale);
  const left = published.length ? published.filter((l) => !going.includes(l)) : staying;
  if (going.length && !left.length)
    return new Response(
      staying.length
        ? `Turning ${going.join(', ')} off would leave this entry with no published file: publish ${staying.join(', ')} first, or Delete the entry`
        : `Turning ${going.join(', ')} off would leave this entry with no file in any language: Delete the entry instead, which asks where its readers should go`,
      { status: 409 },
    );
  const pathsOf = (locales: string[]) => locales.map((l) => entryPath(collection, slug, l));
  if (published.some((locale) => going.includes(locale))) {
    // The same question a hide asks, resolved the same way per language.
    const answer = body?.redirect ?? { kind: 'index' };
    const picked =
      answer.kind === 'entry'
        ? collectionEntries(
            'default',
            index,
            String(answer.value ?? '').split('/')[0] ?? '',
            await overlayRows('default', database, index),
          )
        : undefined;
    const { commit_sha, kept } = await deleteLocales(
      'default',
      git,
      locationOf(collection),
      slug,
      going,
      offered,
      (locale) => redirectTarget(answer, collected, picked, locale),
    );
    for (const { locale, path, file } of files) {
      if (!going.includes(locale)) continue;
      // A language with a draft and a file loses both, or the row would republish the file.
      if (file) await recordDelete('default', database, path, commit_sha);
      else await discardDraft('default', database, path);
    }
    const offer = { offered, locales: config.i18n.locales, gone: going };
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
      );
    // Logged so the Deleted view can say what it would put back without asking git.
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'locale-off',
      subject: await entrySubject(ctx, collection, slug),
      detail: { locales: going },
      commitSha: commit_sha,
    });
    return Response.json({ commit_sha });
  }
  // Nothing that goes is in the repository, so there is nothing to commit or redirect.
  for (const { locale, path } of files)
    if (going.includes(locale)) await discardDraft('default', database, path);
  await setEntryLocales('default', database, git, pathsOf(staying), offered, config.i18n.locales);
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
  if (bad) return new Response(bad, { status: 422 });
  const path = entryPath(collection, slug, locale);
  const git = ctx.git();
  const [file, row] = await Promise.all([git.getFile(path), loadDraft('default', ctx.db(), path)]);
  if (!file && !row) return new Response('Not found', { status: 404 });
  // Empty falls back to the file name, so that is the address being claimed either way.
  const after = wanted || slug;
  if ((await takenAddresses(ctx, collection, locale, slug)).includes(after))
    return new Response(
      `${JSON.stringify(after)} is already the web address of another entry in ${collection} in ${locale}`,
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

// Nothing here touches GitHub: listing through the contents API is one request per file.
export async function listEntries(ctx: RequestContext, collection: string): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const database = ctx.db();
  const [rows, waiting, editing, published, editors] = await Promise.all([
    overlayRows('default', database, index),
    pendingDrafts('default', database),
    lockHolders('default', database),
    publishedEntries('default', database),
    draftEditors('default', database),
  ]);
  // Says which rows get the "duplicate including unpublished changes?" question.
  const unpublished = new Set(waiting.map((row) => row.path));
  const edits = lastEdits(waiting, published, editors);
  // The same reading of `_locales` the editor makes, so list and form agree on chips.
  const entries = collectionEntries('default', index, collection, rows, collected.titleField).map(
    (entry) => {
      const { offered } = entryOffer(
        'default',
        config.i18n.locales,
        entry.offered,
        Object.keys(entry.locales),
      );
      // Absent when that is every language the site declares, as the built index has it.
      return {
        ...entry,
        offered: offered.length === config.i18n.locales.length ? undefined : offered,
        pending: Object.values(entry.locales).some((l) => unpublished.has(l.path)) || undefined,
        editing: editing[`${collection}/${entry.id}`],
        // Goes as far back as the log does; an untouched row has nothing rather than a guess.
        edited: edits.get(`${collection}/${entry.id}`) ?? null,
        // The last build's mark, the same one the dashboard counts, for the language filter.
        stale: stale[`${collection}/${entry.id}`]?.length
          ? stale[`${collection}/${entry.id}`]
          : undefined,
      };
    },
  );
  return Response.json({
    entries,
    // Which languages the list draws a column for, and in which order — one language, no column.
    locales: config.i18n.locales,
    // The page above them, which is where the hide dialog offers to send a row's readers.
    index: collected.index,
    // The starters this collection ships, which the New entry dialog offers beside Blank.
    templates: await templateNames(collection, database),
  });
}

/** One answer for every picker: they choose from the same set and differ only afterwards. */
export async function pickList(ctx: RequestContext): Promise<Response> {
  return Response.json({
    entries: await pickable(ctx),
    // A collection's index page is not an entry, but a menu can point at one.
    indexes: Object.entries(config.collections).flatMap(([collection, { index: page }]) => {
      if (!page) return [];
      const urls: Record<string, string> = {};
      for (const locale of config.i18n.locales) {
        const url = entryUrl('default', config.i18n, page, '', locale);
        if (url) urls[locale] = url;
      }
      return [
        {
          collection,
          index: true,
          path: collection,
          title: humanise(collection),
          locales: config.i18n.locales,
          urls,
        },
      ];
    }),
    locales: config.i18n.locales,
    // A typed path's language is read off its segment, and the default one has none.
    defaultLocale: config.i18n.defaultLocale,
  });
}

/** Costs what the entry list costs: a global is an entry of the `globals` collection. */
export async function globalsList(ctx: RequestContext): Promise<Response> {
  const database = ctx.db();
  const [rows, waiting, editing, published, editors] = await Promise.all([
    overlayRows('default', database, index),
    pendingDrafts('default', database),
    lockHolders('default', database),
    publishedEntries('default', database),
    draftEditors('default', database),
  ]);
  const pending = new Set(waiting.map((row) => row.path));
  const edits = lastEdits(waiting, published, editors);
  const entries = collectionEntries('default', index, 'globals', rows);
  return Response.json({
    globals: Object.entries(config.globals ?? {}).map(([key, schema]) => {
      const found = entries.find((entry) => entry.id === key);
      const locales = Object.entries(found?.locales ?? {});
      return {
        ...globalLabel(key, schema),
        // Languages with a file; the rest become the dashed chip that offers to make one.
        locales: config.i18n.locales.filter((locale) => found?.locales[locale]),
        pending: locales.some(([, file]) => pending.has(file.path)),
        editing: editing[`globals/${key}`],
        // Goes as far back as the log does; an untouched row has nothing rather than a guess.
        edited: edits.get(`globals/${key}`) ?? null,
      };
    }),
    locales: config.i18n.locales,
  });
}

/** When an entry was last touched, by whom, and whether that edit is out on the site yet. */
interface LastEdit {
  key: string;
  at: number;
  /** Their name, or nothing: a member who has gone leaves the date standing on its own. */
  by: string | null;
  /** An unpublished edit, or the publish that carried one out. */
  kind: 'edit' | 'publish';
}

/** The draft row wins; a draft is deleted once its build is live, so the log is the fallback. */
function lastEdits(
  drafts: readonly { path: string; updatedAt: number }[],
  published: readonly EntryEdit[],
  editors: Record<string, string | null>,
): Map<string, LastEdit> {
  const rows = new Map<string, LastEdit>();
  // Already newest first, so the first row an entry has is the one kept.
  for (const draft of drafts) {
    const key = entryKey(draft.path);
    if (!key || rows.has(key)) continue;
    rows.set(key, { key, at: draft.updatedAt, by: editors[draft.path] ?? null, kind: 'edit' });
  }
  for (const done of published)
    if (!rows.has(done.entry))
      rows.set(done.entry, { key: done.entry, at: done.at, by: done.by, kind: 'publish' });
  return rows;
}

/** The unpublished count and build pill stay the shell's, or the two would disagree. */
export async function dashboard(ctx: RequestContext): Promise<Response> {
  const database = ctx.db();
  const [drafts, published, editing, editors, overlay, last] = await Promise.all([
    pendingDrafts('default', database),
    publishedEntries('default', database),
    lockHolders('default', database),
    draftEditors('default', database),
    overlayRows('default', database, index),
    lastCommit('default', database),
  ]);
  const newest = [...lastEdits(drafts, published, editors).values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, 8);
  const titles = entryTitles(
    newest.map((row) => row.key),
    overlay,
  );
  const recent = newest.map((row) => {
    const [collection = '', slug = ''] = row.key.split('/');
    return {
      ...row,
      collection,
      title: titles.get(row.key) || slug,
      href: entryHref(row.key),
      editing: editing[row.key],
    };
  });
  return Response.json({
    recent,
    // Only when the newest commit is a publish: a rename or redirect is a commit too.
    published: last?.kind === 'publish' ? { at: last.at, by: last.by } : null,
    translations: translationHealth(overlay),
  });
}

/** Stale is the last build's: judging it with drafts would cost a fetch per entry. */
function translationHealth(overlay: readonly { path: string; contents: string }[]) {
  const locales = config.i18n.locales;
  if (locales.length < 2) return null;
  const missing: Record<string, number> = {};
  const behind: Record<string, number> = {};
  // Which lists to send somebody to: a global has none, so it counts and is not named.
  const where: Record<string, Set<string>> = {};
  const owed = (locale: string, collection: string) => {
    if (collection === 'globals') return;
    where[locale] ??= new Set();
    where[locale].add(collection);
  };
  for (const collection of [...Object.keys(config.collections), 'globals'])
    for (const entry of collectionEntries(
      'default',
      index,
      collection,
      overlay,
      config.collections[collection]?.titleField,
    )) {
      const { offered } = entryOffer('default', locales, entry.offered, Object.keys(entry.locales));
      // A language the entry is not offered in is a decision somebody made, not a gap to fill.
      for (const locale of offered)
        if (!entry.locales[locale]) {
          missing[locale] = (missing[locale] ?? 0) + 1;
          owed(locale, collection);
        }
      for (const locale of stale[`${collection}/${entry.id}`] ?? [])
        if (entry.locales[locale]) {
          behind[locale] = (behind[locale] ?? 0) + 1;
          owed(locale, collection);
        }
    }
  return {
    defaultLocale: config.i18n.defaultLocale,
    locales: locales.map((locale) => ({
      locale,
      missing: missing[locale] ?? 0,
      stale: behind[locale] ?? 0,
      where: [...(where[locale] ?? [])],
    })),
  };
}

/** The entry list's own reading, so one entry is named the same thing on every screen. */
function entryTitles(
  keys: Iterable<string>,
  overlay: readonly { path: string; contents: string }[],
) {
  const titles = new Map<string, string>();
  for (const collection of new Set([...keys].map((key) => key.split('/')[0] ?? '')))
    for (const entry of collectionEntries(
      'default',
      index,
      collection,
      overlay,
      config.collections[collection]?.titleField,
    ))
      titles.set(
        `${collection}/${entry.id}`,
        config.i18n.locales.map((l) => entry.locales[l]?.title).find(Boolean) ||
          Object.values(entry.locales)[0]?.title ||
          entry.id,
      );
  for (const [key, schema] of Object.entries(config.globals ?? {}))
    titles.set(`globals/${key}`, globalLabel(key, schema).label);
  return titles;
}

/** Grouped here because titles come from the build index only the Worker can read. */
export async function pendingList(ctx: RequestContext): Promise<Response> {
  const database = ctx.db();
  const [rows, held, overlay] = await Promise.all([
    pendingDrafts('default', database),
    heldDrafts('default', database),
    overlayRows('default', database, index),
  ]);
  const titles = entryTitles(
    rows.flatMap((r) => entryKey(r.path) ?? []),
    overlay,
  );
  type Row = {
    key: string;
    title: string;
    collection: string;
    locales: string[];
    files: string[];
    redirects?: number;
    updated_at: number;
    held_by: { id: string; name: string | null; since: number | null } | null;
  };
  const entries: Row[] = [];
  // Newest first, and the row that made an entry appear is the newest it has.
  for (const row of rows) {
    const [, collection = '', locale = '', slug = ''] = ENTRY_FILE.exec(row.path) ?? [];
    const key = entryKey(row.path) ?? row.path;
    let found = entries.find((e) => e.key === key);
    if (!found) {
      found = {
        key,
        title: titles.get(key) || slug || key,
        collection,
        locales: [],
        files: [],
        updated_at: row.updatedAt,
        held_by: held[key] ?? null,
      };
      entries.push(found);
    }
    found.files.push(row.path);
    if (locale) found.locales.push(locale);
    // redirects.yaml is assembled at publish from the entries' rules, so it is never a row here.
    const rules = row.pendingRedirects?.length ?? 0;
    if (rules) found.redirects = (found.redirects ?? 0) + rules;
  }
  for (const entry of entries)
    entry.locales = config.i18n.locales.filter((l) => entry.locales.includes(l));
  // For the drawer's check lines: a problem found in several languages opens the default one.
  return Response.json({ entries, defaultLocale: config.i18n.defaultLocale });
}

const templatePath = (collection: string, name: string) =>
  `src/content/_templates/${collection}/${name}.yaml`;

// The starters the dialog offers: the build's, and the ones saved from the admin since it ran.
async function templateNames(collection: string, database: Db): Promise<string[]> {
  const built = (templates[collection] ?? []).map((t) => t.name);
  const saved = await savedTemplates('default', database, collection);
  return [...new Set([...built, ...saved])].sort((a, b) => a.localeCompare(b));
}

// Identity keys stay out, or every entry made from the template would share one address.
async function startedFrom(
  ctx: RequestContext,
  collection: string,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  const built = templates[collection]?.find((t) => t.name === name)?.data;
  const file =
    built === undefined ? await ctx.git().getFile(templatePath(collection, name)) : undefined;
  const data = built ?? (file && parseEntry('default', file.contents));
  if (data === undefined) return undefined;
  const values = regenerateIds('default', data) as Record<string, unknown>;
  for (const key of ['_i18n', '_locales', '_status', 'slug']) delete values[key];
  return values;
}

// Every `_id` taken out: creating from the template stamps fresh ones.
const withoutIds = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutIds)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([k]) => k !== '_id')
            .map(([k, v]) => [k, withoutIds(v)]),
        )
      : value;

/** Committed now so the next build offers it, and logged so the dialog offers it before then. */
export async function saveTemplate(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!config.collections[collection]) return new Response('Not found', { status: 404 });
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const body = (await request.json().catch(() => undefined)) as { to?: unknown } | undefined;
  const git = ctx.git();
  const database = ctx.db();
  const files = await entryFiles(git, collection, slug);
  // The language it was written in, or the first it is published in: the site's default first.
  const from = sourceOrder()
    .map((locale) => files.find((f) => f.locale === locale && f.file))
    .find(Boolean);
  if (!from?.file)
    return new Response('Publish this entry before saving it as a template', { status: 409 });
  const wanted = typeof body?.to === 'string' && body.to ? body.to : slug;
  const name = entryName('default', wanted, await templateNames(collection, database));
  const values = withoutIds(parseEntry('default', from.file.contents)) as Record<string, unknown>;
  for (const key of ['_i18n', '_locales', '_status', '_machine', 'slug']) delete values[key];
  const { commit_sha } = await git.publish(
    [{ path: templatePath(collection, name), contents: stringifyEntry('default', values) }],
    {
      base_sha: await git.getHead(),
      message: `Save ${collection}/${slug} as the template ${name}`,
    },
  );
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'template-saved',
    subject: from.path,
    detail: { template: name },
    commitSha: commit_sha,
  });
  return Response.json({ name });
}

/** A draft, not a commit: the name stays editable and an abandoned entry stays out of git. */
export async function createEntry(
  ctx: RequestContext,
  collection: string,
  request: Request,
): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as
    | { title?: unknown; template?: unknown }
    | undefined;
  const title = typeof body?.title === 'string' ? body.title : '';
  const starter =
    typeof body?.template === 'string' && body.template
      ? await startedFrom(ctx, collection, body.template)
      : {};
  if (!starter) return new Response('No such template', { status: 404 });
  const database = ctx.db();
  const slug = entryName('default', title, await takenNames(collection, database));
  const { fields } = formOf('default', formSchema(collected.schema));
  // The field the collection lists by is the one the title typed into the dialog belongs in.
  const named = collected.titleField ?? 'title';
  const values: Record<string, unknown> = { ...starter, _version: FORMAT_VERSION };
  if (fields.some((f) => f.path[0] === named && f.type === 'text')) values[named] = title;
  // A brand-new entry has no other file, so it starts in the site's default language.
  const path = entryPath(collection, slug, config.i18n.defaultLocale);
  await createDraft('default', database, ctx.git(), path, values);
  return Response.json({ slug });
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
  const files = await entryFiles(git, collection, slug);
  if (!files.some((f) => f.file))
    return new Response('Publish this entry before renaming it', { status: 409 });
  const taken = (await takenNames(collection, database)).filter((id) => id !== slug);
  const to = entryName('default', typeof body?.to === 'string' ? body.to : '', taken);
  if (to === slug) return Response.json({ slug });
  const reservation = await reservePaths(
    'default',
    database,
    config.i18n.locales.map((locale) => entryPath(collection, to, locale)),
  );
  try {
    const { commit_sha } = await renameEntry('default', git, locationOf(collection), slug, to);
    for (const { locale, path, file } of files) {
      if (!file) continue;
      await recordRename(
        'default',
        database,
        path,
        entryPath(collection, to, locale),
        file.contents,
        commit_sha,
        session?.user.id,
      );
    }
    // Whoever has the entry open keeps it under its new name.
    await moveLock('default', database, `${collection}/${slug}`, `${collection}/${to}`);
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'entry-rename',
      subject: await entrySubject(ctx, collection, to),
      detail: { from: slug },
      commitSha: commit_sha,
    });
    return Response.json({ slug: to, commit_sha });
  } finally {
    await releasePaths('default', database, reservation);
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
  const files = await entryFiles(git, collection, slug);
  const entry = `${collection}/${slug}`;
  if (!files.some((f) => f.file)) {
    for (const { path } of files) await discardDraft('default', database, path);
    await dropLock('default', database, entry);
    return Response.json({});
  }
  // Read before the commit: afterwards no language is left to name the entry by.
  const subject = await entrySubject(ctx, collection, slug);
  const picked =
    answer.kind === 'entry'
      ? collectionEntries(
          'default',
          index,
          String(answer.value ?? '').split('/')[0] ?? '',
          await overlayRows('default', database, index),
        )
      : undefined;
  const result = await deleteEntry('default', git, locationOf(collection), slug, (locale) =>
    redirectTarget(answer, collected, picked, locale),
  );
  // A draft-only language is not in the commit, so its row goes here.
  for (const { path, file } of files)
    if (file) await recordDelete('default', database, path, result.commit_sha);
    else await discardDraft('default', database, path);
  await dropLock('default', database, entry);
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'entry-delete',
    subject,
    detail: { locales: files.filter((f) => f.file).map((f) => f.locale) },
    commitSha: result.commit_sha,
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
