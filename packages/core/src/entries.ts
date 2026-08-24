import { parseEntry } from './content.js';

export interface EntryLocale {
  title: string;
  path: string;
  status?: 'hidden';
  /** The file's own `slug`, where it has one: the address this language serves it at. */
  slug?: string;
}

/** One row per entry, never per file: the filename is the id across locales. */
export interface IndexEntry {
  id: string;
  locales: Record<string, EntryLocale>;
  /** The languages it is offered in, absent when that is every language the site declares. */
  offered?: string[];
}

export type ContentIndex = Record<string, IndexEntry[]>;

export interface ContentFile {
  path: string;
  contents: string;
}

// Collection names are lowercase, so `_templates/` never matches; `globals/` looks like a
// collection and is not one. `redirects.yaml` has no locale segment.
const ENTRY_PATH = /^src\/content\/([a-z0-9-]+)\/([^/]+)\/([^/]+)\.yaml$/;

// The site files that are not entries; globals already share the entry layout.
const OTHER_PATHS = [
  /^src\/content\/redirects\.yaml$/,
  /^src\/content\/_templates\/[a-z0-9-]+\/[^/]+\.yaml$/,
];

/**
 * Why a `.yaml` file under `src/content/` is neither an entry nor one of the site files —
 * empty when they all are. The build fails on these: the entry list promises every entry,
 * and a file the CMS cannot address by `collection/slug` would silently not be in it.
 */
export function contentPathErrors(_siteId: string, paths: Iterable<string>): string[] {
  const errors: string[] = [];
  for (const path of paths) {
    if (ENTRY_PATH.test(path) || OTHER_PATHS.some((p) => p.test(path))) continue;
    errors.push(
      `${path}: an entry is src/content/<collection>/<locale>/<name>.yaml, one folder per locale and no folders below it`,
    );
  }
  return errors;
}

const byId = (a: IndexEntry, b: IndexEntry) => a.id.localeCompare(b.id);

/** Which field holds the entry's title, per collection: `titleField` in cms.config.ts. */
export type TitleFields = Record<string, string>;

/** Everything the list needs about one file, or nothing if it is not an entry. */
function indexFile(siteId: string, { path, contents }: ContentFile, titleFields: TitleFields) {
  const found = ENTRY_PATH.exec(path);
  if (!found) return undefined;
  const [, collection = '', locale = '', id = ''] = found;
  if (collection === 'globals') return undefined;
  const data = parseEntry(siteId, contents) as Record<string, unknown> | null;
  // A collection that declares no title field, or an entry that has not filled it in yet,
  // lists by filename rather than by nothing.
  const named = data?.[titleFields[collection] ?? 'title'];
  const title = typeof named === 'string' && named ? named : id;
  const info: EntryLocale = { title, path };
  if (data?._status === 'hidden') info.status = 'hidden';
  // Read whatever the collection's flag turns out to be: a `slug` in a collection without
  // localized slugs is an ordinary field, and nothing addresses an entry through this.
  if (typeof data?.slug === 'string' && data.slug) info.slug = data.slug;
  // Every file of the entry carries the same list, so whichever one is read says the same thing.
  const offered = Array.isArray(data?._locales) ? (data._locales as string[]) : undefined;
  return { collection, locale, id, info, offered };
}

export function indexFrom(
  siteId: string,
  files: Iterable<ContentFile>,
  titleFields: TitleFields = {},
): ContentIndex {
  const index = new Map<string, IndexEntry[]>();
  for (const file of files) {
    const entry = indexFile(siteId, file, titleFields);
    if (!entry) continue;
    const entries = index.get(entry.collection) ?? [];
    index.set(entry.collection, entries);
    let row = entries.find((e) => e.id === entry.id);
    if (!row) {
      row = { id: entry.id, locales: {} };
      entries.push(row);
    }
    row.locales[entry.locale] = entry.info;
    if (entry.offered) row.offered = entry.offered;
  }
  return Object.fromEntries([...index].map(([name, entries]) => [name, entries.sort(byId)]));
}

/**
 * The built index for one collection with the pending drafts laid over it. A draft is what
 * the editor last saw, so its title and status win over the file the index was built from,
 * and a draft for an entry the index does not know is one that has never been committed.
 */
export function collectionEntries(
  siteId: string,
  index: ContentIndex,
  collection: string,
  drafts: readonly ContentFile[],
  titleField?: string,
): IndexEntry[] {
  const prefix = `src/content/${collection}/`;
  const rows = drafts.filter((d) => d.path.startsWith(prefix));
  const gone = new Set(rows.filter((r) => !r.contents).map((r) => r.path));
  const entries = (index[collection] ?? []).map((e) => ({ ...e, locales: { ...e.locales } }));
  for (const draft of indexFrom(
    siteId,
    rows.filter((r) => r.contents),
    titleField ? { [collection]: titleField } : {},
  )[collection] ?? []) {
    const found = entries.find((e) => e.id === draft.id);
    if (found) {
      Object.assign(found.locales, draft.locales);
      if (draft.offered) found.offered = draft.offered;
      else delete found.offered;
    } else entries.push(draft);
  }
  // A rename or a delete writes to git without touching the index, so the file it removed is
  // still in there: an empty row is what says the path has gone until the build catches up.
  for (const entry of entries)
    for (const [locale, info] of Object.entries(entry.locales))
      if (gone.has(info.path)) delete entry.locales[locale];
  return entries.filter((e) => Object.keys(e.locales).length > 0).sort(byId);
}

/** Whether the built index knows this path — what says a repo write has reached the build. */
export const indexHasPath = (index: ContentIndex, path: string): boolean =>
  Object.values(index).some((entries) =>
    entries.some((e) => Object.values(e.locales).some((l) => l.path === path)),
  );

/**
 * The languages an entry is offered in, and what its own `_locales` gets wrong. The mark is
 * written into every file the entry has, so a language with a file that the mark leaves out is
 * a hand edit or a bad merge — the same contradiction a block's `_locales` has as drift, one
 * level up. **The file wins**: the entry list and the editor read one answer rather than two,
 * and the disagreement is reported instead of being drawn twice.
 *
 * A code the site does not declare is offered nowhere, so it is named here rather than leaving
 * an empty `offered` for the routes to refuse over.
 */
export function entryOffer(
  _siteId: string,
  locales: string[],
  marked: unknown,
  written: string[],
): { offered: string[]; problems: string[] } {
  if (!Array.isArray(marked)) return { offered: locales, problems: [] };
  const problems = marked
    .filter((locale) => !locales.includes(locale as string))
    .map(
      (locale) =>
        `_locales names ${JSON.stringify(locale)}, which is not one of the languages this site declares: ${locales.join(', ')}`,
    );
  const offered = locales.filter((locale) => marked.includes(locale) || written.includes(locale));
  for (const locale of offered)
    if (!marked.includes(locale))
      problems.push(
        `_locales says this entry is not offered in ${locale}, and it has a file in ${locale}`,
      );
  return { offered, problems };
}
