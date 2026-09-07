import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import index from 'virtual:handover/index';
import type { Db, EntryLocation, Form, GitClient, Translate } from '@handover/core';
import {
  blobSha,
  collectionEntries,
  deeplTranslate,
  entryAddress,
  entryOffer,
  entryUrl,
  formOf,
  loadDraft,
  lockHolder,
  openDraft,
  overlayRows,
  parseEntry,
  pendingDrafts,
  type RedirectRule,
  readSetting,
} from '@handover/core';
import { entryForm, formSchema } from '../../index.js';
import type { RequestContext } from './context.js';

/**
 * The DeepL key in force: the one the client pasted into Settings, and otherwise the one the
 * developer set on the Worker. A site with neither has no row to read, so nothing here asks for
 * `HANDOVER_SETTINGS_KEY` on a site that never stored anything under it.
 */
export async function deeplKey(ctx: RequestContext): Promise<string | undefined> {
  const e = env as Record<string, string | undefined>;
  const stored = await readSetting('default', ctx.db(), e.HANDOVER_SETTINGS_KEY, 'deepl');
  return stored ?? e.DEEPL_API_KEY;
}

// What machine-translates a field: the site's own hook, or DeepL on whichever key is in force.
// Neither is an ordinary state of a site — the admin draws no translate button at all — so it
// is a question the entry answers rather than something a route discovers on the way. A stored
// key that cannot be decrypted is translation off here; the settings screen is where it is a
// sentence, because that is where somebody can act on it.
export async function translator(ctx: RequestContext): Promise<Translate | undefined> {
  if (config.i18n.translate) return config.i18n.translate;
  const key = await deeplKey(ctx).catch(() => undefined);
  return key ? deeplTranslate('default', key) : undefined;
}

// An entry as the list would show it: the title of whichever language the build read first, and
// the file name for one the index has never seen — a lock outlives the commit that removed it.
export function entryTitle(entry: string): string {
  const [collection = '', slug = ''] = entry.split('/');
  const found = index[collection]?.find((e) => e.id === slug);
  return Object.values(found?.locales ?? {})[0]?.title ?? slug;
}

// One file of one entry. No language is implied: which one an entry is written in is the
// entry's own answer, so every caller says which file it means.
export const entryPath = (collection: string, slug: string, locale: string) =>
  `src/content/${collection}/${locale}/${slug}.yaml`;

/**
 * The language an entry's structure is edited in, and the one its translations are made from:
 * the site's default where the entry has that file, and otherwise the first language it does
 * have one in. It is the entry's property and not the site's — an entry written in German alone
 * is a German entry, not a broken English one. What stays the site's is the URL, since whether a
 * language carries its segment is the same answer for every entry.
 */
export const sourceOrder = () => [...new Set([config.i18n.defaultLocale, ...config.i18n.locales])];

export const sourceIn = (loaded: Record<string, unknown>) => sourceOrder().find((l) => l in loaded);

// The same answer for a route that has not read the entry: the languages are asked in order, so
// an ordinary entry costs one read and a site with one language costs none.
export async function sourceFor(
  ctx: RequestContext,
  collection: string,
  slug: string,
): Promise<string | undefined> {
  if (config.i18n.locales.length < 2) return config.i18n.defaultLocale;
  const git = ctx.git();
  const database = ctx.db();
  for (const locale of sourceOrder()) {
    const path = entryPath(collection, slug, locale);
    const [file, row] = await Promise.all([
      git.getFile(path),
      loadDraft('default', database, path),
    ]);
    if (row || file) return locale;
  }
  return undefined;
}

// One entry's other languages, locale → path. Empty on a site that declares one language,
// which is what keeps that site's save exactly the write it was.
export const siblingPaths = (collection: string, slug: string, source: string) =>
  Object.fromEntries(
    config.i18n.locales
      .filter((locale) => locale !== source)
      .map((locale) => [locale, entryPath(collection, slug, locale)]),
  );

// Every file one entry is made of. A rename or a delete commits all of them, so all of them
// have to be recorded in D1 too, or a draft left at the old path publishes the file back.
export const entryFiles = async (git: GitClient, collection: string, slug: string) => {
  const locales = config.i18n.locales;
  const files = await Promise.all(
    locales.map((locale) => git.getFile(entryPath(collection, slug, locale))),
  );
  return locales.map((locale, i) => ({
    locale,
    path: entryPath(collection, slug, locale),
    file: files[i],
  }));
};

/**
 * A global rides the entry path: `globals` is the collection and the file name is the slug, so
 * one file per language at `src/content/globals/<locale>/<key>.yaml` — the same drafts, locks,
 * hold and one-commit publish as anything else. What it does not have is what a collection's
 * routes are about: no address, no rename, no delete, no turning a language off.
 */
export const globalOf = (
  collection: string,
  slug: string,
): Parameters<typeof formSchema>[0] | undefined =>
  collection === 'globals' ? config.globals?.[slug] : undefined;

/** The schema one file of the CMS is held to: its collection's, or the global's own. */
export const schemaOf = (
  collection: string,
  slug: string,
): Parameters<typeof formSchema>[0] | undefined =>
  globalOf(collection, slug) ?? config.collections[collection]?.schema;

/** What the site settings list calls a global, and what it says it is for. */
export const globalLabel = (key: string, schema: Parameters<typeof formSchema>[0]) => {
  const root = formSchema(schema) as { label?: unknown; description?: unknown };
  return {
    key,
    label: typeof root.label === 'string' ? root.label : key,
    description: typeof root.description === 'string' ? root.description : undefined,
  };
};

/**
 * The form the CMS works one collection through — `entryForm`'s, which is also what the build
 * reads every entry's staleness mark against. One construction on purpose: a form built
 * differently in the two places would make every translated entry read stale, since the hash is
 * taken over exactly the fields the form declares translatable.
 */
export function formFor(collection: string, slug: string): Form {
  const form = entryForm(config, collection, slug);
  if (!form) throw new Error(`No collection ${collection}`);
  return form;
}

// The languages an entry is offered in, and what its `_locales` gets wrong: `written` is the
// languages it has a file in, and a file is the fact the mark has to agree with.
export const offeredIn = (data: unknown, written: string[]) =>
  entryOffer(
    'default',
    config.i18n.locales,
    (data as { _locales?: unknown } | null)?._locales,
    written,
  );

/**
 * The site's own SEO defaults, per language, for the panel to show greyed behind what nobody
 * has typed. Found by the `defaultSeo` key rather than by a config option: the shape is the
 * package's (`seoDefaults`), and a site that spreads it into a global has said where it is.
 *
 * Read here and not on `ping`: this is content a client edits in another tab, and a stale
 * pattern behind an empty box is a client typing against a site name that has changed.
 */
export async function siteSeoDefaults(ctx: RequestContext): Promise<Record<string, unknown>> {
  const key = Object.entries(config.globals ?? {}).find(([, schema]) =>
    formOf('default', formSchema(schema)).fields.some((f) => f.path[0] === 'defaultSeo'),
  )?.[0];
  if (!key) return {};
  const loaded = await entryLocales(ctx, 'globals', key, config.i18n.locales);
  return Object.fromEntries(
    Object.entries(loaded).map(([locale, file]) => [
      locale,
      (file.data as { defaultSeo?: unknown } | null)?.defaultSeo ?? {},
    ]),
  );
}

// One entry as the editor has it, language by language: its draft where there is one, the
// repository where there is not, and no key at all for a language it has no file in. Each
// language also says whether what the editor has is ahead of the repository, which is what
// the entry's Publish is offered on. What `driftReport` compares — a structure two files
// disagree about is a hand edit or a bad merge.
export async function entryLocales(
  ctx: RequestContext,
  collection: string,
  slug: string,
  locales: string[],
  capture = false,
): Promise<
  Record<
    string,
    {
      data: unknown;
      revision?: string;
      pending: boolean;
      held: boolean;
      live: boolean;
      url?: string;
      redirects: RedirectRule[];
    }
  >
> {
  const git = ctx.git();
  const database = ctx.db();
  const head = await git.getHead();
  const loaded = await Promise.all(
    locales.map(async (locale) => {
      const path = entryPath(collection, slug, locale);
      const file = await git.getFile(path, head);
      const row = capture
        ? await openDraft('default', database, path, head, file)
        : await loadDraft('default', database, path);
      const contents = row?.contents || file?.contents;
      // A file with nothing in it is still the language's file: it opens as an empty entry
      // rather than reading as a language the entry does not have.
      if (!contents && !file) return undefined;
      const pending = row ? (await blobSha(row.contents)) !== file?.blob_sha : false;
      return [
        locale,
        {
          revision: row?.revision,
          data: contents ? parseEntry('default', contents) : {},
          pending,
          held: Boolean(row?.heldBy),
          // Whether the repository has this language's file: a draft with none behind it is a
          // page only the preview can show.
          live: Boolean(file),
          // The URL the repository serves it at, which is what a redirect written for this
          // language says `from` — an address only a draft has was never followed.
          url: file
            ? entryUrl(
                'default',
                config.i18n,
                config.collections[collection]?.route,
                entryAddress('default', parseEntry('default', file.contents), slug),
                locale,
              )
            : undefined,
          redirects: row?.pendingRedirects ?? [],
        },
      ] as const;
    }),
  );
  return Object.fromEntries(loaded.filter((l) => l !== undefined));
}

/** The words alone, for the readers that compare the languages rather than publish them. */
export const localeData = (loaded: Record<string, { data: unknown }>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(loaded).map(([locale, l]) => [locale, l.data]));

// Whether the lock is this tab's. A request with no token is its own tab, so a hand-made call
// on a held entry is refused the way a second tab is.
export const isHolder = (
  holder: { userId: string; tab: string } | undefined,
  session: App.Locals['handover'],
  tab: string,
) => holder?.userId === session?.user.id && holder?.tab === tab;

export const tabOf = (body: unknown) => {
  const tab = (body as { tab?: unknown } | undefined)?.tab;
  return typeof tab === 'string' ? tab : '';
};

// Which file an event about the whole entry names: the one the entry is written in, so the log
// links to the language somebody would open.
export async function entrySubject(
  ctx: RequestContext,
  collection: string,
  slug: string,
): Promise<string | null> {
  const source = await sourceFor(ctx, collection, slug);
  return source ? entryPath(collection, slug, source) : null;
}

/** Every language of one entry as a path, whether or not it has a file yet. */
export const entryPaths = (collection: string, slug: string) =>
  Object.fromEntries(
    config.i18n.locales.map((locale) => [locale, entryPath(collection, slug, locale)]),
  );

export const SHA = /^[0-9a-f]{7,40}$/;

export const NAME = /^[\w-]+$/;

export async function pickable(ctx: RequestContext) {
  const rows = await overlayRows('default', ctx.db(), index);
  return Object.entries(config.collections).flatMap(([collection, collected]) =>
    collectionEntries('default', index, collection, rows, collected.titleField).map((entry) => {
      const urls: Record<string, string> = {};
      for (const [locale, info] of Object.entries(entry.locales)) {
        // The same address the entry's own language serves it at: its `slug` where the
        // collection has localized slugs, its file name where it has none.
        const address = collected.localizedSlugs ? (info.slug ?? entry.id) : entry.id;
        const url = entryUrl('default', config.i18n, collected.route, address, locale);
        if (url) urls[locale] = url;
      }
      const locales = Object.keys(entry.locales);
      return {
        collection,
        // Off the site: still offered, since pointing at it is sometimes right, but the picker
        // says so — a redirect to a hidden page lands the visitor on another 404.
        hidden: Object.values(entry.locales).some((l) => l.status === 'hidden'),
        // What a reference or an entry link stores, and what the picker shows under the title.
        path: `${collection}/${entry.id}`,
        title: (entry.locales[config.i18n.defaultLocale] ?? entry.locales[locales[0] ?? ''])?.title,
        titles: Object.fromEntries(
          Object.entries(entry.locales).map(([locale, info]) => [locale, info.title]),
        ),
        hiddenLocales: Object.entries(entry.locales)
          .filter(([, info]) => info.status === 'hidden')
          .map(([locale]) => locale),
        locales,
        urls,
      };
    }),
  );
}

/**
 * Every URL the site serves now, by the name of whatever answers it: each entry's address in
 * each language it has a file in, and each collection's index under each language's segment.
 * This is what a `from` is held against — a redirect over a page that exists takes that page
 * off the site, and a client would never diagnose that from a 404.
 */
export function sitePages(entries: Awaited<ReturnType<typeof pickable>>): Record<string, string> {
  const pages: Record<string, string> = {};
  for (const [collection, collected] of Object.entries(config.collections))
    for (const locale of config.i18n.locales) {
      const url = entryUrl('default', config.i18n, collected.index, '', locale);
      // An entry beats an index that answers at the same address, because it is the more
      // specific thing to be named in the refusal.
      if (url) pages[url] = `the ${collection} index`;
    }
  for (const entry of entries)
    for (const url of Object.values(entry.urls)) pages[url] = entry.title || entry.path;
  return pages;
}

/** Every name the collection already uses, published or only drafted. */
export async function takenNames(collection: string, database: Db): Promise<string[]> {
  const rows = await overlayRows('default', database, index);
  return collectionEntries('default', index, collection, rows).map((e) => e.id);
}

/**
 * Step one of the order every write to a whole entry is held to — a rename, a delete, a hide, a
 * restore — so none of them runs under somebody who has it open. The sentence is the whole
 * answer: the entry list shows what the server said. Per person rather than per tab: the same
 * person's other tab is not "somebody else".
 */
export async function heldByAnother(
  ctx: RequestContext,
  collection: string,
  slug: string,
  session: App.Locals['handover'],
  doing: 'renamed' | 'deleted' | 'hidden' | 'shown' | 'restored',
): Promise<Response | undefined> {
  const holder = await lockHolder('default', ctx.db(), `${collection}/${slug}`);
  if (!holder || holder.userId === session?.user.id) return undefined;
  return new Response(
    `${holder.name ?? 'Somebody else'} is editing this entry — it can be ${doing} once they are done`,
    { status: 409 },
  );
}

// An entry is its file in every declared language: a rename or a delete moves all of them.
export const locationOf = (collection: string): EntryLocation => ({
  collection,
  route: config.collections[collection]?.route,
  i18n: config.i18n,
  localizedSlugs: config.collections[collection]?.localizedSlugs,
});

/** The languages of one entry with unpublished changes — what a discard or a restore throws away. */
export async function pendingLocales(
  collection: string,
  slug: string,
  database: Db,
): Promise<string[]> {
  const rows = await pendingDrafts('default', database);
  return Object.entries(entryPaths(collection, slug))
    .filter(([, path]) => rows.some((row) => row.path === path))
    .map(([locale]) => locale);
}

export const ENTRY_FILE = /^src\/content\/([a-z0-9-]+)\/([^/]+)\/([^/]+)\.yaml$/;

/**
 * Which language a file this publish is about to commit was translated from: the file of the
 * language its entry is written in, and the form that says which of its values a translation is
 * made from. Nothing for that language's own file, and nothing for a path no collection owns —
 * a global has no schema, so no form. On a site that declares one language it is always nothing,
 * which is what keeps such a site's publish the read-free write it always was.
 */
export const sourceOf = async (ctx: RequestContext, path: string) => {
  const [, collection = '', locale = '', slug = ''] = ENTRY_FILE.exec(path) ?? [];
  const schema = schemaOf(collection, slug);
  if (!schema || !locale || config.i18n.locales.length < 2) return undefined;
  const source = await sourceFor(ctx, collection, slug);
  if (!source || source === locale) return undefined;
  return {
    locale: source,
    path: entryPath(collection, slug, source),
    form: formFor(collection, slug),
  };
};

/** Where the admin edits this entry — a global is the entry screen under its own address. */
export function entryHref(entry: string): string {
  const [collection = '', slug = ''] = entry.split('/');
  return collection === 'globals' ? `/admin/site/${slug}` : `/admin/c/${collection}/${slug}`;
}
