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

/**
 * Where each language sends its readers while the entry is hidden. The rule is the same one
 * whether it is still waiting on the draft row or already committed, so both are looked at and
 * matched to the language by the URL it was written from. Empty where the client answered
 * "nowhere", which is an answer and not a gap.
 */
async function hideTargets(
  ctx: RequestContext,
  collection: string,
  slug: string,
  loaded: Awaited<ReturnType<typeof entryLocales>>,
): Promise<Record<string, string>> {
  // The branch tip, which is the ref `entryLocales` read each language's file at: the two
  // sides of the match below are the same commit, and a display that read two would miss.
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

// The draft is what the editor was last looking at, so it wins over the file. No sha goes
// to the browser: a publish commits the stored bytes and compares the bases server-side.
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
  // Every language in one pass, which is the read the drift, the staleness and the unpublished
  // drafts are all answered from. A site that declares one language reads the one file it
  // always read: it has nothing to have drifted from or been translated ahead of.
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
    // The same read as the rest, so editing a second language beside the first is this one
    // response and not a request per column.
    translations,
    revisions: Object.fromEntries(
      Object.entries(loaded).map(([locale, file]) => [locale, file.revision]),
    ),
    // Which languages the editor has ahead of the repository: a translation drafted on its own
    // — by Create from English, or waiting since last time — is the entry's to publish too.
    pending: config.i18n.locales.filter((locale) => loaded[locale]?.pending),
    // "Not ready yet", read off the entry rather than off one file: the flag is written to the
    // languages the editor was on, and it holds the whole entry back either way.
    held: Object.values(loaded).some((l) => l.held),
    problems: entryProblems(schema, data),
    // The site's defaults behind the SEO panel, only for an entry that has one to draw: every
    // other entry would be paying a read of the globals for a panel it never opens.
    ...(form.fields.some((f) => f.type === 'seo')
      ? { seoDefaults: await siteSeoDefaults(ctx) }
      : {}),
    // Off the site, and where its readers go while it is. `_status` is the entry's, so the
    // language on screen does not come into it.
    hidden,
    ...(hidden ? { redirects: await hideTargets(ctx, collection, slug, loaded) } : {}),
    titleField: collected?.titleField,
    // A global is the same screen with the collection half taken out: nothing to hide it from,
    // no name to change, no second copy of it. The name it is drawn under is the dev's label.
    ...(global ? { singleton: true, label: globalLabel(slug, global).label } : {}),
    // The languages the site declares, which is what says whether the editor draws any of the
    // controls that are about having more than one, and which of them this response is of.
    locales: config.i18n.locales,
    // The site's, which is what says whether a language's URLs carry its segment.
    defaultLocale: config.i18n.defaultLocale,
    // And the entry's own: the language its structure is edited in and its translations are
    // made from, which is the default language only where it has that file.
    sourceLocale: source,
    // And which of them this entry is offered in: the rest are not translated but turned off,
    // which is a decision and not a gap to fill.
    offered: offer.offered,
    // What its own `_locales` says that the files contradict. Reported rather than acted on:
    // the list and the form would otherwise each believe a different half of it.
    offerProblems: offer.problems,
    drift: driftReport('default', form, languages),
    // Which of them were translated from an English that has moved on since. A warning the
    // editor draws next to the language, never a reason to refuse anything.
    stale: await staleLocales('default', form, languages),
    // Whether anything can machine-translate: with nothing configured the buttons that offer
    // it are not drawn, the same rule the locale controls follow on a one-language site.
    translator: (await translator(ctx)) !== undefined,
    // Which of its languages are published — the repository has a file for them. The rest are
    // pages the preview can show and the live site has never had, which is what the pane says
    // over a brand-new entry.
    published: config.i18n.locales.filter((locale) => loaded[locale]?.live),
    // Where the site serves this entry and what stands above it: what the editor builds the
    // address row from, and what it names when a language that has a file is turned off.
    route: collected?.route,
    index: collected?.index,
    prefixDefaultLocale: config.i18n.prefixDefaultLocale ?? false,
    // The address each language serves this entry at, empty where it serves it under the file
    // name. Absent on a collection without localized slugs, which draws no address row at all.
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

/**
 * Who is editing this entry, and what each of its files was loaded against. One entry, every
 * language: the structure is shared, so a lock on one file would be a lock on none.
 *
 * `beat` takes an entry nobody is editing and pushes our own lock further out; `read` only ever
 * reads, so a tab watching one is not a way to take it. `take` is the one that moves an entry
 * between people, and it is a person pressing Take over — the holder hears about it when the
 * save their tab makes next is refused.
 */
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
    // The lock is the tab's: the same person's other tab reads `held_by` as themselves and
    // `mine` false, which is how the editor knows to say "in another tab".
    mine: taken !== undefined || isHolder(holder, session, tab),
    expires_at: taken ?? holder?.expiresAt ?? null,
  });
}

/**
 * Take over: the lock moves whatever it says, and the log carries who it was taken from, since
 * that is the half the event would otherwise lose. Nobody holding it is not a take-over and is
 * not an event — the beat would have taken it anyway.
 */
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

/**
 * "Not ready yet" on the entry, or off it. Every language it could have, whether it has that
 * file or not: the write is one statement and a language nobody has drafted has no row to hit.
 */
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
  // Only the way off is an event: a hold is a promise to somebody else, and taking it off is
  // the half they would want to read about afterwards.
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

// The `_` keys belong to the file, not to the form: `mergeEntry` reads them off the entry as
// it stands, so a browser posting `_status` must not be able to set it.
function editable(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')));
}

/**
 * Autosave of the default language, and of the structure every language shares: a block
 * added, moved or removed goes into the other languages' files in the same write, values
 * they own untouched.
 *
 * A draft holds what the editor typed, whether the schema accepts it yet or not: a new entry
 * in a collection with a required `reference` has no way to satisfy it from a form whose
 * widget is read-only, and refusing the write would throw the typed text away. What is missing
 * comes back named instead, and the publish is where the schema decides.
 *
 * The browser sends the revision GET supplied. The base itself stays server-side, seeded
 * from the immutable file shown when the editor opened.
 */
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
  // The one write the lock enforces rather than draws, because it is the one that runs on its
  // own: after a take-over the tab that lost the entry keeps typing, and this is where it finds
  // out. The answer is the lock, so the screen can name who has it.
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

  // Which file this is a save of: the second column names its language, and the form on screen
  // is the entry's own — which is not the site's default on an entry nobody wrote one in. The
  // server works it out rather than believing the tab, which may have been open since before
  // somebody else gave the entry a file in a language that outranks the one it is showing.
  const source = await sourceFor(ctx, collection, slug);
  if (!source) return new Response('Not found', { status: 404 });
  const at = locale ?? source;
  // A translation writes its own words into its own file and moves nothing; the language the
  // entry is written in is the one that carries the structure into the others. A site that
  // declares one language does neither, so its save is exactly the write it always was.
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
    // A shape the serialiser cannot write back — a nested array above all — leaves nothing to
    // store, so this one is still a refusal, with the reason rather than "Bad request".
    return new Response(err instanceof Error ? err.message : 'Bad request', { status: 400 });
  }
  if (!saved) return new Response('Not found', { status: 404 });
  return Response.json({ ...saved, problems: entryProblems(schema, data) });
}

/**
 * Create from English: the missing language's file made from the one the entry is written in —
 * its structure and the values every language shares, none of its words. A draft like any
 * other, so nothing is in the repository until somebody publishes it.
 */
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
  // Including the language the entry is written in, which is the only guard that language now
  // needs: a missing default language is exactly what this route is for.
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

/**
 * A machine's first draft of one language, from the language the entry is written in. `paths`
 * names the fields to translate — one Translate button — and without it every field this
 * language has nothing in yet is filled, which is what pre-fill is.
 *
 * The answers land in `_machine`, so the badge stands until somebody types over the field: a
 * machine filling something and a person meaning it are different states of the same value.
 */
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
  // Before the entry is read at all: having nothing to translate with is about the site, so it
  // is the answer whatever else would have refused this one.
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
  // What this language has words in already: a pre-fill is for the gaps, and a Translate button
  // names the field it is on whether there is anything there or not.
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
  // The column redraws from this rather than reloading the entry, so an edit in the other one
  // is not thrown away by a pre-fill.
  const after = await entryLocales(ctx, collection, slug, [locale]);
  return Response.json(after[locale] ?? {});
}

/**
 * The languages this entry is offered in. The mark goes into the files the entry does have, so
 * the entry list and the site read the decision out of the repository rather than out of D1.
 *
 * Turning off a language that has a file is a delete of that one file, and a delete commits:
 * the file goes, the mark goes into the files that stay, and the URL that language served sends
 * its readers where `redirect` says — the hide's four answers, the collection's index without
 * one — all in one commit. Turning off the last language an entry has a file in is refused —
 * that is a delete of the entry, and Delete is where the question is asked for all of it at once.
 */
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
  // What the entry is left with. A language whose file is only a draft cannot stand in for a
  // published one: discarding it afterwards would leave the entry with nothing, and this commit
  // has already taken the published file away.
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
    // The same question a hide asks, resolved the same way: a picked page is the address that
    // language serves it at, and a language it has no half in falls back the way the dialog says.
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
      // A language that had a draft as well as a file loses both: the row would otherwise
      // publish the file the commit just removed.
      if (file) await recordDelete('default', database, path, commit_sha);
      else await discardDraft('default', database, path);
    }
    const offer = { offered, locales: config.i18n.locales, gone: going };
    for (const file of kept)
      await recordOffer('default', database, file.path, file.contents, offer, commit_sha);
    // A language that stays and has no file of its own yet — one Create from English drafted and
    // never published — is not in the commit, so its draft is where the mark goes.
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
    // The languages that went, so the Deleted view can say what it would put back without
    // asking git what the commit touched.
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'locale-off',
      subject: await entrySubject(ctx, collection, slug),
      detail: { locales: going },
      commitSha: commit_sha,
    });
    return Response.json({ commit_sha });
  }
  // Nothing that goes is in the repository, so there is nothing to commit and no URL anybody
  // could have followed: what Create from English left behind is thrown away, and the mark is
  // drafted the way it is for a language that never had a file.
  for (const { locale, path } of files)
    if (going.includes(locale)) await discardDraft('default', database, path);
  await setEntryLocales('default', database, git, pathsOf(staying), offered, config.i18n.locales);
  return Response.json({});
}

/**
 * Every address the collection could serve in this language, the entry's own left out. Each
 * other entry holds two: the address it has there, and its file name — which is what it falls
 * back to the moment somebody clears that address, so a name is never free to be taken.
 * Drafts count, exactly as they do for a file name.
 */
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

/**
 * The address one language serves this entry at: the `slug` key in that language's file, empty
 * putting it back under the file name. The file name does not move — it is the entry's id
 * across the languages, and renaming is the other action, with the other consequence.
 *
 * A published address that moves owes a redirect from where it was. It is stored against the
 * draft rather than committed now: the old URL is the live one until this is published.
 */
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
  // Only a published address can have been followed, and only the collection's own route
  // gives it a URL to be followed at.
  const was = file ? entryAddress('default', parseEntry('default', file.contents), slug) : after;
  const from = entryUrl('default', config.i18n, collected.route, was, locale);
  const to = entryUrl('default', config.i18n, collected.route, after, locale);
  await setEntryAddress(
    'default',
    ctx.db(),
    git,
    // The whole form, `slug` included: `formFor` takes the address out of what the client
    // types into, but it is a key the schema declares and the file writes it where it says.
    formOf('default', formSchema(collected.schema)),
    path,
    wanted,
    from && to && from !== to ? { from, to, entry: `${collection}/${slug}` } : undefined,
    session?.user.id,
  );
  return Response.json({});
}

/**
 * Where visitors to a page that is coming off the site are sent, in one language. The client
 * picked one answer for the whole entry and the server turns it into that language's own URL:
 * a German reader sent to an English page cannot read it. A picked entry with no page in a
 * language falls back to that collection's index and then to the language's front page, which
 * is what the dialog says it will do.
 *
 * A typed web address is one answer for every language — it is an address, not a page.
 */
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

/**
 * On the site or off it, for one entry or for a batch of them. `_status` is the entry's rather
 * than one language's, so every file it has is written — and the redirects a hide owes are one
 * per language, from the URL that language **served**, which is the address the repository has
 * and not an unpublished one nobody could have followed.
 *
 * Nothing is committed here: the rules wait on the rows with the `_status` that made them owed,
 * and the publish that takes the entry off the site carries both.
 */
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
  // The whole form, `slug` included: the address is not a field anybody types into, but it is a
  // key the schema declares and rewriting the file has to leave it where the schema puts it.
  const form = formOf('default', formSchema(collected.schema));
  for (const slug of slugs) {
    const files = await entryFiles(git, collection, slug);
    await setEntryStatus(
      'default',
      database,
      git,
      form,
      files.map(({ locale, path, file }) => {
        // A language with no file in the repository has no URL anybody has followed, so it owes
        // nothing — a new entry hidden before its first publish writes no rule at all.
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

/**
 * The answers to one entry's structural drift, one per block its languages disagree about.
 * They belong here and not in an autosave: that one carries the default language's values and
 * has no way to say a block comes out of German. Nothing is marked resolved — the entry is read
 * again afterwards, and the banner goes because the next report is empty.
 */
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

// The titles come from the build, the pending edits from D1. Nothing here touches GitHub:
// listing a collection through the contents API is one request per file.
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
  // What "duplicate including unpublished changes?" is asked over: without it the dialog would
  // offer a choice about an entry that has nothing unpublished to choose.
  const unpublished = new Set(waiting.map((row) => row.path));
  const edits = lastEdits(waiting, published, editors);
  // The same reading of `_locales` the editor does, so a language with a file is never struck
  // through in the list and typed in on the next screen.
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
        // The dashboard's line, and it goes as far back as the log does: a row nobody has
        // touched in six months has nothing here rather than a guess.
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

/**
 * Everything an editor can point at: one row per entry in every collection the site declares,
 * with the address each of its languages serves it at. One answer feeds the page picker
 * wherever it appears — a `reference`, a `link`, a rich text link — because they all choose
 * from the same set and only differ in what they store afterwards.
 */
export async function pickList(ctx: RequestContext): Promise<Response> {
  return Response.json({
    entries: await pickable(ctx),
    // A collection's index page is not an entry, and a menu can point at one all the same: the
    // collection, and where each language serves its index.
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
    // Which language a typed path is in is read off its own segment, and the default one has
    // none: a picker asked for an address needs both halves of that to name a language.
    defaultLocale: config.i18n.defaultLocale,
  });
}

/**
 * The site settings screen: one card per global the site declares, in `cms.config.ts` order.
 * It costs what the entry list costs and nothing more — the built index with the draft rows
 * over it — because a global is an entry of the `globals` collection.
 */
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
        // Which languages have a file at all: the rest are the dashed chip that offers to make
        // one, the same answer the editor's own second column gives.
        locales: config.i18n.locales.filter((locale) => found?.locales[locale]),
        pending: locales.some(([, file]) => pending.has(file.path)),
        editing: editing[`globals/${key}`],
        // The same line the dashboard's rows carry, and it goes as far back as the log does:
        // one nobody has touched in six months has nothing here rather than a guess.
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
  /** An edit nobody has published yet, or the publish that carried one out. Different verbs. */
  kind: 'edit' | 'publish';
}

/**
 * When each entry was last touched. The draft row where there is one, and the publish that
 * carried it out where there is not — a draft is deleted once the build carrying it is live, so
 * on a site where everything is published the log is the only record left that anybody edited
 * anything.
 *
 * The draft wins: an entry with unpublished changes is described by the edit, not by whatever
 * publish it was last in.
 */
function lastEdits(
  drafts: readonly { path: string; updatedAt: number }[],
  published: readonly EntryEdit[],
  editors: Record<string, string | null>,
): Map<string, LastEdit> {
  const rows = new Map<string, LastEdit>();
  // Already newest first, which is what makes the first row an entry has the one it keeps.
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

/**
 * The landing page's own reading of what already exists. Two of its tiles are not here: the
 * unpublished count and the build pill are the shell's own indicators grown up, and the shell
 * has already loaded both — asking again would be a second answer for the drawer to disagree
 * with.
 *
 * What is here is the half nothing else knows: who last touched each entry, and how far behind
 * the translations are. Neither costs a file fetch — the drafts are rows, the publishes are the
 * log, and the staleness is the map the build wrote.
 */
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
    // Only where the newest commit is a publish: a rename or a redirect is a commit too, and
    // "published by" over one of those names the wrong thing entirely.
    published: last?.kind === 'publish' ? { at: last.at, by: last.by } : null,
    translations: translationHealth(overlay),
  });
}

/**
 * Per language: entries offered in it with no file yet, and translations made from a source that
 * has moved on since. **Missing is exact** — it is the index with today's drafts over it, the
 * same reading the entry list's chips make. **Stale is the last build's** — judging it needs
 * every language of the entry, and laying the drafts over that would be a file fetch per entry.
 *
 * Nothing at all on a one-language site: every site has a locale folder, and a site with one
 * has nothing to report about it.
 */
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

/**
 * What each of these entries is called. The entry list's own reading, so one entry is named the
 * same thing on every screen: the first language that has a title, whichever that turns out to
 * be. A global has no title field to be named by and is named the way Site settings names it.
 */
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

/**
 * The drawer's list: one row per **entry**, never per file. Grouped and named here rather than
 * in the browser because a title comes from the build's content index, which only the Worker
 * can read — handing over paths would mean sending a title with each of them anyway.
 */
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
    // What the entry owes for an address it moved. redirects.yaml is assembled at publish out
    // of the rules of the entries going out, so it is never a row of its own to list.
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

// What a starter hands the new entry, and what it does not: the identity keys are the entry's
// own, and a template that carried them would put every entry made from it at one address. One
// the build has not seen is read from the repository, which is where a save put it.
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

// Every `_id` taken out, the way a hand-written starter arrives: creating from it stamps fresh ones.
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

/**
 * A template is the entry's own file in the language it was written in, less what belongs to
 * the entry alone, committed at once so the next build offers it and logged so the dialog
 * offers it before then. The owner's to make: a template shapes every entry made after it.
 */
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

/**
 * A new entry is a draft, not a commit: nothing is in the repository until it is published,
 * which is what lets the file name stay editable and keeps an abandoned entry out of git.
 * It starts empty apart from its title — a field the schema requires is left absent rather
 * than guessed at, and the editor is shown what is still missing until the publish — or from
 * one of the collection's starters, whose blocks are given ids on the way through.
 */
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
  // The site's default language, and the one place it is still an entry's: a brand-new entry has
  // no file to be written in any other, so it starts in the language the site is written in.
  const path = entryPath(collection, slug, config.i18n.defaultLocale);
  await createDraft('default', database, ctx.git(), path, values);
  return Response.json({ slug });
}

// The new name goes through the same derivation as a new entry's, so a rename can never
// produce a file name the CMS could not have created.
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
    // Whoever has the entry open still has it: what they are editing is the same entry under
    // the name it now answers to.
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

/**
 * A copy of the entry under a new name, as drafts: nothing is in the repository until somebody
 * publishes it, so the copy can be abandoned the way a new entry can. It comes out hidden —
 * a half-edited copy going live because somebody published something else is the accident this
 * feature would otherwise introduce — and without the staleness marks, which were made against
 * the original's translations and say nothing about the copy's.
 *
 * `drafts` is the answer to "duplicate including unpublished changes?": with it the languages
 * that have unpublished bytes are copied from those instead of from the commit.
 */
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
  // The same refusal a rename gives, for the same reason: what is copied is what the
  // repository has, and an entry that was never published has nothing there to copy.
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
    // The first language the copy has, which is the file the log would open — read off the
    // copies rather than asked for, since nothing of the copy is in the repository yet.
    subject: copies[0]?.path ?? null,
    detail: { from: slug },
  });
  return Response.json({ slug: to });
}

/**
 * An entry that was never published has nothing to remove from the repository and no URL anyone
 * could have followed, so it goes without a commit and without a redirect.
 *
 * `redirect` is the same answer the hide dialog gives, resolved to the URL each language sends
 * its readers to. A delete commits now rather than at the next publish, so the rules go into the
 * commit that takes the files away. No answer at all is the collection's own page above it,
 * which is what the dialog offers first.
 */
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
  // Read before the commit: once the files have gone there is no language left to name the
  // entry by, and this is the row the deleted list is built from.
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
  // A language with a draft and no file is not in the commit, so its row goes here — left, it
  // would be a draft of an entry that no longer exists.
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

// The way out of a publish conflict: the entry gives up its draft and is read from the
// repository again on the next open. Taking theirs whole — picking field by field is later.
export async function discard(
  ctx: RequestContext,
  collection: string,
  slug: string,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const database = ctx.db();
  // Read before the rows go: an entry that only ever existed as a draft has no file to name it
  // by afterwards.
  const [subject, went] = await Promise.all([
    entrySubject(ctx, collection, slug),
    pendingLocales(collection, slug, database),
  ]);
  // Every language of it: the others hold the structure this edit gave them.
  for (const locale of config.i18n.locales)
    await discardDraft('default', database, entryPath(collection, slug, locale));
  // Somebody's words went, which typing never records and this does: the same row a version
  // restored over a draft writes. Nothing pending is nothing thrown away.
  if (went.length)
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'draft-discard',
      subject,
      detail: { locales: went },
    });
  return Response.json({});
}

/**
 * The Deleted view: what the CMS took away in one collection, newest first, and whether each
 * row can come back. A query against the activity log rather than a filter over the list —
 * a deleted entry is in neither the built index nor the draft rows.
 *
 * A row whose paths are occupied again keeps its Restore, said in the answer rather than left
 * to the attempt: restoring would write over whatever is there now. It is the same set the list
 * itself draws, so the two screens never disagree about what exists.
 */
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
