import { parseEntry } from './content.js';

/** Written into the site's output by the build, read by the entry list. */
export const INDEX_FILE = 'handover-index.json';

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
  const pending = drafts.filter((d) => d.path.startsWith(prefix));
  const entries = (index[collection] ?? []).map((e) => ({ id: e.id, locales: { ...e.locales } }));
  for (const draft of indexFrom(siteId, pending)[collection] ?? []) {
    const found = entries.find((e) => e.id === draft.id);
    if (found) Object.assign(found.locales, draft.locales);
    else entries.push(draft);
  }
  return entries.sort(byId);
}
