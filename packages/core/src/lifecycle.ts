import { parseEntry, stringifyEntry } from './content.js';
import type { ContentFile } from './entries.js';
import type { GitClient, PublishFile } from './git.js';
import { newId, regenerateIds } from './reserved.js';

export interface RedirectRule {
  _id: string;
  from: string;
  to: string;
  status: 301;
  reason: 'slug-change' | 'hidden' | 'deleted' | 'manual';
  entry?: string;
  createdAt: string;
}

export interface EntryLocation {
  collection: string;
  /** The collection's `route`; without one the entry has no URL and no redirect is written. */
  route?: string;
  locales: string[];
}

const REDIRECTS = 'src/content/redirects.yaml';
const entryPath = (collection: string, locale: string, name: string) =>
  `src/content/${collection}/${locale}/${name}.yaml`;

async function localeFiles(git: GitClient, loc: EntryLocation, name: string) {
  const found: { locale: string; contents: string }[] = [];
  for (const locale of loc.locales) {
    const file = await git.getFile(entryPath(loc.collection, locale, name));
    if (file) found.push({ locale, contents: file.contents });
  }
  if (found.length === 0)
    throw new Error(`${loc.collection}/${name} has no file in any of ${loc.locales.join(', ')}`);
  return found;
}

// Appends one rule. Existing rules that pointed at `from` now point at `to`, so a visitor never
// hops twice; a rule that would then redirect a URL to itself (a rename back) is dropped.
async function redirectsFile(
  siteId: string,
  git: GitClient,
  rule: Omit<RedirectRule, '_id' | 'createdAt'>,
  now: () => number,
): Promise<PublishFile> {
  const file = await git.getFile(REDIRECTS);
  const doc = (file ? parseEntry(siteId, file.contents) : { _version: 1 }) as {
    rules?: RedirectRule[];
  };
  const added: RedirectRule = {
    _id: newId(siteId),
    ...rule,
    createdAt: new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const rules = [...(doc.rules ?? []), added]
    .map((r) =>
      r !== added && r.to === added.from ? { ...r, to: added.to, entry: added.entry } : r,
    )
    .filter((r) => r.from !== r.to);
  return { path: REDIRECTS, contents: stringifyEntry(siteId, { ...doc, rules }) };
}

// One commit moves every locale file and records where the old URL now goes.
export async function renameEntry(
  siteId: string,
  git: GitClient,
  loc: EntryLocation,
  from: string,
  to: string,
  deps: { now?: () => number } = {},
): Promise<{ commit_sha: string }> {
  const [base_sha, files] = await Promise.all([git.getHead(), localeFiles(git, loc, from)]);
  const changes: PublishFile[] = files.flatMap(({ locale, contents }) => [
    { path: entryPath(loc.collection, locale, from), contents: null },
    { path: entryPath(loc.collection, locale, to), contents },
  ]);
  if (loc.route)
    changes.push(
      await redirectsFile(
        siteId,
        git,
        {
          from: loc.route.replace('[slug]', from),
          to: loc.route.replace('[slug]', to),
          status: 301,
          reason: 'slug-change',
          entry: `${loc.collection}/${to}`,
        },
        deps.now ?? Date.now,
      ),
    );
  return git.publish(changes, { base_sha, message: `Rename ${loc.collection}/${from} to ${to}` });
}

// `redirectTo` is what the client picked in the dialog; `undefined` means "nowhere".
export async function deleteEntry(
  siteId: string,
  git: GitClient,
  loc: EntryLocation,
  name: string,
  redirectTo: string | undefined,
  deps: { now?: () => number } = {},
): Promise<{ commit_sha: string }> {
  const [base_sha, files] = await Promise.all([git.getHead(), localeFiles(git, loc, name)]);
  const changes: PublishFile[] = files.map(({ locale }) => ({
    path: entryPath(loc.collection, locale, name),
    contents: null,
  }));
  if (loc.route && redirectTo)
    changes.push(
      await redirectsFile(
        siteId,
        git,
        { from: loc.route.replace('[slug]', name), to: redirectTo, status: 301, reason: 'deleted' },
        deps.now ?? Date.now,
      ),
    );
  return git.publish(changes, { base_sha, message: `Delete ${loc.collection}/${name}` });
}

// The `_redirects` format Workers Static Assets serves: one `/from /to status` per line.
export const redirectsText = (_siteId: string, rules: RedirectRule[]): string =>
  rules.map((r) => `${r.from} ${r.to} ${r.status}\n`).join('');

/**
 * Every locale file of an entry copied under a new name, ready to be written as drafts: one
 * `_id` map shared across the locales, so the copy is still one entry with a matching
 * skeleton. Session 2.9 (decap-cms#7371, payload#14491).
 */
export async function duplicateEntry(
  siteId: string,
  git: GitClient,
  loc: EntryLocation,
  from: string,
  to: string,
): Promise<ContentFile[]> {
  const files = await localeFiles(git, loc, from);
  const ids = new Map<string, string>();
  return files.map(({ locale, contents }) => ({
    path: entryPath(loc.collection, locale, to),
    contents: stringifyEntry(siteId, regenerateIds(siteId, parseEntry(siteId, contents), ids)),
  }));
}
