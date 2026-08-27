import { offeredEntry, parseEntry, stringifyEntry, writtenEntry } from './content.js';
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

/** The one file several entries write into, which is why a publish assembles it. */
export const REDIRECTS = 'src/content/redirects.yaml';
const entryPath = (collection: string, locale: string, name: string) =>
  `src/content/${collection}/${locale}/${name}.yaml`;

// `at` is the commit these files are read from, which is the one the caller is about to commit
// against: a rename that carried bytes from a different commit would put somebody else's work
// back, and the ref update would not refuse it (git.ts, `getFile`).
async function localeFiles(git: GitClient, loc: EntryLocation, name: string, at: string) {
  const found: { locale: string; contents: string }[] = [];
  for (const locale of loc.i18n.locales) {
    const file = await git.getFile(entryPath(loc.collection, locale, name), at);
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
 * `redirects.yaml` with these rules appended and the ones `drop` names taken out. Existing rules
 * that pointed at one's `from` now point at its `to`, so a visitor never hops twice; a rule that
 * would then redirect a URL to itself (a rename back) is dropped. A publish carrying an address
 * change appends here rather than committing on its own, so the entry and the redirect for it
 * land in one commit.
 *
 * `undefined` when there is nothing to write: no file, and nothing to add to one.
 */
export async function appendRedirects(
  siteId: string,
  git: Pick<GitClient, 'getFile'>,
  added: readonly RedirectRule[],
  /** The commit this is going into, which is the one its existing rules are read from. */
  at: string,
  /** A rule this commit takes back out — an entry it puts back on the site. */
  drop?: (rule: RedirectRule) => boolean,
): Promise<PublishFile | undefined> {
  const file = await git.getFile(REDIRECTS, at);
  if (!file && !added.length) return undefined;
  const doc = (file ? parseEntry(siteId, file.contents) : { _version: 1 }) as {
    rules?: RedirectRule[];
  };
  let rules = (doc.rules ?? []).filter((r) => !drop?.(r));
  for (const rule of added)
    rules = [...rules, rule]
      .map((r) => (r !== rule && r.to === rule.from ? { ...r, to: rule.to, entry: rule.entry } : r))
      .filter((r) => r.from !== r.to);
  return { path: REDIRECTS, contents: stringifyEntry(siteId, { ...doc, rules }) };
}

/**
 * `redirects.yaml` with the rules one commit added taken back out. It is **recomputed, not
 * restored**: rules appended since that commit have to stay, so this is the file as HEAD has it
 * minus the ids that commit introduced. A `to` the commit rewrote on an older rule stays
 * rewritten — that URL is the live one, and putting the old one back would send visitors to a
 * page that has moved on. `undefined` when the commit added no rule, which is most of them.
 */
export async function revertRedirects(
  siteId: string,
  git: Pick<GitClient, 'getFile'>,
  at: { commit: string; parent: string; head: string },
): Promise<PublishFile | undefined> {
  const doc = async (ref: string) => {
    const file = await git.getFile(REDIRECTS, ref);
    return file ? (parseEntry(siteId, file.contents) as { rules?: RedirectRule[] }) : undefined;
  };
  const [before, after, head] = await Promise.all([doc(at.parent), doc(at.commit), doc(at.head)]);
  const was = new Set((before?.rules ?? []).map((r) => r._id));
  const added = new Set((after?.rules ?? []).flatMap((r) => (was.has(r._id) ? [] : [r._id])));
  if (!added.size || !head) return undefined;
  return {
    path: REDIRECTS,
    contents: stringifyEntry(siteId, {
      ...head,
      rules: (head.rules ?? []).filter((r) => !added.has(r._id)),
    }),
  };
}

const redirectsFile = async (
  siteId: string,
  git: GitClient,
  rules: Omit<RedirectRule, '_id' | 'createdAt'>[],
  now: () => number,
  at: string,
): Promise<PublishFile[]> => {
  const file = await appendRedirects(
    siteId,
    git,
    rules.map((rule) => redirectRule(siteId, rule, now())),
    at,
  );
  return file ? [file] : [];
};

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
  const base_sha = await git.getHead();
  const files = await localeFiles(git, loc, from, base_sha);
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
  if (rules.length)
    changes.push(...(await redirectsFile(siteId, git, rules, deps.now ?? Date.now, base_sha)));
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
  const base_sha = await git.getHead();
  const files = await localeFiles(git, loc, name, base_sha);
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
  if (rules.length)
    changes.push(...(await redirectsFile(siteId, git, rules, deps.now ?? Date.now, base_sha)));
  return git.publish(changes, { base_sha, message: `Delete ${loc.collection}/${name}` });
}

/**
 * One language's file removed from an entry that keeps its others: not a delete of the entry but
 * of one file of it, so the languages it is still offered in are written into the files that
 * stay and each language that went sends its readers to the collection's index under its own
 * segment. One commit, the way a delete makes one.
 *
 * The caller has already refused the last language an entry has a file in: with nothing left
 * this would be a delete of the entry, and that asks where its readers go for all of it at once.
 */
export async function deleteLocales(
  siteId: string,
  git: GitClient,
  loc: EntryLocation,
  name: string,
  going: string[],
  offered: string[],
  redirectTo: string | undefined,
  deps: { now?: () => number } = {},
): Promise<{ commit_sha: string; kept: ContentFile[] }> {
  const base_sha = await git.getHead();
  const files = await localeFiles(git, loc, name, base_sha);
  const gone = files.filter((file) => going.includes(file.locale));
  const kept = files
    .filter((file) => !going.includes(file.locale))
    .map(({ locale, contents }) => ({
      path: entryPath(loc.collection, locale, name),
      contents: stringifyEntry(
        siteId,
        offeredEntry(siteId, parseEntry(siteId, contents), {
          offered,
          locales: loc.i18n.locales,
          gone: going,
        }),
      ),
    }));
  const changes: PublishFile[] = [
    ...gone.map(({ locale }) => ({
      path: entryPath(loc.collection, locale, name),
      contents: null,
    })),
    ...kept,
  ];
  const rules = !redirectTo
    ? []
    : gone.flatMap((file) => {
        const was = urlOf(siteId, loc, file, name);
        const to = entryUrl(siteId, loc.i18n, redirectTo, '', file.locale);
        return was && to && was !== to
          ? [{ from: was, to, status: 301 as const, reason: 'deleted' as const }]
          : [];
      });
  if (rules.length)
    changes.push(...(await redirectsFile(siteId, git, rules, deps.now ?? Date.now, base_sha)));
  const { commit_sha } = await git.publish(changes, {
    base_sha,
    message: `Turn off ${going.join(', ')} for ${loc.collection}/${name}`,
  });
  return { commit_sha, kept };
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
  // One commit for the whole entry, the way a rename reads it: a copy made of an English from
  // one commit and a German from another is an entry whose languages never agreed.
  const files = await localeFiles(git, loc, from, await git.getHead());
  const ids = new Map<string, string>();
  return files.map(({ locale, contents }) => {
    const copy = writtenEntry(siteId, regenerateIds(siteId, parseEntry(siteId, contents), ids));
    if (loc.localizedSlugs) delete copy.slug;
    return { path: entryPath(loc.collection, locale, to), contents: stringifyEntry(siteId, copy) };
  });
}
