import { offeredEntry, parseEntry, stringifyEntry, writtenEntry } from './content.js';
import type { ContentFile } from './entries.js';
import type { GitClient, PublishFile } from './git.js';
import { entryAddress, entryUrl, type I18nRouting, withSlash } from './names.js';
import { newId, regenerateIds } from './reserved.js';

export interface RedirectRule {
  _id: string;
  from: string;
  to: string;
  /** Moved for good, or only for now: the one thing a manual rule asks the client. */
  status: 301 | 302;
  reason: 'slug-change' | 'hidden' | 'deleted' | 'manual';
  entry?: string;
  createdAt: string;
  /** Where this pointed before a hide re-pointed it at the hidden page's target; put back on unhide. */
  was?: string;
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
async function localeFiles(
  git: GitClient,
  loc: EntryLocation,
  name: string,
  at: string,
  // What the caller has that the commit does not: a duplicate can be asked for the unpublished
  // bytes instead, language by language.
  drafted: Record<string, string> = {},
) {
  const found: { locale: string; contents: string }[] = [];
  for (const locale of loc.i18n.locales) {
    const contents =
      drafted[locale] ?? (await git.getFile(entryPath(loc.collection, locale, name), at))?.contents;
    if (contents) found.push({ locale, contents });
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
 * `drop` names the hide rules of an entry going back on the site. A rule those hides had
 * re-pointed goes back where it pointed: the page answers at its own address again.
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
  const had = doc.rules ?? [];
  const back = new Set(had.filter((r) => drop?.(r)).map((r) => r.entry));
  const kept = had.flatMap((r) => {
    if (drop?.(r)) return [];
    if (r.was === undefined || r.entry === undefined || !back.has(r.entry)) return [r];
    const { was, ...rest } = r;
    return [{ ...rest, to: was }];
  });
  const rules = collapseRedirects(kept, added);
  return { path: REDIRECTS, contents: stringifyEntry(siteId, { ...doc, rules }) };
}

/**
 * These rules written into those: a rule already in the file (an edit) is replaced where it
 * stands, any other is appended. Either way a visitor never hops twice — an existing rule that
 * led to the written one's `from` now leads where it leads, the written one lands wherever its
 * own `to` already forwards (following a hand-written chain to its end, never round a loop), and
 * a rule that would then send a URL to itself — a rename back — is dropped. The entry a
 * re-pointed rule belongs to stays its own where the new rule names none: a rule the client
 * added by hand is nobody's, and losing that link would leave a hidden entry's rule behind when
 * the entry is put back. A hide is the one kind that is undone, so a rule it re-points
 * remembers where it pointed.
 */
export function collapseRedirects(
  rules: readonly RedirectRule[],
  written: readonly RedirectRule[],
): RedirectRule[] {
  let all = [...rules];
  for (const rule of written) {
    const list = all.some((r) => r._id === rule._id) ? all : [...all, rule];
    // The rules that led to this one's `from` are about to follow it, so they are no step
    // onward from it; without that, `A → B` written over `B → A` would chase its own tail.
    const onward = list.filter((r) => r._id !== rule._id && r.to !== rule.from);
    const seen = new Set([rule.from]);
    let to = rule.to;
    for (let next = onward.find((r) => r.from === to); next && !seen.has(next.to); ) {
      seen.add(to);
      to = next.to;
      next = onward.find((r) => r.from === to);
    }
    const landed = { ...rule, to };
    all = list
      .map((r) =>
        r._id === rule._id
          ? landed
          : r.to === rule.from
            ? {
                ...r,
                to,
                entry: rule.entry ?? r.entry,
                ...(rule.reason === 'hidden' ? { was: r.to } : {}),
              }
            : r,
      )
      .filter((r) => r.from !== r.to);
  }
  return all;
}

/** The rules `redirects.yaml` holds, or none where the site has never written one. */
export async function readRedirects(
  siteId: string,
  git: Pick<GitClient, 'getFile'>,
  at?: string,
): Promise<RedirectRule[]> {
  const file = await git.getFile(REDIRECTS, at);
  if (!file) return [];
  return ((parseEntry(siteId, file.contents) as { rules?: RedirectRule[] }).rules ?? []).slice();
}

/**
 * One commit that is nothing but `redirects.yaml`: the rules the client adds, changes and takes
 * out by hand. It commits on its own rather than waiting in the drawer, the way a rename and a
 * delete do — the file never gets a draft row of its own, so there is nowhere for an ownerless
 * rule to wait ([drafts-and-publishing.md](../../../docs/features/drafts-and-publishing.md)).
 */
export async function editRedirects(
  siteId: string,
  git: GitClient,
  message: string,
  change: (rules: RedirectRule[]) => RedirectRule[],
): Promise<{ commit_sha: string }> {
  const base_sha = await git.getHead();
  const file = await git.getFile(REDIRECTS, base_sha);
  const doc = (file ? parseEntry(siteId, file.contents) : { _version: 1 }) as {
    rules?: RedirectRule[];
  };
  const contents = stringifyEntry(siteId, { ...doc, rules: change(doc.rules ?? []) });
  return git.publish([{ path: REDIRECTS, contents }], { base_sha, message });
}

/** Every page the site serves now, by the URL it answers at, so a `from` can be told it shadows one. */
export interface RedirectSite {
  pages: Record<string, string>;
  rules: readonly RedirectRule[];
}

/**
 * Why this rule cannot be written, said as the consequence rather than the rule — a client who
 * is told "invalid path" learns nothing, and the one refusal that matters is the second: a
 * redirect over a page that exists takes that page off the site, and nobody diagnoses that from
 * a 404. `field` is the box the sentence belongs under.
 */
export function redirectError(
  _siteId: string,
  rule: { from: string; to: string },
  site: RedirectSite,
  /** The rule being changed, whose own `from` is not a clash with itself. */
  id?: string,
): { field: 'from' | 'to'; message: string } | undefined {
  const from = rule.from.trim();
  const to = rule.to.trim();
  const at = (field: 'from' | 'to', message: string) => ({ field, message });
  if (!from) return at('from', 'An old address is needed.');
  if (/^[a-z][a-z0-9+.-]*:/i.test(from))
    return at(
      'from',
      'An old address is a path on this site, like "/summer-offer", not a full web address.',
    );
  if (!from.startsWith('/'))
    return at('from', `An address has to start with "/" — did you mean "/${from}"?`);
  if (!to) return at('to', 'A destination is needed.');
  if (!/^(\/|https?:\/\/)/.test(to))
    return at(
      'to',
      `A destination is a path on this site or a full web address — did you mean "/${to.replace(/^\/+/, '')}"?`,
    );
  if (from === to)
    return at('to', 'This sends visitors back where they came from. Pick somewhere else.');
  const page = site.pages[from];
  if (page)
    return at('from', `This is a real page. A redirect here would hide ${page} from visitors.`);
  if (site.rules.some((r) => r.from === from && r._id !== id))
    return at('from', 'There is already a redirect from this address.');
  return undefined;
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

/**
 * The name an entry had before the rename commit this message is of; nothing where it is not
 * one. A history that reaches the commit that started a file's log has reached the rename that
 * made it, and this is what lets it carry on under the old name without `--follow`.
 */
export function renamedFrom(
  _siteId: string,
  message: string,
  collection: string,
  name: string,
): string | undefined {
  const found = /^Rename ([\w-]+)\/([\w-]+) to ([\w-]+)$/.exec(message.split('\n')[0] ?? '');
  return found && found[1] === collection && found[3] === name ? found[2] : undefined;
}

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
 * `redirectTo` answers, for one language, where the client's choice in the dialog sends that
 * language's readers; `undefined` — for a language or for all of them — means "nowhere". It is
 * asked per language rather than given as one route, because a German page that goes away
 * sends its visitors to the German page that was picked and not to an English one they cannot
 * read, and a language the choice resolves to nothing in owes no rule at all.
 */
export async function deleteEntry(
  siteId: string,
  git: GitClient,
  loc: EntryLocation,
  name: string,
  redirectTo: ((locale: string) => string | undefined) | undefined,
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
        const to = redirectTo(file.locale);
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
  redirectTo: ((locale: string) => string | undefined) | undefined,
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
        const to = redirectTo(file.locale);
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

/**
 * The `_redirects` format Workers Static Assets serves: `/from /to status` per line. The asset
 * server matches `from` exactly and a visitor arrives with whichever form the page had when
 * they bookmarked it, so every `from` is written with the trailing slash and without; `to` is
 * written the way the site's pages answer (`slash`), so they land in one hop.
 */
export const redirectsText = (_siteId: string, rules: RedirectRule[], slash: boolean): string =>
  rules
    .flatMap((r) => {
      const to = withSlash(r.to, slash);
      const forms = new Set([withSlash(r.from, false), withSlash(r.from, true)]);
      return [...forms].map((from) => `${from} ${to} ${r.status}\n`);
    })
    .join('');

/**
 * Every locale file of an entry copied under a new name, ready to be written as drafts: one
 * `_id` map shared across the locales, so the copy is still one entry with a matching
 * skeleton. Session 2.9 (decap-cms#7371, payload#14491).
 *
 * The address stays with the entry that had it — two entries answering to one URL is what the
 * address route refuses — so the copy falls back to its new file name until somebody gives it
 * one of its own. `drafted` is the answer to "duplicate including unpublished changes?": the
 * languages it names are copied from those bytes instead of from the commit.
 */
export async function duplicateEntry(
  siteId: string,
  git: GitClient,
  loc: EntryLocation,
  from: string,
  to: string,
  drafted: Record<string, string> = {},
): Promise<ContentFile[]> {
  // One commit for the whole entry, the way a rename reads it: a copy made of an English from
  // one commit and a German from another is an entry whose languages never agreed.
  const files = await localeFiles(git, loc, from, await git.getHead(), drafted);
  const ids = new Map<string, string>();
  return files.map(({ locale, contents }) => {
    const copy = writtenEntry(siteId, regenerateIds(siteId, parseEntry(siteId, contents), ids));
    if (loc.localizedSlugs) delete copy.slug;
    return { path: entryPath(loc.collection, locale, to), contents: stringifyEntry(siteId, copy) };
  });
}
