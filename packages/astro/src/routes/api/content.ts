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

/** The pasted key wins; a site with neither never needs `HANDOVER_SETTINGS_KEY`. */
export async function deeplKey(ctx: RequestContext): Promise<string | undefined> {
  const e = env as Record<string, string | undefined>;
  const stored = await readSetting('default', ctx.db(), e.HANDOVER_SETTINGS_KEY, 'deepl');
  return stored ?? e.DEEPL_API_KEY;
}

// A stored key that cannot be decrypted is translation off here; Settings says why.
export async function translator(ctx: RequestContext): Promise<Translate | undefined> {
  if (config.i18n.translate) return config.i18n.translate;
  const key = await deeplKey(ctx).catch(() => undefined);
  return key ? deeplTranslate('default', key) : undefined;
}

// Falls back to the file name: a lock outlives the commit that removed its entry.
export function entryTitle(entry: string): string {
  const [collection = '', slug = ''] = entry.split('/');
  const found = index[collection]?.find((e) => e.id === slug);
  return Object.values(found?.locales ?? {})[0]?.title ?? slug;
}

// No language is implied: every caller says which file it means.
export const entryPath = (collection: string, slug: string, locale: string) =>
  `src/content/${collection}/${locale}/${slug}.yaml`;

/** The language an entry is edited in is the entry's own: a German-only entry is German. */
export const sourceOrder = () => [...new Set([config.i18n.defaultLocale, ...config.i18n.locales])];

export const sourceIn = (loaded: Record<string, unknown>) => sourceOrder().find((l) => l in loaded);

// Asked in order: an ordinary entry costs one read, a one-language site none.
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

// Empty on a one-language site, which keeps that site's save exactly the write it was.
export const siblingPaths = (collection: string, slug: string, source: string) =>
  Object.fromEntries(
    config.i18n.locales
      .filter((locale) => locale !== source)
      .map((locale) => [locale, entryPath(collection, slug, locale)]),
  );

// Every file must be recorded in D1 too, or a draft at the old path publishes it back.
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

/** A global rides the entry path as collection `globals`; it has no address, rename or delete. */
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

/** Built the same way as the build's, or every translated entry reads stale. */
export function formFor(collection: string, slug: string): Form {
  const form = entryForm(config, collection, slug);
  if (!form) throw new Error(`No collection ${collection}`);
  return form;
}

// `written` is the languages it has a file in, which the mark has to agree with.
export const offeredIn = (data: unknown, written: string[]) =>
  entryOffer(
    'default',
    config.i18n.locales,
    (data as { _locales?: unknown } | null)?._locales,
    written,
  );

/** Found by the `defaultSeo` key; read per open, not on `ping`, since another tab may edit it. */
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

// Draft where there is one, repository where not, and no key for a language with no file.
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
      // An empty file is still the language's file, so it opens as an empty entry.
      if (!contents && !file) return undefined;
      const pending = row ? (await blobSha(row.contents)) !== file?.blob_sha : false;
      return [
        locale,
        {
          revision: row?.revision,
          data: contents ? parseEntry('default', contents) : {},
          pending,
          held: Boolean(row?.heldBy),
          // A draft with no file behind it is a page only the preview can show.
          live: Boolean(file),
          // What a redirect's `from` is: an address only a draft has was never followed.
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

// A request with no token is its own tab, so a hand-made call on a held entry is refused.
export const isHolder = (
  holder: { userId: string; tab: string } | undefined,
  session: App.Locals['handover'],
  tab: string,
) => holder?.userId === session?.user.id && holder?.tab === tab;

export const tabOf = (body: unknown) => {
  const tab = (body as { tab?: unknown } | undefined)?.tab;
  return typeof tab === 'string' ? tab : '';
};

// The language the entry is written in, so the log links to the file somebody would open.
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
        // Its `slug` where the collection has localized slugs, its file name where not.
        const address = collected.localizedSlugs ? (info.slug ?? entry.id) : entry.id;
        const url = entryUrl('default', config.i18n, collected.route, address, locale);
        if (url) urls[locale] = url;
      }
      const locales = Object.keys(entry.locales);
      return {
        collection,
        // Still offered, but flagged: a redirect to a hidden page lands on another 404.
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

/** What a `from` is held against: a redirect over a live page takes it off the site silently. */
export function sitePages(entries: Awaited<ReturnType<typeof pickable>>): Record<string, string> {
  const pages: Record<string, string> = {};
  for (const [collection, collected] of Object.entries(config.collections))
    for (const locale of config.i18n.locales) {
      const url = entryUrl('default', config.i18n, collected.index, '', locale);
      // An entry beats an index at the same address, being the more specific thing to name.
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

/** Per person, not per tab: the same person's other tab is not "somebody else". */
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

/** The languages of one entry with unpublished changes. */
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

/** Nothing on a one-language site, which keeps its publish the read-free write it was. */
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
