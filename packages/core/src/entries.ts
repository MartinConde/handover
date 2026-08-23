import { parseEntry } from './content.js';

export interface EntryLocale {
  title: string;
  path: string;
  status?: 'hidden';
}

/** One row per entry, never per file: the filename is the id across locales. */
export interface IndexEntry {
  id: string;
  locales: Record<string, EntryLocale>;
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

/** Everything the list needs about one file, or nothing if it is not an entry. */
function indexFile(siteId: string, { path, contents }: ContentFile) {
  const found = ENTRY_PATH.exec(path);
  if (!found) return undefined;
  const [, collection = '', locale = '', id = ''] = found;
  if (collection === 'globals') return undefined;
  const data = parseEntry(siteId, contents) as { title?: unknown; _status?: unknown } | null;
  // A collection keyed on something other than `title` lists by filename rather than by nothing.
  const title = typeof data?.title === 'string' && data.title ? data.title : id;
  const info: EntryLocale = { title, path };
  if (data?._status === 'hidden') info.status = 'hidden';
  return { collection, locale, id, info };
}

export function indexFrom(siteId: string, files: Iterable<ContentFile>): ContentIndex {
  const index = new Map<string, IndexEntry[]>();
  for (const file of files) {
    const entry = indexFile(siteId, file);
    if (!entry) continue;
    const entries = index.get(entry.collection) ?? [];
    index.set(entry.collection, entries);
    const found = entries.find((e) => e.id === entry.id);
    if (found) found.locales[entry.locale] = entry.info;
    else entries.push({ id: entry.id, locales: { [entry.locale]: entry.info } });
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
): IndexEntry[] {
  const prefix = `src/content/${collection}/`;
  const rows = drafts.filter((d) => d.path.startsWith(prefix));
  const gone = new Set(rows.filter((r) => !r.contents).map((r) => r.path));
  const entries = (index[collection] ?? []).map((e) => ({ id: e.id, locales: { ...e.locales } }));
  for (const draft of indexFrom(
    siteId,
    rows.filter((r) => r.contents),
  )[collection] ?? []) {
    const found = entries.find((e) => e.id === draft.id);
    if (found) Object.assign(found.locales, draft.locales);
    else entries.push(draft);
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
