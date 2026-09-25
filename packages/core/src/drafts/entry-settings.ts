import { entryKey } from '../content/entries.js';
import { offeredEntry, stringifyEntry, withSource, writtenEntry } from '../content/entry-format.js';
import { redirectRule } from '../content/redirects.js';
import type { Form } from '../content/schema.js';
import { batchAll, type Db } from '../db.js';
import { blobSha, type GitClient } from '../publishing/git.js';
import { load, stampOf, upsert } from './drafts.js';

/** In the files, since the site builds from git alone; offered everywhere means no mark at all. */
export async function setEntryLocales(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  paths: string[],
  offered: string[],
  locales: string[],
  source?: string,
): Promise<void> {
  const found = await Promise.all(
    paths.map(async (path) => {
      const loaded = await load(siteId, db, git, path);
      return loaded && { path, loaded };
    }),
  );
  const updatedAt = Date.now();
  const writes = found.flatMap((f) => {
    if (!f) return [];
    const contents = stringifyEntry(
      siteId,
      offeredEntry(siteId, f.loaded.entry, { offered, locales, source }),
    );
    return contents === stringifyEntry(siteId, writtenEntry(siteId, f.loaded.entry))
      ? []
      : [upsert(db, siteId, f.path, contents, f.loaded, updatedAt)];
  });
  await batchAll(db, writes);
}

/** The redirect is stored on the row, not committed: the old address is live until publish. */
export async function setEntryAddress(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  form: Form,
  path: string,
  address: string,
  redirect?: { from: string; to: string; entry: string },
  by?: string,
): Promise<{ updated_at: number; pending: boolean } | undefined> {
  const loaded = await load(siteId, db, git, path);
  if (!loaded) return undefined;
  const entry = { ...(loaded.entry as Record<string, unknown>) };
  if (address) entry.slug = address;
  else delete entry.slug;
  // `slug` is a key the schema declares, so it goes where the form says.
  const contents = stringifyEntry(siteId, writtenEntry(siteId, entry, form.fields));
  const updatedAt = Date.now();
  const rule = redirect
    ? redirectRule(
        siteId,
        {
          from: redirect.from,
          to: redirect.to,
          status: 301,
          reason: 'slug-change',
          entry: redirect.entry,
        },
        updatedAt,
      )
    : undefined;
  const rules = loaded.redirects.filter((r) => r.reason !== 'slug-change');
  if (rule) rules.push(rule);
  await db.batch([
    upsert(db, siteId, path, contents, loaded, updatedAt, {
      pendingRedirects: rules.length ? rules : null,
      ...stampOf(by),
    }),
  ]);
  return { updated_at: updatedAt, pending: (await blobSha(contents)) !== loaded.baseBlob };
}

/** Hide redirects are stored on the rows, not committed: the page is live until publish. */
export async function setEntryStatus(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  form: Form,
  files: readonly { path: string; redirect?: { from: string; to: string } }[],
  hidden: boolean,
  deps: { now?: () => number } = {},
): Promise<void> {
  const found = await Promise.all(
    files.map(async (file) => {
      const loaded = await load(siteId, db, git, file.path);
      return loaded && { ...file, loaded };
    }),
  );
  const updatedAt = deps.now?.() ?? Date.now();
  const writes = found.flatMap((file) => {
    if (!file) return [];
    const entry = { ...(file.loaded.entry as Record<string, unknown>) };
    if (hidden) entry._status = 'hidden';
    else delete entry._status;
    const rules = file.loaded.redirects.filter((rule) => rule.reason !== 'hidden');
    if (hidden && file.redirect)
      rules.push(
        redirectRule(
          siteId,
          {
            ...file.redirect,
            status: 301,
            reason: 'hidden',
            entry: entryKey(file.path),
          },
          updatedAt,
        ),
      );
    return [
      upsert(
        db,
        siteId,
        file.path,
        stringifyEntry(siteId, writtenEntry(siteId, entry, form.fields)),
        file.loaded,
        updatedAt,
        { pendingRedirects: rules.length ? rules : null },
      ),
    ];
  });
  await batchAll(db, writes);
}

/** Each of these is owned by an action of its own, never by a version of the words. */
const KEPT_ON_RESTORE = ['slug', '_status', '_locales', '_source'] as const;

// A key assigned in place lands after the other `_` keys; `_source` sits right after `_version`.
export const keptSource = (siteId: string, entry: Record<string, unknown>) =>
  typeof entry._source === 'string' ? withSource(siteId, entry, entry._source) : entry;

/** The base stays where it was, so the publish that follows is an ordinary forward commit. */
export async function restoreDraft(
  siteId: string,
  db: Db,
  git: Pick<GitClient, 'getFile' | 'getHead'>,
  form: Form,
  files: readonly { path: string; entry: Record<string, unknown> }[],
  by?: string,
): Promise<{ paths: string[] }> {
  const found = await Promise.all(
    files.map(async (file) => {
      const loaded = await load(siteId, db, git, file.path);
      return loaded && { ...file, loaded };
    }),
  );
  const updatedAt = Date.now();
  const writes = found.flatMap((file) => {
    if (!file) return [];
    const now = (file.loaded.entry ?? {}) as Record<string, unknown>;
    // Assigned in place so a key the version also had keeps its position in the file.
    const entry = { ...file.entry };
    for (const key of KEPT_ON_RESTORE) {
      if (key in now) entry[key] = now[key];
      else delete entry[key];
    }
    const contents = stringifyEntry(
      siteId,
      keptSource(siteId, writtenEntry(siteId, entry, form.fields)),
    );
    return [upsert(db, siteId, file.path, contents, file.loaded, updatedAt, stampOf(by))];
  });
  await batchAll(db, writes);
  return { paths: found.filter((f) => f !== undefined).map((f) => f.path) };
}
