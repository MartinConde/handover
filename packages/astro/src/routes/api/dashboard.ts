import config from 'virtual:handover/config';
import index, { stale, texts } from 'virtual:handover/index';
import type { EntryEdit, Labels } from '@handover/core';
import {
  collectionEntries,
  draftEditors,
  entryKey,
  entryOffer,
  entryUrl,
  heldDrafts,
  humanise,
  indexName,
  labelsOf,
  lastCommit,
  lockHolders,
  overlayRows,
  pendingDrafts,
  publishedEntries,
  textSummaries,
} from '@handover/core';
import { entryForm } from '../../index.js';
import { ENTRY_FILE, entryHref, globalLabel, pickable } from './content.js';
import type { RequestContext } from './context.js';
import { templateNames } from './entries.js';

// Nothing here touches GitHub: listing through the contents API is one request per file.
export async function listEntries(ctx: RequestContext, collection: string): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const database = ctx.db();
  const [rows, waiting, editing, published, editors] = await Promise.all([
    overlayRows('default', database, index),
    pendingDrafts('default', database),
    lockHolders('default', database),
    publishedEntries('default', database),
    draftEditors('default', database),
  ]);
  // Says which rows get the "duplicate including unpublished changes?" question.
  const unpublished = new Set(waiting.map((row) => row.path));
  const edits = lastEdits(waiting, published, editors);
  const summaries = textsNow(rows, collection);
  // The same reading of `_locales` the editor makes, so list and form agree on chips.
  const entries = collectionEntries('default', index, collection, rows, collected.titleField).map(
    (entry) => {
      const { offered } = entryOffer(
        'default',
        config.i18n.locales,
        entry.offered,
        Object.keys(entry.locales),
      );
      // Absent when that is every language the site declares, as the built index has it.
      return {
        ...entry,
        offered: offered.length === config.i18n.locales.length ? undefined : offered,
        pending: Object.values(entry.locales).some((l) => unpublished.has(l.path)) || undefined,
        editing: editing[`${collection}/${entry.id}`],
        // Goes as far back as the log does; an untouched row has nothing rather than a guess.
        edited: edits.get(`${collection}/${entry.id}`) ?? null,
        // The last build's mark, the same one the dashboard counts, for the language filter.
        stale: stale[`${collection}/${entry.id}`]?.length
          ? stale[`${collection}/${entry.id}`]
          : undefined,
        ...summaries[`${collection}/${entry.id}`],
      };
    },
  );
  return Response.json({
    entries,
    // Which languages the list draws a column for, and in which order — one language, no column.
    locales: config.i18n.locales,
    // The language a new entry is written in unless the dialog is pointed at another.
    defaultLocale: config.i18n.defaultLocale,
    // The page above them, which is where the hide dialog offers to send a row's readers.
    index: collected.index,
    // The starters this collection ships, which the New entry dialog offers beside Blank.
    templates: await templateNames(collection, database),
  });
}

/** The build's counts with the drafts over them, read the same way by list and dashboard. */
function textsNow(overlay: readonly { path: string; contents: string }[], collection?: string) {
  // A list parses only its own drafts; the dashboard needs every entry, globals too.
  const within = (key = '') => !collection || key.startsWith(`${collection}/`);
  return textSummaries(
    'default',
    config.i18n,
    Object.fromEntries(Object.entries(texts).filter(([key]) => within(key))),
    overlay.filter((row) => within(entryKey(row.path))),
    (of, name) => entryForm(config, of, name),
  );
}

/** A global's label in every language, for the rows that name it; nothing for an entry. */
const globalLabels = (key: string) => {
  const [collection, name = ''] = key.split('/');
  const schema = collection === 'globals' ? config.globals?.[name] : undefined;
  const labels = schema && globalLabel(name, schema).labels;
  return labels ? { labels } : {};
};

/** One answer for every picker: they choose from the same set and differ only afterwards. */
export async function pickList(ctx: RequestContext): Promise<Response> {
  return Response.json({
    entries: await pickable(ctx),
    // A collection's index page is not an entry, but a menu can point at one.
    indexes: Object.entries(config.collections).flatMap(([collection, { index: page }]) => {
      if (!page) return [];
      const { label } = config.collections[collection] ?? {};
      const labels = typeof label === 'string' && label ? { en: label } : labelsOf(label);
      const urls: Record<string, string> = {};
      for (const locale of config.i18n.locales) {
        const url = entryUrl('default', config.i18n, page, '', locale);
        if (url) urls[locale] = url;
      }
      return [
        {
          collection,
          index: true,
          path: collection,
          // What a menu item pointing here is called on the site; `labels` is the admin's name.
          title: humanise(collection),
          titles: Object.fromEntries(
            config.i18n.locales.map((locale) => [locale, indexName(collection, label, locale)]),
          ),
          ...(labels
            ? {
                // Written as it reads mid-sentence; a picker row is a heading.
                labels: Object.fromEntries(
                  Object.entries(labels).map(([locale, text]) => [
                    locale,
                    text.charAt(0).toUpperCase() + text.slice(1),
                  ]),
                ),
              }
            : {}),
          locales: config.i18n.locales,
          urls,
        },
      ];
    }),
    locales: config.i18n.locales,
    // A typed path's language is read off its segment, and the default one has none.
    defaultLocale: config.i18n.defaultLocale,
  });
}

/** Costs what the entry list costs: a global is an entry of the `globals` collection. */
export async function globalsList(ctx: RequestContext): Promise<Response> {
  const database = ctx.db();
  const [rows, waiting, editing, published, editors] = await Promise.all([
    overlayRows('default', database, index),
    pendingDrafts('default', database),
    lockHolders('default', database),
    publishedEntries('default', database),
    draftEditors('default', database),
  ]);
  const pending = new Set(waiting.map((row) => row.path));
  const edits = lastEdits(waiting, published, editors);
  const entries = collectionEntries('default', index, 'globals', rows);
  return Response.json({
    globals: Object.entries(config.globals ?? {}).map(([key, schema]) => {
      const found = entries.find((entry) => entry.id === key);
      const locales = Object.entries(found?.locales ?? {});
      return {
        ...globalLabel(key, schema),
        // Languages with a file; the rest become the dashed chip that offers to make one.
        locales: config.i18n.locales.filter((locale) => found?.locales[locale]),
        pending: locales.some(([, file]) => pending.has(file.path)),
        editing: editing[`globals/${key}`],
        // Goes as far back as the log does; an untouched row has nothing rather than a guess.
        edited: edits.get(`globals/${key}`) ?? null,
      };
    }),
    locales: config.i18n.locales,
  });
}

/** When an entry was last touched, by whom, and whether that edit is out on the site yet. */
interface LastEdit {
  key: string;
  at: number;
  /** Their name, or nothing: a member who has gone leaves the date standing on its own. */
  by: string | null;
  /** An unpublished edit, or the publish that carried one out. */
  kind: 'edit' | 'publish';
}

/** The draft row wins; a draft is deleted once its build is live, so the log is the fallback. */
function lastEdits(
  drafts: readonly { path: string; updatedAt: number }[],
  published: readonly EntryEdit[],
  editors: Record<string, string | null>,
): Map<string, LastEdit> {
  const rows = new Map<string, LastEdit>();
  // Already newest first, so the first row an entry has is the one kept.
  for (const draft of drafts) {
    const key = entryKey(draft.path);
    if (!key || rows.has(key)) continue;
    rows.set(key, { key, at: draft.updatedAt, by: editors[draft.path] ?? null, kind: 'edit' });
  }
  for (const done of published)
    if (!rows.has(done.entry))
      rows.set(done.entry, { key: done.entry, at: done.at, by: done.by, kind: 'publish' });
  return rows;
}

/** The unpublished count and build pill stay the shell's, or the two would disagree. */
export async function dashboard(ctx: RequestContext): Promise<Response> {
  const database = ctx.db();
  const [drafts, published, editing, editors, overlay, last] = await Promise.all([
    pendingDrafts('default', database),
    publishedEntries('default', database),
    lockHolders('default', database),
    draftEditors('default', database),
    overlayRows('default', database, index),
    lastCommit('default', database),
  ]);
  const newest = [...lastEdits(drafts, published, editors).values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, 8);
  const titles = entryTitles(
    newest.map((row) => row.key),
    overlay,
  );
  const recent = newest.map((row) => {
    const [collection = '', slug = ''] = row.key.split('/');
    return {
      ...row,
      collection,
      title: titles.get(row.key) || slug,
      ...globalLabels(row.key),
      href: entryHref(row.key),
      editing: editing[row.key],
    };
  });
  return Response.json({
    recent,
    // Only when the newest commit is a publish: a rename or redirect is a commit too.
    published: last?.kind === 'publish' ? { at: last.at, by: last.by } : null,
    translations: translationHealth(overlay),
  });
}

/** Stale is the last build's: judging it with drafts would cost a fetch per entry. */
function translationHealth(overlay: readonly { path: string; contents: string }[]) {
  const locales = config.i18n.locales;
  if (locales.length < 2) return null;
  const missing: Record<string, number> = {};
  const behind: Record<string, number> = {};
  const unfinished: Record<string, number> = {};
  const machine: Record<string, number> = {};
  // Drafts included, unlike `behind`; an entry can count in both.
  const summaries = textsNow(overlay);
  for (const summary of Object.values(summaries)) {
    for (const locale of Object.keys(summary.partial ?? {}))
      unfinished[locale] = (unfinished[locale] ?? 0) + 1;
    for (const locale of summary.machine ?? []) machine[locale] = (machine[locale] ?? 0) + 1;
  }
  // Which lists to send somebody to: a global has none, so it counts and is not named.
  const where: Record<string, Set<string>> = {};
  const owed = (locale: string, collection: string) => {
    if (collection === 'globals') return;
    where[locale] ??= new Set();
    where[locale].add(collection);
  };
  for (const collection of [...Object.keys(config.collections), 'globals'])
    for (const entry of collectionEntries(
      'default',
      index,
      collection,
      overlay,
      config.collections[collection]?.titleField,
    )) {
      const { offered } = entryOffer('default', locales, entry.offered, Object.keys(entry.locales));
      // A language the entry is not offered in is a decision somebody made, not a gap to fill.
      for (const locale of offered)
        if (!entry.locales[locale]) {
          missing[locale] = (missing[locale] ?? 0) + 1;
          owed(locale, collection);
        }
      for (const locale of stale[`${collection}/${entry.id}`] ?? [])
        if (entry.locales[locale]) {
          behind[locale] = (behind[locale] ?? 0) + 1;
          owed(locale, collection);
        }
      // Machine-written is not owed, so it sends *Show* nowhere.
      for (const locale of Object.keys(summaries[`${collection}/${entry.id}`]?.partial ?? {}))
        owed(locale, collection);
    }
  return {
    defaultLocale: config.i18n.defaultLocale,
    locales: locales.map((locale) => ({
      locale,
      missing: missing[locale] ?? 0,
      stale: behind[locale] ?? 0,
      unfinished: unfinished[locale] ?? 0,
      machine: machine[locale] ?? 0,
      where: [...(where[locale] ?? [])],
    })),
  };
}

/** The entry list's own reading, so one entry is named the same thing on every screen. */
export function entryTitles(
  keys: Iterable<string>,
  overlay: readonly { path: string; contents: string }[],
) {
  const titles = new Map<string, string>();
  for (const collection of new Set([...keys].map((key) => key.split('/')[0] ?? '')))
    for (const entry of collectionEntries(
      'default',
      index,
      collection,
      overlay,
      config.collections[collection]?.titleField,
    ))
      titles.set(
        `${collection}/${entry.id}`,
        config.i18n.locales.map((l) => entry.locales[l]?.title).find(Boolean) ||
          Object.values(entry.locales)[0]?.title ||
          entry.id,
      );
  for (const [key, schema] of Object.entries(config.globals ?? {}))
    titles.set(`globals/${key}`, globalLabel(key, schema).label);
  return titles;
}

/** Grouped here because titles come from the build index only the Worker can read. */
export async function pendingList(ctx: RequestContext): Promise<Response> {
  const database = ctx.db();
  const [rows, held, overlay] = await Promise.all([
    pendingDrafts('default', database),
    heldDrafts('default', database),
    overlayRows('default', database, index),
  ]);
  const titles = entryTitles(
    rows.flatMap((r) => entryKey(r.path) ?? []),
    overlay,
  );
  type Row = {
    key: string;
    title: string;
    labels?: Labels;
    collection: string;
    locales: string[];
    files: string[];
    redirects?: number;
    updated_at: number;
    held_by: { id: string; name: string | null; since: number | null } | null;
  };
  const entries: Row[] = [];
  // Newest first, and the row that made an entry appear is the newest it has.
  for (const row of rows) {
    const [, collection = '', locale = '', slug = ''] = ENTRY_FILE.exec(row.path) ?? [];
    const key = entryKey(row.path) ?? row.path;
    let found = entries.find((e) => e.key === key);
    if (!found) {
      found = {
        key,
        title: titles.get(key) || slug || key,
        ...globalLabels(key),
        collection,
        locales: [],
        files: [],
        updated_at: row.updatedAt,
        held_by: held[key] ?? null,
      };
      entries.push(found);
    }
    found.files.push(row.path);
    if (locale) found.locales.push(locale);
    // redirects.yaml is assembled at publish from the entries' rules, so it is never a row here.
    const rules = row.pendingRedirects?.length ?? 0;
    if (rules) found.redirects = (found.redirects ?? 0) + rules;
  }
  for (const entry of entries)
    entry.locales = config.i18n.locales.filter((l) => entry.locales.includes(l));
  // For the drawer's check lines: a problem found in several languages opens the default one.
  return Response.json({ entries, defaultLocale: config.i18n.defaultLocale });
}
