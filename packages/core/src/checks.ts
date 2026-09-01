// The lint pass a publish gets before the commit: the things that build fine and look broken
// — a link to a page that is not there, a picture the bucket does not have, a translation
// nobody has read. **Warnings and notes, never a refusal**: the only two things that stop a
// publish are the schema and unresolved drift, exactly as before.

import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { isObject, parseEntry, staleLocales } from './content.js';
import type { Db } from './db.js';
import { type ContentIndex, entryParts, type IndexEntry } from './entries.js';
import type { GitClient } from './git.js';
import { objectExists, type R2Store } from './media.js';
import { type I18nRouting, previewTarget } from './names.js';
import { richtextLinks } from './richtext.js';
import { type Field, type Form, rowFields, type Translation } from './schema.js';
import { resolveSeo, SEO_TITLE_LIMIT, type SeoDefaultsValue, type SeoValue } from './seo.js';
import { activity, media } from './tables.js';

export type CheckSeverity = 'error' | 'warn' | 'info';

/**
 * Every check, by the id `checks.ignore` turns it off with, and what a result of it costs the
 * site: an **error** is a page the visitor sees broken, a **warn** a page that says something
 * nobody meant, an **info** a note worth reading before the words go out.
 */
export const CHECKS = {
  'media-missing': 'error',
  'link-target': 'warn',
  'link-locale': 'warn',
  'media-archived': 'warn',
  'image-alt': 'warn',
  'menu-target': 'warn',
  'translation-empty': 'warn',
  'translation-stale': 'info',
  'translation-machine': 'info',
  'seo-title': 'info',
  'seo-description': 'info',
  'seo-image': 'info',
  'hidden-long': 'info',
} as const satisfies Record<string, CheckSeverity>;

export type CheckName = keyof typeof CHECKS;

export interface CheckResult {
  check: CheckName;
  /** The file it is about; the drawer groups by the entry that file belongs to. */
  path: string;
  /** The field, addressed the way `_machine` addresses one, so *Go to field* survives a move. */
  fieldPath: string;
  severity: CheckSeverity;
  message: string;
}

/** As much of `cms.config.ts` as a check needs: where pages are served and what they are called. */
export interface CheckSite {
  i18n: I18nRouting;
  collections: Record<
    string,
    { route?: string; index?: string; localizedSlugs?: boolean; titleField?: string }
  >;
}

/**
 * One entry as this publish would leave it. Every language it has is here, because a
 * translation cannot be judged stale, or empty where the source has words, against one file
 * — but only the languages actually going out are linted, which is the drawer's own rule
 * about what a publish is answerable for.
 */
export interface CheckEntry {
  /** `listings/mill-house`: collection and file name, the key the drawer lists. */
  key: string;
  form: Form;
  files: Record<string, { path: string; contents: string }>;
  /** The languages this publish commits. The rest are context and are never reported on. */
  publishing: string[];
}

export interface CheckInput {
  entries: CheckEntry[];
  site: CheckSite;
  /** The built content index with the pending drafts laid over it: what a link resolves against. */
  index: ContentIndex;
  /** The site's SEO defaults per language, out of the global that declares them. */
  seoDefaults?: Record<string, SeoDefaultsValue>;
  /** Where the uploads live. Without it a key the table has no row for is taken as missing. */
  store?: R2Store;
  /** The ids this site has turned off: `checks.ignore` in `cms.config.ts`. */
  ignore?: readonly string[];
  /** What the daily job last found hidden for too long: `lastHiddenLong`. */
  hiddenLong?: HiddenLong[];
}

/**
 * The whole lint, in one pass over the drafts. Each file is parsed once and walked once —
 * ten milliseconds of CPU is not enough to parse the same YAML for every rule — and the
 * assets every file names are looked up in one read of the table at the end, with the bucket
 * asked only about the keys that read found nothing for.
 */
export async function runChecks(
  siteId: string,
  db: Db,
  input: CheckInput,
  deps: { fetch?: typeof globalThis.fetch; now?: number } = {},
): Promise<CheckResult[]> {
  const now = deps.now ?? Date.now();
  const found: CheckResult[] = [];
  const assets: { key: string; path: string; fieldPath: string; label: string }[] = [];
  for (const entry of input.entries) {
    const collection = entry.key.slice(0, entry.key.indexOf('/'));
    // A global's key is `globals/navigation`, and `globals` is not one of the site's
    // collections: the miss is the right answer, since a global has no route to be linked at
    // and no title field to be named by.
    const of = input.site.collections[collection] ?? {};
    const parsed: Record<string, unknown> = {};
    for (const locale of entry.publishing) {
      const file = entry.files[locale];
      if (file) parsed[locale] = parseEntry(siteId, file.contents);
    }
    // A language that is not going out is read only where one that is says it was translated
    // from it: that file is what the staleness hash is taken over, and parsing the others is
    // the budget spent on a result nobody would be shown.
    for (const data of Object.values(parsed)) {
      const mark = isObject(data) && isObject(data._i18n) ? data._i18n.sourceLocale : undefined;
      const from = typeof mark === 'string' && !(mark in parsed) ? entry.files[mark] : undefined;
      if (from && typeof mark === 'string') parsed[mark] = parseEntry(siteId, from.contents);
    }
    for (const locale of entry.publishing) {
      const file = entry.files[locale];
      if (!file) continue;
      const data = parsed[locale];
      const title = isObject(data) ? data[of.titleField ?? 'title'] : undefined;
      const walk: Walk = {
        siteId,
        input,
        form: entry.form,
        locale,
        route: of.route,
        title: typeof title === 'string' ? title : entry.key.slice(collection.length + 1),
        say: (check, fieldPath, message) =>
          found.push({ check, path: file.path, fieldPath, severity: CHECKS[check], message }),
        asset: (key, fieldPath, label) => assets.push({ key, path: file.path, fieldPath, label }),
      };
      fieldsIn(walk, entry.form.fields, data, '', true);
      // Which values a machine filled in is the file's own record of itself, so it is read
      // off the file rather than walked for.
      const machine = isObject(data) && Array.isArray(data._machine) ? data._machine : [];
      for (const at of machine as unknown[])
        if (typeof at === 'string')
          walk.say(
            'translation-machine',
            at,
            'Filled in by machine translation and not read by anybody since — it goes to the site as it stands',
          );
    }
    for (const locale of await staleLocales(siteId, entry.form, parsed)) {
      const file = entry.files[locale];
      if (!file || !entry.publishing.includes(locale)) continue;
      found.push({
        check: 'translation-stale',
        path: file.path,
        fieldPath: '',
        severity: CHECKS['translation-stale'],
        message: `This translation was made from an older version of the ${sourceOf(parsed[locale])} — somebody has changed the words it was translated from since`,
      });
    }
  }
  for (const { path, since } of input.hiddenLong ?? []) {
    const parts = entryParts(path);
    const page = parts
      ? input.index[parts.collection]?.find((e) => e.id === parts.name)?.locales[parts.locale]
      : undefined;
    // The index is newer than the job's list: a page shown or deleted since it ran is not one
    // to mention.
    if (page?.status !== 'hidden') continue;
    found.push({
      check: 'hidden-long',
      path,
      fieldPath: '',
      severity: CHECKS['hidden-long'],
      message: `${page.title} has been hidden for over ${Math.floor((now - Date.parse(since)) / (30 * DAY))} months — long enough to decide whether it comes back or goes`,
    });
  }
  found.push(...(await assetResults(siteId, db, input, assets, deps)));
  const ignore = new Set(input.ignore ?? []);
  // Grouped by file, in the order the walk found them: the drawer lists an entry's results
  // under the entry, and a stable order is what makes two runs of the same publish agree.
  return found
    .filter((result) => !ignore.has(result.check))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const DAY = 24 * 60 * 60 * 1000;
const LONG_HIDDEN = 90 * DAY;
// A top-level key, so a `_status` inside a block does not match; quoted or not, as a hand
// writes it or the serialiser does.
const HIDDEN = /^_status:\s*["']?hidden["']?\s*$/m;

/** One file the daily job found hidden for longer than it should be, and the commit date since. */
export interface HiddenLong {
  path: string;
  since: string;
}

/**
 * The daily job behind `hidden-long`: every `_status: hidden` file at the branch tip, dated
 * from its own commits, since nothing else records when a page was hidden. Only the tip's
 * version is known for free; older ones are read back a commit at a time, newest first, and
 * the walk stops at the first version that was not hidden or at the first that is already old
 * enough to settle the question — so `since` is the hide, or an edit already past the limit.
 * The list rides in the job's `cron-hidden` activity row, which is where `lastHiddenLong`
 * reads it back for the drawer.
 */
export async function findHiddenLong(
  _siteId: string,
  git: Pick<GitClient, 'contentFiles' | 'fileCommits' | 'getFile'> | undefined,
  now = Date.now(),
): Promise<{ done: number; entries: HiddenLong[] }> {
  const entries: HiddenLong[] = [];
  if (!git) return { done: 0, entries };
  const files = (await git.contentFiles()).filter(
    (f) => entryParts(f.path) && HIDDEN.test(f.contents),
  );
  for (const { path } of files) {
    let since: string | undefined;
    for (const [i, commit] of (await git.fileCommits(path)).entries()) {
      if (i > 0 && !HIDDEN.test((await git.getFile(path, commit.sha))?.contents ?? '')) break;
      since = commit.date;
      if (now - Date.parse(since) > LONG_HIDDEN) break;
    }
    if (since && now - Date.parse(since) > LONG_HIDDEN) entries.push({ path, since });
  }
  return { done: entries.length, entries };
}

/**
 * The newest list the job wrote within two days. A run that failed left the last answer
 * standing, and a job that has not answered for two days has nothing current to say.
 */
export async function lastHiddenLong(
  siteId: string,
  db: Db,
  now = Date.now(),
): Promise<HiddenLong[]> {
  const rows = await db
    .select({ detail: activity.detail })
    .from(activity)
    .where(
      and(
        eq(activity.siteId, siteId),
        eq(activity.kind, 'cron-hidden'),
        gt(activity.at, now - 2 * DAY),
      ),
    )
    .orderBy(desc(activity.at));
  for (const { detail } of rows) {
    const list = isObject(detail) ? detail.entries : undefined;
    if (Array.isArray(list))
      return list.filter(
        (e): e is HiddenLong =>
          isObject(e) && typeof e.path === 'string' && typeof e.since === 'string',
      );
  }
  return [];
}

const sourceOf = (data: unknown) => {
  const mark = isObject(data) && isObject(data._i18n) ? data._i18n : {};
  return typeof mark.sourceLocale === 'string'
    ? `${mark.sourceLocale.toUpperCase()} file`
    : 'source language';
};

/** One file being linted, and the two ways a rule reports what it found. */
interface Walk {
  siteId: string;
  input: CheckInput;
  form: Form;
  locale: string;
  /** The collection's route, and nothing where the site renders no page for it. */
  route: string | undefined;
  /** What this entry is called in this language: what a search title falls back to. */
  title: string;
  say: (check: CheckName, fieldPath: string, message: string) => void;
  asset: (key: string, fieldPath: string, label: string) => void;
}

// The same descent the drift report and the propagation walk make: groups, blocks, arrays of
// rows, and the menus the schema walker cannot see inside.
function fieldsIn(
  w: Walk,
  fields: readonly Field[],
  data: unknown,
  at: string,
  inherited: Translation,
): void {
  for (const field of fields) {
    const key = field.path[0];
    if (key === undefined) continue;
    const value = isObject(data) ? data[key] : undefined;
    const path = at ? `${at}.${key}` : key;
    const mode = field.i18n ?? inherited;
    if (field.type === 'group') fieldsIn(w, field.fields, value, path, mode);
    else if (field.type === 'blocks')
      rowsIn(w, (row) => w.form.blocks[String(row._type)], value, path, mode);
    // Before `rowFields`, which knows a menu's rows: an item is a link and a label rather than
    // fields to lint, so the tree has a walk of its own.
    else if (field.type === 'menus') menusIn(w, value, path);
    else {
      const rows = rowFields(field);
      if (rows) rowsIn(w, () => rows, value, path, mode);
      else valueIn(w, field, value, path, mode);
    }
  }
}

const rowAt = (row: Record<string, unknown>, i: number) =>
  typeof row._id === 'string' ? `_id=${row._id}` : String(i);

function rowsIn(
  w: Walk,
  fieldsOf: (row: Record<string, unknown>) => readonly Field[] | undefined,
  rows: unknown,
  at: string,
  mode: Translation,
): void {
  if (!Array.isArray(rows)) return;
  for (const [i, row] of rows.entries()) {
    if (!isObject(row)) continue;
    const fields = fieldsOf(row);
    if (fields) fieldsIn(w, fields, row, `${at}[${rowAt(row, i)}]`, mode);
  }
}

// Parsing markdown costs about a fifth of a millisecond a field and this walk has ten to
// spend, so the parser is only started where there is something for it to find: a link to
// this site is written `](/`, and it is the only way one can be written — a reference
// definition is not one of the constructs a richtext field allows.
const INTERNAL_LINK = /\]\(\s*<?\s*\//;

const filled = (value: unknown) => typeof value === 'string' && value.trim() !== '';

function valueIn(w: Walk, field: Field, value: unknown, path: string, mode: Translation): void {
  switch (field.type) {
    case 'image': {
      if (!isObject(value)) break;
      if (typeof value.src === 'string') w.asset(value.src, `${path}.src`, field.label);
      if (!filled(value.alt))
        w.say(
          'image-alt',
          `${path}.alt`,
          `${field.label} has no alt text — a reader using a screen reader is told nothing about the picture`,
        );
      break;
    }
    case 'file':
      if (isObject(value) && typeof value.src === 'string')
        w.asset(value.src, `${path}.src`, field.label);
      break;
    case 'seo': {
      // The sharing picture is a picture like any other, and the one the site falls back to
      // belongs to the global that holds it rather than to this entry.
      const image = (value as SeoValue | undefined)?.image?.src;
      if (typeof image === 'string') w.asset(image, `${path}.image.src`, 'The sharing image');
      seoIn(w, value, path);
      break;
    }
    case 'link':
      linkIn(w, value, path, field.label);
      break;
    case 'richtext':
      if (typeof value === 'string' && INTERNAL_LINK.test(value))
        for (const url of richtextLinks(w.siteId, value)) urlIn(w, url, path, field.label);
      emptyIn(w, field, value, path, mode);
      break;
    case 'text':
      emptyIn(w, field, value, path, mode);
      break;
  }
}

/**
 * A field the schema requires, standing empty in a language that is not the one the site is
 * written in. The schema is happy — an empty string is a string — and the page is not: it
 * renders a blank where every other language has words.
 */
function emptyIn(
  w: Walk,
  field: Extract<Field, { type: 'text' | 'richtext' }>,
  value: unknown,
  path: string,
  mode: Translation,
): void {
  if (!field.required || mode !== true) return;
  if (w.locale === w.input.site.i18n.defaultLocale) return;
  if (value === undefined || filled(value)) return;
  w.say(
    'translation-empty',
    path,
    `${field.label} is empty in ${w.locale.toUpperCase()} — the page shows a blank where the other languages have words`,
  );
}

/**
 * What the page will tell a search engine and a chat window about itself, resolved the way
 * `<Seo />` resolves it: the entry's own field, then the site's defaults. A collection the
 * site renders no page for has nothing to say to anybody, so it is not asked.
 */
function seoIn(w: Walk, value: unknown, path: string): void {
  if (!w.route) return;
  const seo = resolveSeo(value as SeoValue | undefined, w.input.seoDefaults?.[w.locale], w.title);
  if (seo.title.trim().length > SEO_TITLE_LIMIT)
    w.say(
      'seo-title',
      `${path}.title`,
      `The search title is ${seo.title.trim().length} characters — Google cuts one off at about ${SEO_TITLE_LIMIT}`,
    );
  if (!filled(seo.description))
    w.say(
      'seo-description',
      `${path}.description`,
      'No search description — a search engine will quote whatever sentence of the page it likes',
    );
  if (!seo.image?.src)
    w.say(
      'seo-image',
      `${path}.image`,
      'No sharing image — a link to this page posted anywhere appears as plain text',
    );
}

/** The entry a `collection/name` reference names, and nothing where the index has no such row. */
function entryOf(index: ContentIndex, ref: string): IndexEntry | undefined {
  const cut = ref.indexOf('/');
  if (cut < 1) return undefined;
  return index[ref.slice(0, cut)]?.find((e) => e.id === ref.slice(cut + 1));
}

// The three ways a page is not there in one language: no file, a file the entry says it is not
// offered in, and one taken off the site. All three are a 404 to somebody following a link.
const liveIn = (entry: IndexEntry, locale: string) => {
  const file = entry.locales[locale];
  return Boolean(file) && file?.status !== 'hidden' && (entry.offered?.includes(locale) ?? true);
};

const named = (entry: IndexEntry, locale: string) =>
  entry.locales[locale]?.title ?? Object.values(entry.locales)[0]?.title ?? entry.id;

function linkIn(w: Walk, value: unknown, path: string, label: string): void {
  if (!isObject(value)) return;
  if (typeof value.ref === 'string') {
    const found = entryOf(w.input.index, value.ref);
    if (!found)
      w.say(
        'link-target',
        `${path}.ref`,
        `${label} points at ${value.ref}, which is not a page on this site — the link is a 404`,
      );
    else if (!liveIn(found, w.locale))
      w.say(
        'link-locale',
        `${path}.ref`,
        `${label} points at ${named(found, w.locale)}, which has no ${w.locale.toUpperCase()} page — a reader in this language follows it to a 404`,
      );
    return;
  }
  if (typeof value.href === 'string') urlIn(w, value.href, `${path}.href`, label);
}

/**
 * An address typed rather than picked: a link field's own URL, and every link inside a
 * richtext value.
 *
 * **A path the site's own routes could not produce is left alone.** It may be a page a
 * template renders itself, which no content file knows about — the same scope the media scan
 * and the sitemap have. What is reported is a path that *is* one of the collections' routes
 * and names no entry: that one is a 404 nobody typed on purpose.
 */
function urlIn(w: Walk, href: string, fieldPath: string, label: string): void {
  if (!href.startsWith('/')) return;
  const target = previewTarget(
    w.siteId,
    w.input.site.i18n,
    w.input.site.collections,
    href.replace(/[?#].*$/, ''),
  );
  if (!target?.address) return;
  // Without localized slugs the file name is the address in every language; with them the
  // entry answering here is the one whose own slug in that language says so.
  const localized = w.input.site.collections[target.collection]?.localizedSlugs;
  const found = (w.input.index[target.collection] ?? []).find(
    (e) => (localized ? (e.locales[target.locale]?.slug ?? e.id) : e.id) === target.address,
  );
  if (!found)
    w.say(
      'link-target',
      fieldPath,
      `${label} links to ${href}, where this site has no page — the link is a 404`,
    );
  else if (!liveIn(found, target.locale))
    w.say(
      'link-locale',
      fieldPath,
      `${label} links to ${href}, which ${named(found, target.locale)} does not answer at in ${target.locale.toUpperCase()} — the link is a 404`,
    );
}

/**
 * The navigation global's tree. A menu is the most-clicked thing on a site, so an item whose
 * page has gone is worth a warning even though the renderer drops it rather than linking to a
 * 404 — the item disappearing without a word is exactly what nobody notices.
 *
 * An item that only misses *this* language is not reported: that is what turning a page off in
 * one language does, the editor already flags it, and the menu is shared across the languages.
 */
function menusIn(w: Walk, value: unknown, at: string): void {
  if (!Array.isArray(value)) return;
  for (const [i, menu] of value.entries()) {
    if (!isObject(menu)) continue;
    itemsIn(w, menu.items, `${at}[${rowAt(menu, i)}].items`, String(menu.key ?? ''));
  }
}

function itemsIn(w: Walk, items: unknown, at: string, menu: string): void {
  if (!Array.isArray(items)) return;
  for (const [i, item] of items.entries()) {
    if (!isObject(item)) continue;
    const path = `${at}[${rowAt(item, i)}]`;
    const link = item.link;
    const ref = isObject(link) && typeof link.ref === 'string' ? link.ref : undefined;
    if (ref) {
      const found = entryOf(w.input.index, ref);
      if (!found)
        w.say(
          'menu-target',
          `${path}.link`,
          `The ${menu} menu has an item pointing at ${ref}, which is not a page on this site — the item is left out of the menu`,
        );
      else if (!w.input.site.i18n.locales.some((locale) => liveIn(found, locale)))
        w.say(
          'menu-target',
          `${path}.link`,
          `The ${menu} menu has an item pointing at ${named(found, w.locale)}, which is not on the site in any language — the item is left out of the menu`,
        );
    }
    itemsIn(w, item.children, `${path}.children`, menu);
  }
}

// The key format `mediaKey` writes: the row's id is the hash in the middle of it.
const STORED = /^(?:media|files)\/([0-9a-f]{64})\./;

// D1 takes a hundred bound parameters in one query, and the site id is one of them.
const PER_QUERY = 90;

/**
 * Every picture and download the publish names, in one read of the table. The bucket is asked
 * only about the keys that read found nothing for — a HEAD apiece is a subrequest apiece, and
 * on a healthy site there are none.
 */
async function assetResults(
  siteId: string,
  db: Db,
  input: CheckInput,
  assets: { key: string; path: string; fieldPath: string; label: string }[],
  deps: { fetch?: typeof globalThis.fetch },
): Promise<CheckResult[]> {
  if (!assets.length) return [];
  const ids = [...new Set(assets.flatMap((a) => STORED.exec(a.key)?.[1] ?? []))];
  const rows: { id: string; archived: number | null }[] = [];
  for (let i = 0; i < ids.length; i += PER_QUERY)
    rows.push(
      ...(await db
        .select({ id: media.id, archived: media.archived })
        .from(media)
        .where(and(eq(media.siteId, siteId), inArray(media.id, ids.slice(i, i + PER_QUERY))))),
    );
  const known = new Map(rows.map((row) => [row.id, row]));
  const unknown = [...new Set(assets.map((a) => a.key))].filter(
    (key) => !known.has(STORED.exec(key)?.[1] ?? ''),
  );
  const there = await Promise.all(
    unknown.map((key) => (input.store ? objectExists(input.store, key, deps) : false)),
  );
  const gone = new Set(unknown.filter((_, i) => !there[i]));
  return assets.flatMap((asset) => {
    const row = known.get(STORED.exec(asset.key)?.[1] ?? '');
    const said = (check: CheckName, message: string) => [
      { check, path: asset.path, fieldPath: asset.fieldPath, severity: CHECKS[check], message },
    ];
    if (row?.archived)
      return said(
        'media-archived',
        `${asset.label} has been archived in the media library — it still renders, but somebody put it away`,
      );
    // An object with no row renders perfectly well and is what the reconciliation job gives a
    // row back within the hour, so it is nobody's problem here.
    if (!row && gone.has(asset.key))
      return said(
        'media-missing',
        `${asset.label} has nothing behind it any more — the page would show a broken image (${asset.key})`,
      );
    return [];
  });
}
