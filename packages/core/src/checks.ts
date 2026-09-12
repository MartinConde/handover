// Warnings and notes, never a refusal: only the schema and unresolved drift stop a publish.

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

/** Keyed by the id `checks.ignore` turns a check off with. */
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
  path: string;
  /** Addressed the way `_machine` addresses a field, so *Go to field* survives a move. */
  fieldPath: string;
  severity: CheckSeverity;
  message: string;
}

export interface CheckSite {
  i18n: I18nRouting;
  collections: Record<
    string,
    { route?: string; index?: string; localizedSlugs?: boolean; titleField?: string }
  >;
}

/** Every language is here because staleness needs the source, but only `publishing` is linted. */
export interface CheckEntry {
  /** `listings/mill-house`. */
  key: string;
  form: Form;
  files: Record<string, { path: string; contents: string }>;
  /** The rest are context and are never reported on. */
  publishing: string[];
}

export interface CheckInput {
  entries: CheckEntry[];
  site: CheckSite;
  /** The built index with pending drafts laid over it. */
  index: ContentIndex;
  seoDefaults?: Record<string, SeoDefaultsValue>;
  /** Without it a key the table has no row for is taken as missing. */
  store?: R2Store;
  /** `checks.ignore` in `cms.config.ts`. */
  ignore?: readonly string[];
  /** From `lastHiddenLong`. */
  hiddenLong?: HiddenLong[];
}

/** Each file is parsed once: ten milliseconds of CPU cannot parse the same YAML per rule. */
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
    // `globals` is not a collection, and the miss is right: a global has no route or title field.
    const of = input.site.collections[collection] ?? {};
    const parsed: Record<string, unknown> = {};
    for (const locale of entry.publishing) {
      const file = entry.files[locale];
      if (file) parsed[locale] = parseEntry(siteId, file.contents);
    }
    // A language not going out is parsed only as the source of one that is.
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
      // `_machine` is the file's own record, so it is read rather than walked for.
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
    // The index is newer than the job's list: a page shown or deleted since is not mentioned.
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
  // Grouped by file in walk order, so two runs of the same publish agree.
  return found
    .filter((result) => !ignore.has(result.check))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const DAY = 24 * 60 * 60 * 1000;
const LONG_HIDDEN = 90 * DAY;
// Top-level only, so a `_status` inside a block does not match; quoted or not.
const HIDDEN = /^_status:\s*["']?hidden["']?\s*$/m;

export interface HiddenLong {
  path: string;
  since: string;
}

/** Dated from the file's own commits, walked newest first until a shown or old-enough version. */
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

/** A failed run leaves the last answer standing; after two days there is nothing current. */
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

interface Walk {
  siteId: string;
  input: CheckInput;
  form: Form;
  locale: string;
  /** Nothing where the site renders no page for the collection. */
  route: string | undefined;
  /** What a search title falls back to. */
  title: string;
  say: (check: CheckName, fieldPath: string, message: string) => void;
  asset: (key: string, fieldPath: string, label: string) => void;
}

// The same descent the drift report makes, plus the menus the schema walker cannot see inside.
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
    // Before `rowFields`, which knows a menu's rows: an item is a link and a label, not fields.
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

// Markdown parsing costs 0.2 ms a field, so it only runs where `](/` says there is a link.
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
      // The fallback sharing picture belongs to the global that holds it, not to this entry.
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

/** Reject blank text even when the schema accepts it. */
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

/** Resolved the way `<Seo />` resolves it; a collection with no page has nothing to say. */
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

function entryOf(index: ContentIndex, ref: string): IndexEntry | undefined {
  const cut = ref.indexOf('/');
  if (cut < 1) return undefined;
  return index[ref.slice(0, cut)]?.find((e) => e.id === ref.slice(cut + 1));
}

// No file, not offered, or hidden: all three are a 404 to somebody following a link.
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

/** A path no collection route could produce is left alone: a template may render it itself. */
function urlIn(w: Walk, href: string, fieldPath: string, label: string): void {
  if (!href.startsWith('/')) return;
  const target = previewTarget(
    w.siteId,
    w.input.site.i18n,
    w.input.site.collections,
    href.replace(/[?#].*$/, ''),
  );
  if (!target?.address) return;
  // With localized slugs the entry answering is the one whose slug in that language says so.
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

/** The renderer drops a dead item silently, which is exactly what nobody notices. */
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

// The row's id is the hash in the middle of `mediaKey`'s format.
const STORED = /^(?:media|files)\/([0-9a-f]{64})\./;

// D1 takes a hundred bound parameters a query, and the site id is one of them.
const PER_QUERY = 90;

/** The bucket is asked only about keys with no row: a HEAD apiece is a subrequest apiece. */
async function assetResults(
  siteId: string,
  db: Db,
  input: CheckInput,
  assets: { key: string; path: string; fieldPath: string; label: string }[],
  deps: { fetch?: typeof globalThis.fetch },
): Promise<CheckResult[]> {
  if (!assets.length) return [];
  const ids = [...new Set(assets.flatMap((a) => STORED.exec(a.key)?.[1] ?? []))];
  const rows: { id: string; archived: number | null; state: 'active' | 'deleting' | 'deleted' }[] =
    [];
  for (let i = 0; i < ids.length; i += PER_QUERY)
    rows.push(
      ...(await db
        .select({ id: media.id, archived: media.archived, state: media.state })
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
    if (row?.state === 'deleting')
      return said(
        'media-missing',
        `${asset.label} is being deleted and cannot be used — choose another asset`,
      );
    if (row?.state === 'deleted')
      return said(
        'media-missing',
        `${asset.label} has been deleted — the page would show a broken image (${asset.key})`,
      );
    if (row?.archived)
      return said(
        'media-archived',
        `${asset.label} has been archived in the media library — it still renders, but somebody put it away`,
      );
    // An object with no row renders fine and gets its row back from the reconciliation job.
    if (!row && gone.has(asset.key))
      return said(
        'media-missing',
        `${asset.label} has nothing behind it any more — the page would show a broken image (${asset.key})`,
      );
    return [];
  });
}
