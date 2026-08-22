import { parse, stringify } from 'yaml';

export interface ContentEntry<T = unknown> {
  id: string;
  data: T;
}

// What every `load()` in a site's `src/loaders/` takes. Ids are `${locale}/${slug}`.
export interface ContentSource<C extends Record<string, unknown> = Record<string, unknown>> {
  getEntry<K extends keyof C & string>(
    collection: K,
    id: string,
  ): Promise<ContentEntry<C[K]> | undefined>;
  getCollection<K extends keyof C & string>(
    collection: K,
    locale: string,
  ): Promise<ContentEntry<C[K]>[]>;
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
    getEntry: (collection, id) =>
      astro.getEntry(collection, id) as Promise<ContentEntry<C[typeof collection]> | undefined>,
    getCollection: async (collection, locale) =>
      (await astro.getCollection(collection)).filter((e) =>
        e.id.startsWith(`${locale}/`),
      ) as ContentEntry<C[typeof collection]>[],
  };
}

// Entry files are YAML; options stay fixed here so every site round-trips identically.
export function parseEntry(_siteId: string, contents: string): unknown {
  return parse(contents);
}

// lineWidth 0 keeps a long sentence on one line, so a one-field edit is a one-line diff.
export function stringifyEntry(_siteId: string, data: unknown): string {
  return stringify(data, { lineWidth: 0 });
}
