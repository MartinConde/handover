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
  /** Where this pointed before a hide re-pointed it; put back on unhide. */
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

// `at` is the caller's base commit: bytes from any other would put somebody else's work back.
async function localeFiles(
  git: GitClient,
  loc: EntryLocation,
  name: string,
  at: string,
  // A duplicate can ask for the unpublished bytes instead, language by language.
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

/** Appends in the same commit as the entry; `undefined` when there is nothing to write. */
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

/** A visitor never hops twice; a hide is undone later, so a rule it re-points remembers `was`. */
export function collapseRedirects(
  rules: readonly RedirectRule[],
  written: readonly RedirectRule[],
): RedirectRule[] {
  let all = [...rules];
  for (const rule of written) {
    const list = all.some((r) => r._id === rule._id) ? all : [...all, rule];
    // Rules leading to this `from` are no step onward, or `A → B` over `B → A` chases its tail.
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

/** Commits on its own: the file never gets a draft row, so a rule has nowhere to wait. */
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

/** Every served page by URL, so a `from` can be told it shadows one. */
export interface RedirectSite {
  pages: Record<string, string>;
  rules: readonly RedirectRule[];
}

/** Said as the consequence: nobody diagnoses a shadowed page from a 404; `field` is its box. */
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

/** A file the revert would write has changed since the commit it is undoing. */
export class RevertConflictError extends Error {
  override name = 'RevertConflictError';
  constructor(readonly paths: string[]) {
    super(
      paths.length === 1
        ? `${paths[0]} has changed since that commit, so it cannot be put back`
        : `${paths.length} files have changed since that commit, so they cannot be put back — ${paths.join(', ')}`,
    );
  }
}

/** Invert only the rules this commit changed; overlapping later edits refuse the whole undo. */
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
  const byId = (rules: readonly RedirectRule[]) => new Map(rules.map((r) => [r._id, r]));
  const was = byId(before?.rules ?? []);
  const wrote = byId(after?.rules ?? []);
  const current = byId(head?.rules ?? []);
  const equal = (a: RedirectRule | undefined, b: RedirectRule | undefined) =>
    JSON.stringify(a && Object.entries(a).sort(([a], [b]) => a.localeCompare(b))) ===
    JSON.stringify(b && Object.entries(b).sort(([a], [b]) => a.localeCompare(b)));
  const changed = [...new Set([...was.keys(), ...wrote.keys()])].filter(
    (id) => !equal(was.get(id), wrote.get(id)),
  );
  if (!changed.length) return undefined;
  for (const id of changed) {
    if (!equal(current.get(id), wrote.get(id))) throw new RevertConflictError([REDIRECTS]);
    const restored = was.get(id);
    // A later rule can claim an address under a different ID too.
    if (
      restored &&
      [...current.values()].some(
        (r) => r._id !== id && !changed.includes(r._id) && r.from === restored.from,
      )
    )
      throw new RevertConflictError([REDIRECTS]);
  }
  for (const id of changed) {
    const restored = was.get(id);
    if (restored) current.set(id, restored);
    else current.delete(id);
  }
  return {
    path: REDIRECTS,
    contents: stringifyEntry(siteId, { ...(head ?? before), rules: [...current.values()] }),
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

/** With `localizedSlugs` each language's URL is read out of that language's own file. */
const urlOf = (
  siteId: string,
  loc: EntryLocation,
  file: { locale: string; contents: string },
  name: string,
) => {
  const data = loc.localizedSlugs ? parseEntry(siteId, file.contents) : undefined;
  return entryUrl(siteId, loc.i18n, loc.route, entryAddress(siteId, data, name), file.locale);
};

/** The old name of a rename commit, so a history can carry on under it without `--follow`. */
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
  const destinations = await Promise.all(
    loc.i18n.locales.map((locale) => git.getFile(entryPath(loc.collection, locale, to), base_sha)),
  );
  if (destinations.some(Boolean)) throw new RenameCollisionError();
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

/** `redirectTo` is asked per language so German readers land on a German page, or nowhere. */
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

/** One commit; the caller has already refused the last language, which would be a delete. */
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

/** Static Assets matches `from` exactly, so each is written with and without a trailing slash. */
export const redirectsText = (_siteId: string, rules: RedirectRule[], slash: boolean): string =>
  rules
    .flatMap((r) => {
      const to = withSlash(r.to, slash);
      const forms = new Set([withSlash(r.from, false), withSlash(r.from, true)]);
      return [...forms].map((from) => `${from} ${to} ${r.status}\n`);
    })
    .join('');

/** One `_id` map across locales keeps the copy one entry; the address stays with the original. */
export async function duplicateEntry(
  siteId: string,
  git: GitClient,
  loc: EntryLocation,
  from: string,
  to: string,
  drafted: Record<string, string> = {},
): Promise<ContentFile[]> {
  // One commit for every language, or the copy's languages never agreed.
  const files = await localeFiles(git, loc, from, await git.getHead(), drafted);
  const ids = new Map<string, string>();
  return files.map(({ locale, contents }) => {
    const copy = writtenEntry(siteId, regenerateIds(siteId, parseEntry(siteId, contents), ids));
    if (loc.localizedSlugs) delete copy.slug;
    return { path: entryPath(loc.collection, locale, to), contents: stringifyEntry(siteId, copy) };
  });
}

export class RenameCollisionError extends Error {
  override name = 'RenameCollisionError';
  constructor() {
    super('The destination already exists in the repository');
  }
}
