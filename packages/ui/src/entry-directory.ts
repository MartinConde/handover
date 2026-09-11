import { request } from './request.js';

/** One thing an editor can point at, as `/admin/api/entries` answers it. */
export interface PickEntry {
  collection: string;
  /** `collection/name` — what a reference or an entry link stores. */
  path: string;
  title: string;
  /** Each available language's title, for localized navigation label placeholders. */
  titles?: Record<string, string>;
  /** Hidden status per language; older responses only carry the aggregate `hidden`. */
  hiddenLocales?: string[];
  /** The languages this entry has a file in. */
  locales: string[];
  /** Where each of them serves it; empty for a collection nothing renders. */
  urls: Record<string, string>;
  /** Off the site: still an answer, but a poor one, and the list says why. */
  hidden?: boolean;
  /** A collection's index page rather than an entry; `path` is then the collection alone. */
  index?: true;
}

export interface Pickable {
  entries: PickEntry[];
  /** The collections with an index page, and where each language serves it. */
  indexes?: PickEntry[];
  /** The languages the site declares, in config order: what the chips are drawn for. */
  locales: string[];
  /** The one whose URLs carry no segment of their own, unless the site asked for one. */
  defaultLocale?: string;
}

export const EMPTY_ENTRY_DIRECTORY: Pickable = { entries: [], locales: [] };

export interface EntryDirectoryReader {
  read(): Promise<Pickable>;
  invalidate(): void;
}

/**
 * One catalogue cache for one authenticated app or Canvas runtime. Concurrent consumers share the
 * request; failures are deliberately not cached so opening another picker can retry.
 */
export function createEntryDirectoryReader(
  fetcher: typeof globalThis.fetch,
  endpoint = '/admin/api/entries',
): EntryDirectoryReader {
  let current: Pickable | undefined;
  let pending: Promise<Pickable> | undefined;
  let generation = 0;

  const read = (): Promise<Pickable> => {
    if (current) return Promise.resolve(current);
    if (pending) return pending;
    const requestedAt = generation;
    const next: Promise<Pickable> = fetcher(endpoint).then(async (response): Promise<Pickable> => {
      if (!response.ok)
        throw new Error(`The entry catalogue could not be read (${response.status}).`);
      const value = (await response.json()) as Pickable;
      // An entry may have changed while this response was travelling. Existing consumers should
      // join the replacement read instead of briefly painting the invalidated names or addresses.
      if (requestedAt !== generation) return read();
      current = value;
      return value;
    });
    let tracked!: Promise<Pickable>;
    tracked = next.finally(() => {
      if (pending === tracked) pending = undefined;
    });
    pending = tracked;
    return tracked;
  };

  return {
    read,
    invalidate() {
      generation += 1;
      current = undefined;
      pending = undefined;
    },
  };
}

// The admin is one authenticated app. Recursive forms, menus, redirects and pickers all consume
// this reader until an entry mutation explicitly invalidates it.
const appEntryDirectory = createEntryDirectoryReader(request);

export const readEntryDirectory = () => appEntryDirectory.read();
export const invalidateEntryDirectory = () => appEntryDirectory.invalidate();
