import { parseEntry, stringifyEntry, writtenEntry } from './content.js';
import type { ContentFile } from './entries.js';
import type { GitClient, PublishFile } from './git.js';
import { entryAddress, entryUrl, type I18nRouting } from './names.js';
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
  /** The site's languages, and what a URL under each of them looks like. */
  i18n: I18nRouting;
  /** Whether the collection's files carry an address of their own, which is not the file name. */
  localizedSlugs?: boolean;
}

const REDIRECTS = 'src/content/redirects.yaml';
const entryPath = (collection: string, locale: string, name: string) =>
  `src/content/${collection}/${locale}/${name}.yaml`;

async function localeFiles(git: GitClient, loc: EntryLocation, name: string) {
  const found: { locale: string; contents: string }[] = [];
  for (const locale of loc.i18n.locales) {
    const file = await git.getFile(entryPath(loc.collection, locale, name));
    if (file) found.push({ locale, contents: file.contents });
  }
  if (found.length === 0)
    throw new Error(
      `${loc.collection}/${name} has no file in any of ${loc.i18n.locales.join(', ')}`,
    );
  return found;
}

/** One rule as the file carries it: an id of its own and when it was made. */
export const redirectRule = (
  siteId: string,
  rule: Omit<RedirectRule, '_id' | 'createdAt'>,
  at: number,
): RedirectRule => ({
  _id: newId(siteId),
  ...rule,
  createdAt: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
});

/**
 * `redirects.yaml` with these rules appended. Existing rules that pointed at one's `from` now
 * point at its `to`, so a visitor never hops twice; a rule that would then redirect a URL to
 * itself (a rename back) is dropped. A publish carrying an address change appends here rather
 * than committing on its own, so the entry and the redirect for it land in one commit.
 */
export async function appendRedirects(
  siteId: string,
  git: Pick<GitClient, 'getFile'>,
  added: readonly RedirectRule[],
): Promise<PublishFile> {
  const file = await git.getFile(REDIRECTS);
  const doc = (file ? parseEntry(siteId, file.contents) : { _version: 1 }) as {
    rules?: RedirectRule[];
  };
  let rules = doc.rules ?? [];
  for (const rule of added)
    rules = [...rules, rule]
      .map((r) => (r !== rule && r.to === rule.from ? { ...r, to: rule.to, entry: rule.entry } : r))
      .filter((r) => r.from !== r.to);
  return { path: REDIRECTS, contents: stringifyEntry(siteId, { ...doc, rules }) };
}

const redirectsFile = (
  siteId: string,
  git: GitClient,
  rules: Omit<RedirectRule, '_id' | 'createdAt'>[],
  now: () => number,
) =>
  appendRedirects(
    siteId,
    git,
    rules.map((rule) => redirectRule(siteId, rule, now())),
  );

/**
 * The URL one language served this file at. The file name is the address only where the
 * collection has none of its own; with `localizedSlugs` a language answers to the `slug` in its
 * own file, so each language's URL has to be read out of that language's file rather than
 * built from the name every language shares.
 */
const urlOf = (
  siteId: string,
  loc: EntryLocation,
  file: { locale: string; contents: string },
  name: string,
) => {
  const data = loc.localizedSlugs ? parseEntry(siteId, file.contents) : undefined;
  return entryUrl(siteId, loc.i18n, loc.route, entryAddress(siteId, data, name), file.locale);
};

// One commit moves every locale file and records where each language's old URL now goes.
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
  // A language whose address is its own did not move: renaming the file changes no URL there.
  const rules = files.flatMap((file) => {
    const was = urlOf(siteId, loc, file, from);
    const now = urlOf(siteId, loc, file, to);
    return was && now && was !== now
      ? [
          {
            from: was,
            to: now,
            status: 301 as const,
            reason: 'slug-change' as const,
            entry: `${loc.collection}/${to}`,
          },
        ]
      : [];
  });
  if (rules.length) changes.push(await redirectsFile(siteId, git, rules, deps.now ?? Date.now));
  return git.publish(changes, { base_sha, message: `Rename ${loc.collection}/${from} to ${to}` });
}

/**
 * `redirectTo` is the route on this site the client picked in the dialog; `undefined` means
 * "nowhere". It is a route rather than a URL, so it is served under each language's own
 * segment too: a German page that goes away sends its visitors to the German index and not to
 * an English page they cannot read.
 */
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
  const rules = !redirectTo
    ? []
    : files.flatMap((file) => {
        const was = urlOf(siteId, loc, file, name);
        const to = entryUrl(siteId, loc.i18n, redirectTo, '', file.locale);
        return was && to && was !== to
          ? [{ from: was, to, status: 301 as const, reason: 'deleted' as const }]
          : [];
      });
  if (rules.length) changes.push(await redirectsFile(siteId, git, rules, deps.now ?? Date.now));
  return git.publish(changes, { base_sha, message: `Delete ${loc.collection}/${name}` });
}

// The `_redirects` format Workers Static Assets serves: one `/from /to status` per line.
export const redirectsText = (_siteId: string, rules: RedirectRule[]): string =>
  rules.map((r) => `${r.from} ${r.to} ${r.status}\n`).join('');

/**
 * Every locale file of an entry copied under a new name, ready to be written as drafts: one
 * `_id` map shared across the locales, so the copy is still one entry with a matching
 * skeleton. Session 2.9 (decap-cms#7371, payload#14491).
 *
 * The address stays with the entry that had it — two entries answering to one URL is what the
 * address route refuses — so the copy falls back to its new file name until somebody gives it
 * one of its own.
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
  return files.map(({ locale, contents }) => {
    const copy = writtenEntry(siteId, regenerateIds(siteId, parseEntry(siteId, contents), ids));
    if (loc.localizedSlugs) delete copy.slug;
    return { path: entryPath(loc.collection, locale, to), contents: stringifyEntry(siteId, copy) };
  });
}
