import { parse } from 'yaml';
import type { ContentFile } from './entries.js';
import { isObject, parseEntry } from './entry-format.js';
import { entryAddress, entryUrl, type I18nRouting } from './names.js';
import { isLive } from './reserved.js';
import { humanise } from './schema.js';
import { type Labels, labelsOf } from './ui-locale.js';

export interface ContentEntry<T = unknown> {
  id: string;
  data: T;
}

// What every `load()` in a site's `src/loaders/` takes; ids are `${locale}/${slug}`.
export interface ContentSource<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Set by draftSource for authenticated preview; public sources omit it. */
  readonly preview?: boolean;
  getEntry<K extends keyof C & string>(
    collection: K,
    id: string,
  ): Promise<ContentEntry<C[K]> | undefined>;
  getCollection<K extends keyof C & string>(
    collection: K,
    locale: string,
  ): Promise<ContentEntry<C[K]>[]>;
  /** Unvalidated data for addresses, titles and visibility only; never render content from it. */
  getEntryMetadata?(
    collection: keyof C & string,
    id: string,
  ): Promise<ContentEntry<unknown> | undefined>;
  getCollectionMetadata?(
    collection: keyof C & string,
    locale: string,
  ): Promise<ContentEntry<unknown>[]>;
}

// The two functions from `astro:content`; core never imports that module itself.
export interface AstroContent<K extends string> {
  getEntry(collection: K, id: string): Promise<ContentEntry | undefined>;
  getCollection(collection: K): Promise<ContentEntry[]>;
}

export function staticSource<C extends Record<string, unknown>>(
  _siteId: string,
  astro: AstroContent<keyof C & string>,
): ContentSource<C> {
  return {
    // Ask the collection first: Astro's `getEntry` logs a miss for every untranslated entry.
    getEntry: async (collection, id) => {
      const all = await astro.getCollection(collection);
      if (!all.some((e) => e.id === id)) return undefined;
      return astro.getEntry(collection, id) as Promise<
        ContentEntry<C[typeof collection]> | undefined
      >;
    },
    getCollection: async (collection, locale) => {
      const all = await astro.getCollection(collection);
      // Without generateId the glob loader files entries under their data `slug`, a 404 everywhere.
      const misfiled = all.find((e) => !e.id.includes('/'));
      if (misfiled)
        throw new Error(
          `Collection "${collection}" has an entry filed under "${misfiled.id}" rather than "<locale>/<name>": its glob loader in src/content.config.ts needs generateId: ({ entry }) => entry.replace(/\\.ya?ml$/, '')`,
        );
      return all.filter((e) => e.id.startsWith(`${locale}/`)) as ContentEntry<
        C[typeof collection]
      >[];
    },
  };
}

/** The build's snapshot with the draft rows laid over it; metadata reads skip `validate`. */
export function draftSource<C extends Record<string, unknown>>(
  siteId: string,
  built: ContentSource<C>,
  rows: readonly ContentFile[],
  validate: (collection: string, data: unknown, path: string) => unknown,
): ContentSource<C> {
  const pathOf = (collection: string, id: string) => `src/content/${collection}/${id}.yaml`;
  const byPath = new Map<string, ContentFile>();
  const byCollectionLocale = new Map<string, { id: string; row: ContentFile }[]>();
  for (const row of rows) {
    // Canvas snapshots precede stored drafts, so the first row at a path intentionally wins.
    if (byPath.has(row.path)) continue;
    byPath.set(row.path, row);
    const match = /^src\/content\/([^/]+)\/([^/]+)\/([^/]+)\.yaml$/.exec(row.path);
    if (!match) continue;
    const [, collection, locale, name] = match;
    const key = `${collection}\0${locale}`;
    const found = byCollectionLocale.get(key) ?? [];
    found.push({ id: `${locale}/${name}`, row });
    byCollectionLocale.set(key, found);
  }
  const parsed = new Map<string, unknown>();
  const validated = new Map<string, unknown>();
  const read = <K extends keyof C & string>(
    collection: K,
    id: string,
    contents: string,
    checked: boolean,
  ) => {
    const path = pathOf(collection, id);
    if (!parsed.has(path)) parsed.set(path, parseEntry(siteId, contents));
    const data = parsed.get(path);
    if (checked && !validated.has(path))
      validated.set(path, validate(collection, structuredClone(data), path));
    return { id, data: (checked ? validated.get(path) : data) as C[K] };
  };
  const overlay = (checked: boolean): ContentSource<C> => ({
    preview: true,
    getEntry: async (collection, id) => {
      const row = byPath.get(pathOf(collection, id));
      if (!row) return built.getEntry(collection, id);
      return row.contents ? read(collection, id, row.contents, checked) : undefined;
    },
    getCollection: async (collection, locale) => {
      const mine = byCollectionLocale.get(`${collection}\0${locale}`) ?? [];
      const snapshot = await built.getCollection(collection, locale);
      const drafted = new Map(mine.map((item) => [item.id, item.row]));
      const kept = snapshot.flatMap((e) => {
        const row = drafted.get(e.id);
        if (!row) return [e];
        return row.contents ? [read(collection, e.id, row.contents, checked)] : [];
      });
      // An entry the snapshot has never seen is new since the build, so it goes at the end.
      const builtIds = new Set(snapshot.map((entry) => entry.id));
      const added = mine.filter((item) => item.row.contents && !builtIds.has(item.id));
      return [...kept, ...added.map((m) => read(collection, m.id, m.row.contents, checked))];
    },
  });
  const metadata = overlay(false);
  return {
    ...overlay(true),
    getEntryMetadata: metadata.getEntry,
    getCollectionMetadata: metadata.getCollection,
  };
}

function entryMetadata<C extends Record<string, unknown>>(
  source: ContentSource<C>,
  collection: keyof C & string,
  id: string,
): Promise<ContentEntry<unknown> | undefined> {
  return source.getEntryMetadata
    ? source.getEntryMetadata(collection, id)
    : source.getEntry(collection, id);
}

/** One language an entry can be read in, and where. */
export interface LocaleLink {
  locale: string;
  url: string;
}

/** As much of `cms.config.ts` as a link needs: the languages and the collections' routes. */
export interface LocaleSite {
  i18n: I18nRouting;
  collections: Record<
    string,
    {
      route?: string;
      index?: string;
      localizedSlugs?: boolean;
      titleField?: string;
      label?: string | Labels;
    }
  >;
}

/** The switcher's languages: a file that exists and is live, never the `_locales` mark. */
export async function getEntryLocales<C extends Record<string, unknown>>(
  siteId: string,
  source: ContentSource<C>,
  site: LocaleSite,
  collection: keyof C & string,
  slug: string,
): Promise<LocaleLink[]> {
  const route = site.collections[collection]?.route;
  if (!route) return [];
  const found = await Promise.all(
    site.i18n.locales.map(async (locale) => {
      const entry = await entryMetadata(source, collection, `${locale}/${slug}`);
      if (!entry || !isLive(siteId, entry.data)) return undefined;
      const address = site.collections[collection]?.localizedSlugs
        ? entryAddress(siteId, entry.data, slug)
        : slug;
      const url = entryUrl(siteId, site.i18n, route, address, locale);
      return url ? { locale, url } : undefined;
    }),
  );
  return found.filter((l) => l !== undefined);
}

/** One menu item as a page renders it: an address, and the items under it. */
export interface NavLink {
  label: string;
  href: string;
  newTab?: boolean;
  children: NavLink[];
}

/** An item whose entry is missing or hidden in this language is dropped, children included. */
export async function menusAt<C extends Record<string, unknown>>(
  siteId: string,
  source: ContentSource<C>,
  site: LocaleSite,
  navigation: unknown,
  locale: string,
): Promise<Record<string, NavLink[]>> {
  const menus = isObject(navigation) && Array.isArray(navigation.menus) ? navigation.menus : [];
  const out: Record<string, NavLink[]> = {};
  for (const menu of menus) {
    if (!isObject(menu) || typeof menu.key !== 'string') continue;
    out[menu.key] = await navLinks(siteId, source, site, menu.items, locale);
  }
  return out;
}

async function navLinks<C extends Record<string, unknown>>(
  siteId: string,
  source: ContentSource<C>,
  site: LocaleSite,
  items: unknown,
  locale: string,
): Promise<NavLink[]> {
  const links: NavLink[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!isObject(item)) continue;
    if (Array.isArray(item._locales) && !item._locales.includes(locale)) continue;
    const target = await href(siteId, source, site, item.link, locale);
    if (!target) continue;
    links.push({
      label: (typeof item.label === 'string' && item.label) || target.name,
      href: target.href,
      ...(item.newTab === true ? { newTab: true } : {}),
      children: await navLinks(siteId, source, site, item.children, locale),
    });
  }
  return links;
}

/** An index page has no title: its collection's label in this language, a plain label being English. */
export function indexName(collection: string, label: unknown, locale: string): string {
  const named = (typeof label === 'string' && label ? { en: label } : labelsOf(label))?.[
    locale as keyof Labels
  ];
  return named ? named.charAt(0).toUpperCase() + named.slice(1) : humanise(collection);
}

/** Where one item points in this language, and what the page it points at is called. */
async function href<C extends Record<string, unknown>>(
  siteId: string,
  source: ContentSource<C>,
  site: LocaleSite,
  link: unknown,
  locale: string,
): Promise<{ href: string; name: string } | undefined> {
  if (!isObject(link)) return undefined;
  if (link.type === 'url')
    return typeof link.href === 'string' ? { href: link.href, name: link.href } : undefined;
  // An index is not an entry: the address is this language's index page, or nothing.
  if (link.type === 'index') {
    if (typeof link.collection !== 'string') return undefined;
    const url = entryUrl(siteId, site.i18n, site.collections[link.collection]?.index, '', locale);
    return url
      ? {
          href: url,
          name: indexName(link.collection, site.collections[link.collection]?.label, locale),
        }
      : undefined;
  }
  if (typeof link.ref !== 'string') return undefined;
  const cut = link.ref.indexOf('/');
  const collection = link.ref.slice(0, cut);
  const name = link.ref.slice(cut + 1);
  if (cut < 1 || !name) return undefined;
  const entry = await entryMetadata(source, collection as keyof C & string, `${locale}/${name}`);
  if (!entry || !isLive(siteId, entry.data)) return undefined;
  const of = site.collections[collection];
  const address = of?.localizedSlugs ? entryAddress(siteId, entry.data, name) : name;
  const url = entryUrl(siteId, site.i18n, of?.route, address, locale);
  const titled = isObject(entry.data) ? entry.data[of?.titleField ?? 'title'] : undefined;
  return url ? { href: url, name: typeof titled === 'string' ? titled : name } : undefined;
}

/** With localized slugs a file whose `slug` moved is not served under its file name. */
export async function entryAt<C extends Record<string, unknown>, K extends keyof C & string>(
  siteId: string,
  source: ContentSource<C>,
  site: LocaleSite,
  collection: K,
  locale: string,
  address: string,
): Promise<ContentEntry<C[K]> | undefined> {
  const visible = (entry: ContentEntry<C[K]> | undefined) =>
    entry && (source.preview === true || isLive(siteId, entry.data)) ? entry : undefined;
  if (!site.collections[collection]?.localizedSlugs)
    return visible(await source.getEntry(collection, `${locale}/${address}`));
  // Resolve from metadata first so a slug scan does not validate every page in the language.
  const named = await entryMetadata(source, collection, `${locale}/${address}`);
  if (named && entryAddress(siteId, named.data, address) === address)
    return visible(await source.getEntry(collection, named.id));
  const found = source.getCollectionMetadata
    ? await source.getCollectionMetadata(collection, locale)
    : await source.getCollection(collection, locale);
  const match = found.find(
    (e) => entryAddress(siteId, e.data, e.id.slice(locale.length + 1)) === address,
  );
  return match ? visible(await source.getEntry(collection, match.id)) : undefined;
}

/** Every `_ref` naming an undeclared global: refused at build like an unregistered `_type`. */
export function refErrors(
  _siteId: string,
  path: string,
  contents: string,
  globals: Iterable<string>,
): string[] {
  const declared = [...globals];
  const errors: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, `${at}[${i}]`);
      });
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const here = at ? `${at}.${key}` : key;
      if (key === '_ref' && typeof value === 'string') {
        const name = value.replace(/^globals\//, '');
        if (!declared.includes(name))
          errors.push(
            `${path} › ${here}: no global ${JSON.stringify(name)} is declared in cms.config.ts — it has ${declared.join(', ') || 'none'}`,
          );
      } else walk(value, here);
    }
  };
  walk(parse(contents), '');
  return errors;
}

/** Content a loader requires cannot be rendered; preview reports it as a readable 422. */
export class ContentError extends Error {}

export interface GlobalsSelection {
  /** Globals read directly by the layout, such as site details and navigation. */
  required?: readonly string[];
  /** The tree passed to Blocks; references are discovered through nested arrays and objects. */
  blocks?: unknown;
}

/** Omit selection to read the whole collection; selected globals use validated entry reads. */
export async function globalsAt<C extends Record<string, unknown>>(
  _siteId: string,
  source: ContentSource<C>,
  locale: string,
  selection?: GlobalsSelection,
): Promise<Record<string, unknown>> {
  if (!selection) {
    const found = await source.getCollection('globals' as keyof C & string, locale);
    return Object.fromEntries(found.map((e) => [e.id.slice(locale.length + 1), e.data]));
  }
  const names = new Set(selection.required?.map((name) => name.replace(/^globals\//, '')));
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return;
    const block = value as Record<string, unknown>;
    // Match Blocks: a ref is replaced as a whole, without walking the replacement again.
    if (typeof block._ref === 'string') names.add(block._ref.replace(/^globals\//, ''));
    else Object.values(block).forEach(walk);
  };
  walk(selection.blocks);
  const found = await Promise.all(
    [...names].map(async (name) => {
      const entry = await source.getEntry('globals' as keyof C & string, `${locale}/${name}`);
      if (!entry)
        throw new ContentError(
          `src/content/globals/${locale}/${name}.yaml: No global "${name}" in this language`,
        );
      return [name, entry.data] as const;
    }),
  );
  return Object.fromEntries(found);
}
