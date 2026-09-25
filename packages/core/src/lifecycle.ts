import type { ContentFile } from './entries.js';
import { offeredEntry, parseEntry, stringifyEntry, writtenEntry } from './entry-format.js';
import type { GitClient, PublishFile } from './git.js';
import { entryAddress, entryUrl, type I18nRouting } from './names.js';
import { operationMessage } from './operations.js';
import { appendRedirects, type RedirectRule, redirectRule } from './redirects.js';
import { regenerateIds } from './reserved.js';

export interface EntryLocation {
  collection: string;
  /** The collection's `route`; without one the entry has no URL and no redirect is written. */
  route?: string;
  /** The site's languages, and what a URL under each of them looks like. */
  i18n: I18nRouting;
  /** Whether the collection's files carry an address of their own, which is not the file name. */
  localizedSlugs?: boolean;
}

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
  deps: { now?: () => number; baseSha?: string; operationId?: string } = {},
): Promise<{ commit_sha: string; files: { locale: string; contents: string }[] }> {
  const base_sha = deps.baseSha ?? (await git.getHead());
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
  const published = await git.publish(changes, {
    base_sha,
    message: deps.operationId
      ? operationMessage(`Rename ${loc.collection}/${from} to ${to}`, deps.operationId)
      : `Rename ${loc.collection}/${from} to ${to}`,
  });
  return { ...published, files };
}

/** `redirectTo` is asked per language so German readers land on a German page, or nowhere. */
export async function deleteEntry(
  siteId: string,
  git: GitClient,
  loc: EntryLocation,
  name: string,
  redirectTo: ((locale: string) => string | undefined) | undefined,
  deps: { now?: () => number; baseSha?: string; operationId?: string } = {},
): Promise<{ commit_sha: string }> {
  const base_sha = deps.baseSha ?? (await git.getHead());
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
  const message = `Delete ${loc.collection}/${name}`;
  return git.publish(changes, {
    base_sha,
    message: deps.operationId ? operationMessage(message, deps.operationId) : message,
  });
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
  deps: { now?: () => number; baseSha?: string; operationId?: string; source?: string } = {},
): Promise<{ commit_sha: string; kept: ContentFile[] }> {
  const base_sha = deps.baseSha ?? (await git.getHead());
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
          source: deps.source,
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
    message: deps.operationId
      ? operationMessage(
          `Turn off ${going.join(', ')} for ${loc.collection}/${name}`,
          deps.operationId,
        )
      : `Turn off ${going.join(', ')} for ${loc.collection}/${name}`,
  });
  return { commit_sha, kept };
}

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
