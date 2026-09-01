import { Document, isMap, isScalar, isSeq, parse, parseDocument, visit } from 'yaml';
import type { ContentFile } from './entries.js';
import { blobSha } from './git.js';
import { entryAddress, entryUrl, type I18nRouting } from './names.js';
import { checkReserved, isLive, RESERVED_KEYS } from './reserved.js';
import { type Field, type Form, humanise, rowFields, type Translation } from './schema.js';
import { keptMachine } from './translate.js';

export interface ContentEntry<T = unknown> {
  id: string;
  data: T;
}

// What every `load()` in a site's `src/loaders/` takes. Ids are `${locale}/${slug}`.
export interface ContentSource<C extends Record<string, unknown> = Record<string, unknown>> {
  getEntry<K extends keyof C & string>(
    collection: K,
    id: string,
  ): Promise<ContentEntry<C[K]> | undefined>;
  getCollection<K extends keyof C & string>(
    collection: K,
    locale: string,
  ): Promise<ContentEntry<C[K]>[]>;
}

// The two functions from `astro:content`; core never imports that module itself.
export interface AstroContent<K extends string> {
  getEntry(collection: K, id: string): Promise<ContentEntry | undefined>;
  getCollection(collection: K): Promise<ContentEntry[]>;
}

export function staticSource<C extends Record<string, unknown>>(
  _siteId: string,
  astro: AstroContent<keyof C & string>,
): ContentSource<C> {
  return {
    // The collection is asked whether the id exists before the entry is asked for by name:
    // Astro's `getEntry` logs "Entry listings → de/coast was not found" on a miss, and an
    // untranslated entry would miss once per language on every page that draws the switcher.
    getEntry: async (collection, id) => {
      const all = await astro.getCollection(collection);
      if (!all.some((e) => e.id === id)) return undefined;
      return astro.getEntry(collection, id) as Promise<
        ContentEntry<C[typeof collection]> | undefined
      >;
    },
    getCollection: async (collection, locale) => {
      const all = await astro.getCollection(collection);
      // Astro's glob loader files an entry under a `slug` it finds in the data, which is where
      // a `localizedSlugs` collection keeps its address. Nothing outside the site's own
      // `content.config.ts` can see the loader, so the reader handed the ids is where the
      // missing option is caught — otherwise it shows as a 404 on every entry.
      const misfiled = all.find((e) => !e.id.includes('/'));
      if (misfiled)
        throw new Error(
          `Collection "${collection}" has an entry filed under "${misfiled.id}" rather than "<locale>/<name>": its glob loader in src/content.config.ts needs generateId: ({ entry }) => entry.replace(/\\.ya?ml$/, '')`,
        );
      return all.filter((e) => e.id.startsWith(`${locale}/`)) as ContentEntry<
        C[typeof collection]
      >[];
    },
  };
}

/**
 * What preview reads: the build's snapshot with the draft rows laid over it. A row wins for the
 * file it names, an emptied one is an entry that has gone, and everything else is the snapshot —
 * so a page rendered through this is the page as it would be published, not only the entry being
 * edited. The bytes are held to the collection's own schema, which lives in the site's
 * `cms.config.ts`, so `validate` is passed in: a draft the schema refuses is that error and never
 * half an entry.
 */
export function draftSource<C extends Record<string, unknown>>(
  siteId: string,
  built: ContentSource<C>,
  rows: readonly ContentFile[],
  validate: (collection: string, data: unknown, path: string) => unknown,
): ContentSource<C> {
  const pathOf = (collection: string, id: string) => `src/content/${collection}/${id}.yaml`;
  const read = <K extends keyof C & string>(collection: K, id: string, contents: string) => {
    const path = pathOf(collection, id);
    return { id, data: validate(collection, parseEntry(siteId, contents), path) as C[K] };
  };
  return {
    getEntry: async (collection, id) => {
      const row = rows.find((r) => r.path === pathOf(collection, id));
      if (!row) return built.getEntry(collection, id);
      return row.contents ? read(collection, id, row.contents) : undefined;
    },
    getCollection: async (collection, locale) => {
      const prefix = `src/content/${collection}/${locale}/`;
      const mine = rows.flatMap((r) => {
        const name = r.path.startsWith(prefix) ? r.path.slice(prefix.length, -'.yaml'.length) : '';
        return name && !name.includes('/') ? [{ id: `${locale}/${name}`, row: r }] : [];
      });
      const snapshot = await built.getCollection(collection, locale);
      const kept = snapshot.flatMap((e) => {
        const drafted = mine.find((m) => m.id === e.id);
        if (!drafted) return [e];
        return drafted.row.contents ? [read(collection, e.id, drafted.row.contents)] : [];
      });
      // An entry the snapshot has never seen is new since the build, so it goes at the end.
      const added = mine.filter((m) => m.row.contents && !snapshot.some((e) => e.id === m.id));
      return [...kept, ...added.map((m) => read(collection, m.id, m.row.contents))];
    },
  };
}

/** One language an entry can be read in, and where. */
export interface LocaleLink {
  locale: string;
  url: string;
}

/** As much of `cms.config.ts` as a link needs: the languages and the collections' routes. */
export interface LocaleSite {
  i18n: I18nRouting;
  collections: Record<
    string,
    { route?: string; index?: string; localizedSlugs?: boolean; titleField?: string }
  >;
}

/**
 * The languages one entry can be followed to: it has a file in that language's folder and that
 * file is live. The switcher on the site draws these.
 *
 * **The files are the fact.** A language the entry is not offered in has no file — that is how
 * turning one off is written — so having the file is the whole question, and the top-level
 * `_locales` is the CMS's record of the decision rather than the site's arbiter. Reading the
 * mark here would answer differently depending on which of the entry's files a bad edit landed
 * in; `entryOffer` reports that contradiction instead, where somebody can fix it.
 *
 * Everything it reads is in the content collections, so it costs the build no lookup of its
 * own — and a collection nothing renders has nowhere to send anyone.
 */
export async function getEntryLocales<C extends Record<string, unknown>>(
  siteId: string,
  source: ContentSource<C>,
  site: LocaleSite,
  collection: keyof C & string,
  slug: string,
): Promise<LocaleLink[]> {
  const route = site.collections[collection]?.route;
  if (!route) return [];
  const found = await Promise.all(
    site.i18n.locales.map(async (locale) => {
      const entry = await source.getEntry(collection, `${locale}/${slug}`);
      if (!entry || !isLive(siteId, entry.data)) return undefined;
      const address = site.collections[collection]?.localizedSlugs
        ? entryAddress(siteId, entry.data, slug)
        : slug;
      const url = entryUrl(siteId, site.i18n, route, address, locale);
      return url ? { locale, url } : undefined;
    }),
  );
  return found.filter((l) => l !== undefined);
}

/** One menu item as a page renders it: an address, and the items under it. */
export interface NavLink {
  label: string;
  href: string;
  newTab?: boolean;
  children: NavLink[];
}

/**
 * The `navigation` global's menus in one language, keyed by menu, ready to render.
 *
 * The tree is the same in every language; what it can point at is not. An item whose entry has
 * no file in this language, or whose file is hidden, is **dropped**, and its children with it —
 * a menu is the most-clicked thing on a site and must never be the way a reader finds a 404.
 * The editor flags those items so somebody tidies the menu; this is what keeps the site right
 * until they do.
 *
 * An item with no `label` is named by the page it points at, so renaming a page moves the menu
 * with it. The whole tree is walked defensively: it is content, and a hand edit is not a crash.
 */
export async function menusAt<C extends Record<string, unknown>>(
  siteId: string,
  source: ContentSource<C>,
  site: LocaleSite,
  navigation: unknown,
  locale: string,
): Promise<Record<string, NavLink[]>> {
  const menus = isObject(navigation) && Array.isArray(navigation.menus) ? navigation.menus : [];
  const out: Record<string, NavLink[]> = {};
  for (const menu of menus) {
    if (!isObject(menu) || typeof menu.key !== 'string') continue;
    out[menu.key] = await navLinks(siteId, source, site, menu.items, locale);
  }
  return out;
}

async function navLinks<C extends Record<string, unknown>>(
  siteId: string,
  source: ContentSource<C>,
  site: LocaleSite,
  items: unknown,
  locale: string,
): Promise<NavLink[]> {
  const links: NavLink[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!isObject(item)) continue;
    if (Array.isArray(item._locales) && !item._locales.includes(locale)) continue;
    const target = await href(siteId, source, site, item.link, locale);
    if (!target) continue;
    links.push({
      label: (typeof item.label === 'string' && item.label) || target.name,
      href: target.href,
      ...(item.newTab === true ? { newTab: true } : {}),
      children: await navLinks(siteId, source, site, item.children, locale),
    });
  }
  return links;
}

/** Where one item points in this language, and what the page it points at is called. */
async function href<C extends Record<string, unknown>>(
  siteId: string,
  source: ContentSource<C>,
  site: LocaleSite,
  link: unknown,
  locale: string,
): Promise<{ href: string; name: string } | undefined> {
  if (!isObject(link)) return undefined;
  if (link.type === 'url')
    return typeof link.href === 'string' ? { href: link.href, name: link.href } : undefined;
  // A collection's index is not an entry, so the item names the collection and the address is
  // this language's own index page; a collection with no index page has nowhere to link.
  if (link.type === 'index') {
    if (typeof link.collection !== 'string') return undefined;
    const url = entryUrl(siteId, site.i18n, site.collections[link.collection]?.index, '', locale);
    return url ? { href: url, name: humanise(link.collection) } : undefined;
  }
  if (typeof link.ref !== 'string') return undefined;
  const cut = link.ref.indexOf('/');
  const collection = link.ref.slice(0, cut);
  const name = link.ref.slice(cut + 1);
  if (cut < 1 || !name) return undefined;
  const entry = await source.getEntry(collection as keyof C & string, `${locale}/${name}`);
  if (!entry || !isLive(siteId, entry.data)) return undefined;
  const of = site.collections[collection];
  const address = of?.localizedSlugs ? entryAddress(siteId, entry.data, name) : name;
  const url = entryUrl(siteId, site.i18n, of?.route, address, locale);
  const titled = isObject(entry.data) ? entry.data[of?.titleField ?? 'title'] : undefined;
  return url ? { href: url, name: typeof titled === 'string' ? titled : name } : undefined;
}

/**
 * The entry one language serves at this address, for the site's own `[slug]` route. Without
 * localized slugs the address is the file name and this is the lookup it always was.
 *
 * With them the file name is no longer the URL, so it stops answering to one: a file whose
 * `slug` has moved it elsewhere is **not** served under its name — the old address is a
 * redirect the publish wrote, not a second live page. Only then is the language's folder read
 * through, which is a page's worth of files on the sites this is for.
 */
export async function entryAt<C extends Record<string, unknown>, K extends keyof C & string>(
  siteId: string,
  source: ContentSource<C>,
  site: LocaleSite,
  collection: K,
  locale: string,
  address: string,
): Promise<ContentEntry<C[K]> | undefined> {
  const named = await source.getEntry(collection, `${locale}/${address}`);
  if (!site.collections[collection]?.localizedSlugs) return named;
  if (named && entryAddress(siteId, named.data, address) === address) return named;
  const found = await source.getCollection(collection, locale);
  return found.find((e) => entryAddress(siteId, e.data, e.id.slice(locale.length + 1)) === address);
}

/**
 * Every `_ref` in a file that names a global `cms.config.ts` does not declare. The build refuses
 * these the way an unregistered `_type` is refused: the block renders as the global's content,
 * so a name nothing answers to is a hole in the page and not a value somebody can fill in.
 */
export function refErrors(
  _siteId: string,
  path: string,
  contents: string,
  globals: Iterable<string>,
): string[] {
  const declared = [...globals];
  const errors: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, `${at}[${i}]`);
      });
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const here = at ? `${at}.${key}` : key;
      if (key === '_ref' && typeof value === 'string') {
        const name = value.replace(/^globals\//, '');
        if (!declared.includes(name))
          errors.push(
            `${path} › ${here}: no global ${JSON.stringify(name)} is declared in cms.config.ts — it has ${declared.join(', ') || 'none'}`,
          );
      } else walk(value, here);
    }
  };
  walk(parse(contents), '');
  return errors;
}

/**
 * The site's globals in one language, keyed by file name — what a `_ref` block is filled from
 * and what a footer reads its text out of. One read of the collection rather than one per key,
 * since a page that wants any of them usually wants two.
 */
export async function globalsAt<C extends Record<string, unknown>>(
  _siteId: string,
  source: ContentSource<C>,
  locale: string,
): Promise<Record<string, unknown>> {
  const found = await source.getCollection('globals' as keyof C & string, locale);
  return Object.fromEntries(found.map((e) => [e.id.slice(locale.length + 1), e.data]));
}

export function parseEntry(_siteId: string, contents: string): unknown {
  const data: unknown = parse(contents);
  checkReserved(data);
  return data;
}

// Transcribed from js-yaml's lib/type/timestamp.js rather than depending on the package:
// core/ ships in the Worker bundle. A plain scalar matching either of these is a `Date` to
// js-yaml, which Astro's content loader parses with, and a string to `yaml`'s core schema,
// which everything here parses with. `2026-7-4` matches neither and is a string to both.
const YAML_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const YAML_TIMESTAMP =
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?$/;

// Anything but a plain scalar is a string to both parsers, so the test is on the style and
// not on PLAIN: a scalar style this list has never heard of is reported rather than skipped.
const QUOTED = ['QUOTE_DOUBLE', 'QUOTE_SINGLE', 'BLOCK_LITERAL', 'BLOCK_FOLDED'];

/**
 * Every unquoted date in a hand-written file, one message per key. The build calls this
 * before Astro's loader reads the same file, because the loader's own message for it is
 * `Expected type "string", received "object"` and never mentions the quotes.
 */
export function timestampErrors(_siteId: string, path: string, contents: string): string[] {
  const errors: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (isSeq(node))
      node.items.forEach((item, i) => {
        walk(item, `${at}[${i}]`);
      });
    else if (isMap(node))
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : '?';
        walk(pair.value, at ? `${at}.${key}` : key);
      }
    else if (
      isScalar(node) &&
      typeof node.value === 'string' &&
      !QUOTED.includes(node.type ?? '') &&
      (YAML_DATE.test(node.value) || YAML_TIMESTAMP.test(node.value))
    )
      errors.push(
        `${path} › ${at}: an unquoted date is a timestamp, not a string. Quote it: "${node.value}"`,
      );
  };
  walk(parseDocument(contents).contents, '');
  return errors;
}

// The only writer of content files. Pinned here so publish can compare blob SHAs:
// parse(text) → stringify must give back text unchanged for any file the CMS wrote.
const YAML_OPTIONS = {
  defaultStringType: 'QUOTE_DOUBLE',
  defaultKeyType: 'PLAIN',
  blockQuote: 'literal',
  lineWidth: 0,
  indent: 2,
} as const;

/** The format version a file without `_version` is read as, and the one a save writes. */
export const FORMAT_VERSION = 1;

// Sorted last, so a key the schema does not declare keeps the place the file gave it.
const UNDECLARED = Number.MAX_SAFE_INTEGER;

/**
 * One object's keys in the order the format fixes: the reserved `_` keys, then the schema's
 * own order, then whatever else it carries — a key the schema no longer declares keeps the
 * place the file gave it rather than being dropped (session 1.23).
 */
function ordered(
  fields: readonly Field[],
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const schema = new Map<string, number>();
  for (const [i, field] of fields.entries()) {
    const key = field.path[0];
    if (key !== undefined && !schema.has(key)) schema.set(key, i);
  }
  const rank = (key: string) => (key.startsWith('_') ? -1 : (schema.get(key) ?? UNDECLARED));
  const keys = Object.keys(entry).sort((a, b) => rank(a) - rank(b));
  return Object.fromEntries(keys.map((key) => [key, entry[key]]));
}

/**
 * One file as a write must leave it, for every write that is not the editor's save: `_version`
 * in front of a file that has none, and the canonical key order. Reconciling drift, turning a
 * language off, setting an address and duplicating an entry all write files the browser never
 * sent, and `content-format.md`'s "the next save stamps it" is about them too.
 */
export function writtenEntry(
  _siteId: string,
  entry: unknown,
  fields: readonly Field[] = [],
): Record<string, unknown> {
  return { _version: FORMAT_VERSION, ...ordered(fields, (entry ?? {}) as Record<string, unknown>) };
}

/**
 * One file of an entry whose languages changed: the ones it is still offered in written into it —
 * the key taken out again when they are all of them — and an `_i18n` made against a language
 * that has gone dropped with them. A mark naming a file the entry no longer has can never be
 * compared against anything, so it would stand as a warning nobody could clear.
 */
export function offeredEntry(
  siteId: string,
  entry: unknown,
  offer: { offered: string[]; locales: string[]; gone?: string[] },
): Record<string, unknown> {
  const written = writtenEntry(siteId, entry);
  const kept = offer.locales.filter((locale) => offer.offered.includes(locale));
  if (kept.length === offer.locales.length) delete written._locales;
  else written._locales = kept;
  const mark = written._i18n;
  if (
    isObject(mark) &&
    typeof mark.sourceLocale === 'string' &&
    offer.gone?.includes(mark.sourceLocale)
  )
    delete written._i18n;
  return written;
}

// The form sends back every key it was given, a key the schema no longer declares included:
// a rename in `schemas.ts` before the migration is written must not lose the value on the
// first save. The `_` keys belong to the file, so they are read back off the entry as it
// stands rather than being dropped on every save. A file from before Handover has no
// `_version`; it is read as 1 and stamped here, so every file the CMS writes carries one.
//
// A locale other than the source one passes the form it drew: its form shows the fields that
// locale owns and nothing else, so everything else is read off the file rather than dropped
// for having never been sent back (decap-cms#6978).
export function mergeEntry(
  _siteId: string,
  entry: unknown,
  values: Record<string, unknown>,
  translated?: Form,
): Record<string, unknown> {
  const reserved = Object.entries((entry ?? {}) as Record<string, unknown>).filter(([k]) =>
    k.startsWith('_'),
  );
  const merged = translated
    ? overlay(translated, translated.fields, values, entry, (m) => m === true, true)
    : values;
  const out: Record<string, unknown> = {
    _version: FORMAT_VERSION,
    ...Object.fromEntries(reserved),
    ...merged,
  };
  // A machine wrote some of these values; a person typing over one takes its badge off, and
  // the save is the only place that notices, since the form sends every field it drew.
  const machine = keptMachine(_siteId, entry, out);
  if (machine.length) out._machine = machine;
  else delete out._machine;
  return out;
}

/**
 * One entry's other language, brought into line with the edit just made to this one. The
 * skeleton is global, so `after`'s rows and their order win — adding, removing or moving a
 * block is one edit to every language or it is not one at all. `before` is what tells a row
 * the edit dropped from a row it never had: what only `target` has, a locale-only block or a
 * drifted one, is left exactly where it stands, because reconciling drift is a decision
 * somebody makes and not something a save does. `_locales` says which files a row is written
 * to, `duplicate` values come from `after` and translated ones stay in `target`.
 */
export function syncLocale(
  _siteId: string,
  form: Form,
  locale: string,
  edit: { before: unknown; after: unknown },
  target: unknown,
): Record<string, unknown> {
  const synced = overlay(form, form.fields, edit.after, target, (m) => m === 'duplicate', true, {
    locale,
    was: edit.before,
  });
  return { _version: FORMAT_VERSION, ...synced };
}

/** One row of drift as somebody answered it: the languages it should end up in. */
export interface DriftChoice {
  /** The row's `path` in the report it came from. */
  path: string;
  /** Empty takes the row out of every file. */
  locales: string[];
}

/**
 * Every language's file with the answers applied. A row ends up in the files its answer names
 * and comes out of the others, arriving in a new one with the values every language shares and
 * nothing to read yet — the same as a block added to one language. `_locales` is rewritten only
 * where the answer is not what the mark already said, so a mark naming a language the entry has
 * no file in survives an answer about the languages it does have.
 *
 * `locales` is the site's declared languages: a row in every one of them carries no mark at all,
 * which is not the same as one naming them.
 */
export function applyDrift(
  _siteId: string,
  form: Form,
  locales: string[],
  files: Record<string, unknown>,
  choices: DriftChoice[],
): Record<string, unknown> {
  const out = structuredClone(files);
  const answers = new Map(
    choices.map((c) => [c.path, locales.filter((l) => c.locales.includes(l))]),
  );
  const copies = Object.keys(out).map((locale) => ({
    locale,
    here: isObject(out[locale]) ? out[locale] : undefined,
    make: () => {
      if (!isObject(out[locale])) out[locale] = {};
      return out[locale] as Record<string, unknown>;
    },
  }));
  applyIn(form, form.fields, copies, '', true, { answers, locales });
  return out;
}

/** One language's file at the depth the walk has reached, made where an answer needs it. */
interface Into {
  locale: string;
  /** The object as the file has it, or nothing where the file goes no deeper. */
  here: Record<string, unknown> | undefined;
  /** The same, made in its parent: called only when a row is being written into it. */
  make: () => Record<string, unknown>;
}

interface Answers {
  answers: Map<string, string[]>;
  locales: string[];
}

const deeper = (parent: Into, key: string): Into => ({
  locale: parent.locale,
  here: isObject(parent.here?.[key]) ? parent.here[key] : undefined,
  make: () => {
    const owner = parent.make();
    const made = isObject(owner[key]) ? owner[key] : {};
    owner[key] = made;
    return made;
  },
});

// The same descent `driftIn` makes, so the paths it reports are the paths answered here.
function applyIn(
  form: Form,
  fields: readonly Field[],
  copies: Into[],
  at: string,
  inherited: Translation,
  ctx: Answers,
): void {
  for (const field of fields) {
    const key = field.path[0];
    if (key === undefined) continue;
    const path = at ? `${at}.${key}` : key;
    const mode = field.i18n ?? inherited;
    const row = rowFields(field);
    if (field.type === 'group')
      applyIn(
        form,
        field.fields,
        copies.map((c) => deeper(c, key)),
        path,
        mode,
        ctx,
      );
    else if (field.type === 'blocks')
      applyRows(form, (row) => form.blocks[String(row._type)], copies, key, path, mode, ctx);
    else if (row) applyRows(form, () => row, copies, key, path, mode, ctx);
  }
}

type FieldsOf = (row: Record<string, unknown>) => readonly Field[] | undefined;

const rowsOf = (copy: Into, key: string) =>
  Array.isArray(copy.here?.[key]) ? (copy.here[key] as unknown[]) : undefined;
const rowIn = (copy: Into, key: string, id: string) =>
  rowsOf(copy, key)?.find((row, i) => rowKey(row, i) === id);

function applyRows(
  form: Form,
  fieldsOf: FieldsOf,
  copies: Into[],
  key: string,
  at: string,
  mode: Translation,
  ctx: Answers,
): void {
  const ids: string[] = [];
  for (const copy of copies)
    for (const [i, row] of (rowsOf(copy, key) ?? []).entries()) {
      const id = rowKey(row, i);
      if (!ids.includes(id)) ids.push(id);
    }
  for (const id of ids) {
    const path = `${at}[${id.startsWith('#') ? id.slice(1) : `_id=${id}`}]`;
    const answer = ctx.answers.get(path);
    if (answer) answerRow(form, fieldsOf, copies, key, id, answer, mode, ctx.locales);
    // The languages that have the row now, an answer having just moved it about.
    const inside = copies.flatMap((copy) => {
      const row = rowIn(copy, key, id);
      return isObject(row) ? [{ locale: copy.locale, here: row, make: () => row }] : [];
    });
    const first = inside[0]?.here;
    const fields = first ? fieldsOf(first) : undefined;
    if (fields && inside.length > 1) applyIn(form, fields, inside, path, mode, ctx);
  }
}

/**
 * One row's answer in every language's file. A file the answer names gets the row where its
 * neighbours put it — behind the last row before it that this file also has — and one it does
 * not name loses it. The mark follows the answer only where the two disagree.
 */
function answerRow(
  form: Form,
  fieldsOf: FieldsOf,
  copies: Into[],
  key: string,
  id: string,
  answer: string[],
  mode: Translation,
  locales: string[],
): void {
  const from = copies.find((c) => isObject(rowIn(c, key, id)));
  const donor = from && rowIn(from, key, id);
  if (!from || !isObject(donor)) return;
  const files = copies.map((c) => c.locale);
  const named = copies.flatMap((c) => {
    const row = rowIn(c, key, id);
    return isObject(row) && Array.isArray(row._locales) ? (row._locales as string[]) : [];
  });
  const expected = named.length ? files.filter((l) => named.includes(l)) : files;
  // What the answer says the mark should be, keeping a language it names that has no file to
  // disagree with. A row in every declared language carries no mark.
  const mark = locales.filter(
    (l) => answer.includes(l) || (named.includes(l) && !files.includes(l)),
  );
  const rewrite = locales.filter((l) => expected.includes(l)).join() !== answer.join();
  // The rows the donor file has ahead of this one: what says where it belongs in another.
  const ahead = (rowsOf(from, key) ?? []).map((row, i) => rowKey(row, i));
  const before = ahead.slice(0, ahead.indexOf(id));
  for (const copy of copies) {
    const row = rowIn(copy, key, id);
    if (!answer.includes(copy.locale)) {
      const rows = rowsOf(copy, key);
      if (rows && copy.here) copy.here[key] = rows.filter((r) => r !== row);
      continue;
    }
    const kept = isObject(row) ? row : place(form, fieldsOf, copy, key, donor, before, mode);
    if (rewrite) {
      if (mark.join() === locales.join()) delete kept._locales;
      else kept._locales = mark;
    }
  }
}

// A row arriving in a file that has not had it: its shared values and its skeleton, the blocks
// inside it included, and the place its neighbours give it.
function place(
  form: Form,
  fieldsOf: FieldsOf,
  copy: Into,
  key: string,
  donor: Record<string, unknown>,
  before: string[],
  mode: Translation,
): Record<string, unknown> {
  const fields = fieldsOf(donor);
  const made = fields
    ? overlay(form, fields, donor, skeletonOf(donor, undefined), (m) => m === 'duplicate', mode, {
        locale: copy.locale,
        was: undefined,
      })
    : (structuredClone(donor) as Record<string, unknown>);
  const owner = copy.make();
  const rows = Array.isArray(owner[key]) ? (owner[key] as unknown[]) : [];
  const here = rows.map((row, i) => rowKey(row, i));
  const after = [...before].reverse().find((k) => here.includes(k));
  rows.splice(after === undefined ? 0 : here.indexOf(after) + 1, 0, made);
  owner[key] = rows;
  return made;
}

/** The mark a translation carries: which language it was made from, and that language as it stood. */
export interface I18nMark {
  sourceLocale: string;
  /** Git blob SHA of the source language's file the translation was made from. */
  sourceBlob: string;
  /** Hash of the values that file was translated from; two of these agreeing is "not stale". */
  sourceHash: string;
  translatedAt: string;
}

/** One entry's source language, as the publish about to commit the translation leaves it. */
export interface TranslationSource {
  locale: string;
  contents: string;
  blob_sha: string;
}

/**
 * One translation's file, marked with the language it was made from and that language as this
 * same commit leaves it. When the source language moves on afterwards the two stop agreeing,
 * which is what makes the translation stale — a warning and never a refusal.
 *
 * `was` is the file as the repository has it. A block arriving from another language or leaving
 * it rewrites a translation without anybody translating anything, and so does a shared value:
 * what says somebody translated is a value both files have and disagree about. Without a
 * repository file there is nothing it could be but a translation.
 */
export async function markTranslation(
  siteId: string,
  form: Form,
  source: TranslationSource,
  contents: string,
  was: string | undefined,
): Promise<string> {
  const data = parseEntry(siteId, contents);
  if (!isObject(data)) return contents;
  const before = new Map(was ? translatedValues(form, parseEntry(siteId, was)) : []);
  const typed = translatedValues(form, data).some(
    ([path, value]) => before.has(path) && before.get(path) !== value,
  );
  if (was !== undefined && !typed) return contents;
  const mark: I18nMark = {
    sourceLocale: source.locale,
    sourceBlob: source.blob_sha,
    sourceHash: await hashOf(form, parseEntry(siteId, source.contents)),
    translatedAt: new Date().toISOString(),
  };
  return stringifyEntry(siteId, { ...data, _i18n: mark });
}

/**
 * The languages whose translation was made from an older source language than the one this entry
 * now has. A file with no `_i18n` has never been marked and is not stale; neither is one whose
 * mark carries no hash, or one naming a source language the entry has no file in — a mark that
 * says nothing about the values cannot say they have moved on, and there would be no way to
 * clear the warning if it did. Warn only — nothing is refused for this.
 */
export async function staleLocales(
  _siteId: string,
  form: Form,
  files: Record<string, unknown>,
): Promise<string[]> {
  const hashes = new Map<string, Promise<string>>();
  const stale: string[] = [];
  for (const [locale, data] of Object.entries(files)) {
    const mark = isObject(data) && isObject(data._i18n) ? data._i18n : {};
    const from = typeof mark.sourceLocale === 'string' ? mark.sourceLocale : undefined;
    if (from === undefined || from === locale || !(from in files)) continue;
    if (typeof mark.sourceHash !== 'string') continue;
    if (!hashes.has(from)) hashes.set(from, hashOf(form, files[from]));
    if ((await hashes.get(from)) !== mark.sourceHash) stale.push(locale);
  }
  return stale;
}

// Sixteen characters: it goes in every translated file and answers one question. `blobSha` for
// want of another hash in the bundle — it is taken over the values and not over a file, and
// nothing in the repository is addressed by it.
const hashOf = async (form: Form, data: unknown) =>
  (
    await blobSha(
      translatedValues(form, data)
        .map(([path, value]) => `${path}=${value}`)
        .join('\n'),
    )
  ).slice(0, 16);

/**
 * Every value a translation is made from: the translated leaves of one file, addressed the way
 * `_machine` addresses a field and sorted by that address, so moving a block is not a change to
 * what the file says. Shared and source-language-only fields are left out — a price nobody
 * retypes is not a reason to retranslate.
 */
export function translatedValues(form: Form, data: unknown): [string, string][] {
  const found: [string, string][] = [];
  valuesIn(form, form.fields, data, '', true, found);
  return found.sort(([a], [b]) => (a < b ? -1 : 1));
}

// The same descent `driftIn` and `overlay` make.
function valuesIn(
  form: Form,
  fields: readonly Field[],
  data: unknown,
  at: string,
  inherited: Translation,
  found: [string, string][],
): void {
  for (const field of fields) {
    const key = field.path[0];
    if (key === undefined) continue;
    const value = isObject(data) ? data[key] : undefined;
    const path = at ? `${at}.${key}` : key;
    const mode = field.i18n ?? inherited;
    const props = TRANSLATED_PROPS[field.type];
    const row = rowFields(field);
    if (field.type === 'group') valuesIn(form, field.fields, value, path, mode, found);
    else if (props && mode === true)
      for (const prop of props) {
        const inner = prop
          .split('.')
          .reduce<unknown>((v, k) => (isObject(v) ? v[k] : undefined), value);
        if (inner !== undefined) found.push([`${path}.${prop}`, JSON.stringify(inner)]);
      }
    else if (field.type === 'blocks')
      valuesInRows(form, (row) => form.blocks[String(row._type)], value, path, mode, found);
    else if (row) valuesInRows(form, () => row, value, path, mode, found);
    else if (mode === true && value !== undefined) found.push([path, JSON.stringify(value)]);
  }
}

function valuesInRows(
  form: Form,
  fieldsOf: FieldsOf,
  rows: unknown,
  at: string,
  mode: Translation,
  found: [string, string][],
): void {
  if (!Array.isArray(rows)) return;
  for (const [i, row] of rows.entries()) {
    if (!isObject(row)) continue;
    const key = rowKey(row, i);
    const fields = fieldsOf(row);
    if (fields)
      valuesIn(
        form,
        fields,
        row,
        `${at}[${key.startsWith('#') ? key.slice(1) : `_id=${key}`}]`,
        mode,
        found,
      );
  }
}

/** One row of an entry its languages disagree about — what a save must never resolve. */
export interface Drift {
  /** The row addressed the way `_machine` addresses a field: `blocks[_id=z9y8x7w6]`. */
  path: string;
  /** The block's `_type`, so the reconciliation panel can name it; array rows have none. */
  type?: string;
  /** The languages whose file has the row. */
  in: string[];
  /** The languages it belongs in: its `_locales`, or all of them where it names none. */
  expected: string[];
  /** The words each language that has the row says in it — what an answer stands to lose. */
  values: Record<string, string[]>;
}

/**
 * Every row an entry's languages disagree about. The skeleton is shared, so a block one file
 * has and another does not, with no `_locales` to say so, is a hand edit or a bad merge — and
 * `syncLocale` leaves it exactly where it stands, because choosing a side is somebody's
 * decision. A publish is refused while one stands: committing would bake it into git.
 *
 * `files` is the languages the entry has a file in, parsed; fewer than two cannot drift. Where
 * two copies of a row name different `_locales`, the row is taken to belong to all of them
 * together: what they name between them is what is expected of it.
 */
export function driftReport(_siteId: string, form: Form, files: Record<string, unknown>): Drift[] {
  const found: Drift[] = [];
  const copies = Object.entries(files).map(([locale, data]) => ({ locale, data }));
  if (copies.length > 1) driftIn(form, form.fields, copies, '', found);
  return found;
}

/** One entry as one language has it, at the depth the walk has reached. */
interface Copy {
  locale: string;
  data: unknown;
}

// The same descent `overlay` makes: rows live under `blocks` fields, under arrays of objects
// and inside groups, and nowhere else the CMS keeps in step.
function driftIn(
  form: Form,
  fields: readonly Field[],
  copies: Copy[],
  at: string,
  found: Drift[],
): void {
  for (const field of fields) {
    const key = field.path[0];
    if (key === undefined) continue;
    const under = copies.map(({ locale, data }) => ({
      locale,
      data: isObject(data) ? data[key] : undefined,
    }));
    const path = at ? `${at}.${key}` : key;
    const row = rowFields(field);
    if (field.type === 'group') driftIn(form, field.fields, under, path, found);
    else if (field.type === 'blocks')
      driftRows(form, (row) => form.blocks[String(row._type)], under, path, found);
    else if (row) driftRows(form, () => row, under, path, found);
  }
}

function driftRows(
  form: Form,
  fieldsOf: (row: Record<string, unknown>) => readonly Field[] | undefined,
  copies: Copy[],
  at: string,
  found: Drift[],
): void {
  const locales = copies.map((c) => c.locale);
  const rows = new Map<string, Copy[]>();
  for (const { locale, data } of copies)
    if (Array.isArray(data))
      for (const [i, row] of data.entries()) {
        const key = rowKey(row, i);
        rows.set(key, [...(rows.get(key) ?? []), { locale, data: row }]);
      }
  for (const [key, row] of rows) {
    const first = row[0]?.data;
    const path = `${at}[${key.startsWith('#') ? key.slice(1) : `_id=${key}`}]`;
    const named = row.flatMap((c) =>
      isObject(c.data) && Array.isArray(c.data._locales) ? (c.data._locales as string[]) : [],
    );
    const expected = named.length ? locales.filter((l) => named.includes(l)) : locales;
    const has = row.map((c) => c.locale);
    // A block type the form has never heard of has no fields to read and no rows below it.
    const fields = isObject(first) ? fieldsOf(first) : undefined;
    if (has.join() !== expected.join()) {
      const type = isObject(first) && typeof first._type === 'string' ? first._type : undefined;
      const words = (data: unknown) => {
        const said: string[] = [];
        rowWords(fields ?? [], data, said);
        return said;
      };
      found.push({
        path,
        type,
        in: has,
        expected,
        values: Object.fromEntries(row.map((c) => [c.locale, words(c.data)])),
      });
    }
    // A row only one file has cannot disagree with anything below it.
    if (fields && row.length > 1) driftIn(form, fields, row, path, found);
  }
}

/**
 * The words one row says, in the schema's order: what the reconciliation panel shows so an
 * answer is made against the content and not against a file name. Prose only — a card is for
 * reading, and nobody is deciding between two numbers.
 */
function rowWords(fields: readonly Field[], data: unknown, found: string[]): void {
  for (const field of fields) {
    const value = isObject(data) ? data[field.path[0] ?? ''] : undefined;
    if (field.type === 'group') rowWords(field.fields, value, found);
    else if ((field.type === 'text' || field.type === 'richtext') && typeof value === 'string')
      found.push(value);
  }
}

// The properties a structured field translates; everything else in one is the same in every
// language. Getting this wrong is what makes clients retype image URLs.
export const TRANSLATED_PROPS: Partial<Record<Field['type'], readonly string[]>> = {
  image: ['alt'],
  file: ['name'],
  embed: ['title'],
  link: ['label'],
  seo: ['title', 'description', 'image.alt'],
};

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Skeleton mode: the rows come from `from`, and `was` says which of `onto`'s are gone. */
interface Skeleton {
  locale: string;
  was: unknown;
}

const into = (sync: Skeleton | undefined, key: string): Skeleton | undefined =>
  sync && { ...sync, was: isObject(sync.was) ? sync.was[key] : undefined };

/**
 * `onto` is the file being written and keeps its own structure; `from` supplies the value of
 * every field `pick` claims for it — an absent one included, since a field the form drew and
 * left empty comes back as no key at all. A save picks the translatable values out of the
 * form, propagation the duplicate ones out of the source locale, and it is the same walk.
 * With `sync` the structure comes from `from` as well: that is a save of one language
 * carrying its skeleton into another.
 */
function overlay(
  form: Form,
  fields: readonly Field[],
  from: unknown,
  onto: unknown,
  pick: (mode: Translation) => boolean,
  inherited: Translation,
  sync?: Skeleton,
): Record<string, unknown> {
  const sent = isObject(from) ? from : {};
  const out: Record<string, unknown> = isObject(onto) ? { ...onto } : {};
  for (const field of fields) {
    const key = field.path[0];
    if (key === undefined) continue;
    const mode = field.i18n ?? inherited;
    const props = TRANSLATED_PROPS[field.type];
    const row = rowFields(field);
    if (field.type === 'group') {
      const group = overlay(form, field.fields, sent[key], out[key], pick, mode, into(sync, key));
      if (Object.keys(group).length) out[key] = group;
      else delete out[key];
    } else if (props && mode === true) {
      const value = overlayProps(sent[key], out[key], props, pick);
      if (value === undefined) delete out[key];
      else out[key] = value;
    } else if (field.type === 'blocks') {
      const rows = pairRows(
        form,
        (b) => form.blocks[String(b._type)],
        sent[key],
        out[key],
        pick,
        mode,
        into(sync, key),
      );
      if (rows) out[key] = rows;
    } else if (row) {
      const rows = pairRows(form, () => row, sent[key], out[key], pick, mode, into(sync, key));
      if (rows) out[key] = rows;
    } else if (pick(mode)) {
      if (key in sent) out[key] = sent[key];
      else delete out[key];
    }
  }
  // A key this walk added lands at the end of the object it was added to, so a file written
  // from another language would carry the shared values before the translated ones.
  return ordered(fields, out);
}

export function stringifyEntry(_siteId: string, data: unknown): string {
  const doc = new Document(canonical(data, ''));
  // QUOTE_DOUBLE as the default would also quote multiline prose; opt those into `|`.
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === 'string' && node.value.includes('\n')) {
        node.type = 'BLOCK_LITERAL';
      }
    },
  });
  return doc.toString(YAML_OPTIONS);
}

function canonical(value: unknown, path: string): unknown {
  if (typeof value === 'string') return normalise(value);
  if (value instanceof Date) {
    throw new Error(`Date object at ${path}: store dates as "YYYY-MM-DD" strings`);
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      if (Array.isArray(item)) {
        throw new Error(`Nested array at ${path}[${i}]: wrap the inner array in an object`);
      }
      return canonical(item, `${path}[${i}]`);
    });
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== null && obj[k] !== undefined);
    const rank = (k: string) => {
      const i = RESERVED_KEYS.indexOf(k as (typeof RESERVED_KEYS)[number]);
      return i === -1 ? RESERVED_KEYS.length : i;
    };
    keys.sort((a, b) => rank(a) - rank(b));
    return Object.fromEntries(keys.map((k) => [k, canonical(obj[k], path ? `${path}.${k}` : k)]));
  }
  return value;
}

// The yaml library silently drops back from `|` to a quoted string on trailing spaces, a
// trailing newline run or control characters, which would change the bytes on the next save.
function normalise(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[^\n\t\x20-\uFFFF]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/, '');
}

// A row is its `_id`; an array of rows without one — a template's blocks — pairs by position.
export const rowKey = (row: unknown, i: number) =>
  isObject(row) && typeof row._id === 'string' ? row._id : `#${i}`;

// A row is written to the languages `_locales` names, and to all of them when it names none.
const inLocale = (row: unknown, locale: string) =>
  !isObject(row) || !Array.isArray(row._locales) || row._locales.includes(locale);

// The skeleton is the same in every language, so the file being written keeps its own rows in
// their own order and the other side is read for values alone, paired by `_id`.
function pairRows(
  form: Form,
  fieldsOf: (row: Record<string, unknown>) => readonly Field[] | undefined,
  from: unknown,
  onto: unknown,
  pick: (mode: Translation) => boolean,
  mode: Translation,
  sync?: Skeleton,
): unknown[] | undefined {
  if (sync) return syncRows(form, fieldsOf, from, onto, pick, mode, sync);
  if (!Array.isArray(onto)) return undefined;
  const sent = Array.isArray(from) ? from : [];
  return onto.map((row, i) => {
    const fields = isObject(row) ? fieldsOf(row) : undefined;
    if (!fields) return row;
    const match =
      row._id === undefined ? sent[i] : sent.find((s) => isObject(s) && s._id === row._id);
    // A row the other side does not have is drift, not an emptied one: leave it alone.
    return isObject(match) ? overlay(form, fields, match, row, pick, mode) : row;
  });
}

// A structured field splits: an image's `alt` is translated and its `src`, `width` and
// `height` are the same everywhere, so one image is written from two files.
function overlayProps(
  from: unknown,
  onto: unknown,
  translated: readonly string[],
  pick: (mode: Translation) => boolean,
): Record<string, unknown> | undefined {
  const sent = isObject(from) ? from : {};
  const out: Record<string, unknown> = isObject(onto) ? { ...onto } : {};
  for (const key of new Set([...Object.keys(out), ...Object.keys(sent)])) {
    const under = translated
      .filter((t) => t.startsWith(`${key}.`))
      .map((t) => t.slice(key.length + 1));
    if (under.length) {
      const inner = overlayProps(sent[key], out[key], under, pick);
      if (inner === undefined) delete out[key];
      else out[key] = inner;
    } else if (pick(translated.includes(key) ? true : 'duplicate')) {
      if (key in sent) out[key] = sent[key];
      else delete out[key];
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The rows `sync.locale`'s file gets. `from`'s order is the order, minus the rows this
 * language is not one of; a row only `onto` has holds its place behind the last row both
 * sides know, so a block added to German alone stays next to the neighbour it was put after.
 */
function syncRows(
  form: Form,
  fieldsOf: (row: Record<string, unknown>) => readonly Field[] | undefined,
  from: unknown,
  onto: unknown,
  pick: (mode: Translation) => boolean,
  mode: Translation,
  sync: Skeleton,
): unknown[] | undefined {
  if (!Array.isArray(from) && !Array.isArray(onto)) return undefined;
  const sent = Array.isArray(from) ? from : [];
  const rows = Array.isArray(onto) ? onto : [];
  const was = Array.isArray(sync.was) ? sync.was : [];
  const source = sent
    .map((row, i) => ({ row, key: rowKey(row, i) }))
    .filter(({ row }) => inLocale(row, sync.locale));
  const written = new Set(source.map((r) => r.key));
  const edited = new Set(sent.map(rowKey));
  const removed = new Set(was.map(rowKey));
  const before = new Map(was.map((row, i) => [rowKey(row, i), row]));
  const target = new Map(rows.map((row, i) => [rowKey(row, i), row]));
  // The rows this language alone has, filed behind the one they follow — '' being the top.
  const kept = new Map<string, unknown[]>();
  let behind = '';
  for (const [i, row] of rows.entries()) {
    const key = rowKey(row, i);
    if (written.has(key)) behind = key;
    else if (!edited.has(key) && !removed.has(key))
      kept.set(behind, [...(kept.get(behind) ?? []), row]);
  }
  const out: unknown[] = [...(kept.get('') ?? [])];
  for (const { row, key } of source) {
    const fields = isObject(row) ? fieldsOf(row) : undefined;
    const there = target.get(key);
    // A block type the form has never heard of cannot be split into a shared half and a
    // translated one, so the file keeps the row it has and a new one arrives whole.
    out.push(
      fields && isObject(row)
        ? overlay(form, fields, row, skeletonOf(row, there), pick, mode, {
            locale: sync.locale,
            was: before.get(key),
          })
        : (there ?? row),
    );
    out.push(...(kept.get(key) ?? []));
  }
  return out;
}

// `_type`, `_id`, `_label` and `_locales` are the skeleton and come from the language being
// saved; the values under them are the other language's own.
function skeletonOf(source: Record<string, unknown>, target: unknown): Record<string, unknown> {
  const keys = (obj: Record<string, unknown>, reserved: boolean) =>
    Object.entries(obj).filter(([k]) => k.startsWith('_') === reserved);
  return Object.fromEntries([
    ...keys(isObject(target) ? target : {}, false),
    ...keys(source, true),
  ]);
}

/**
 * Every string a machine can be asked to translate, in the order the form draws them and
 * addressed the way `_machine` addresses a field. Prose only: a shared value and one the source
 * language keeps to itself are not translations, and the pickers whose translated half has no
 * editor in the second column yet are left out — a machine's words nobody can see are words
 * nobody can correct, and the badge would never come off.
 */
export function translatableText(
  _siteId: string,
  form: Form,
  data: unknown,
): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  textIn(form, form.fields, data, '', true, found);
  return found;
}

// The same descent `valuesIn` makes, over the fields a person types into.
function textIn(
  form: Form,
  fields: readonly Field[],
  data: unknown,
  at: string,
  inherited: Translation,
  found: { path: string; text: string }[],
): void {
  for (const field of fields) {
    const key = field.path[0];
    if (key === undefined) continue;
    const value = isObject(data) ? data[key] : undefined;
    const path = at ? `${at}.${key}` : key;
    const mode = field.i18n ?? inherited;
    if (field.type === 'group') textIn(form, field.fields, value, path, mode, found);
    else if (field.type === 'blocks')
      textInRows(form, (row) => form.blocks[String(row._type)], value, path, mode, found);
    // Menu labels are the one translated leaf a machine is not offered, though the second
    // column draws them: an empty label is not a gap but "use the page title", and that title
    // is already translated. Filling it would replace the client's answer with a guess at it.
    else if (field.type === 'array' && field.item.some((f) => f.path.length > 0))
      textInRows(form, () => field.item, value, path, mode, found);
    else if (mode !== true) continue;
    else if (field.type === 'text' || field.type === 'richtext') {
      if (typeof value === 'string' && value) found.push({ path, text: value });
    } else if (field.type === 'link') {
      const label = isObject(value) ? value.label : undefined;
      if (typeof label === 'string' && label) found.push({ path: `${path}.label`, text: label });
    }
  }
}

function textInRows(
  form: Form,
  fieldsOf: FieldsOf,
  rows: unknown,
  at: string,
  mode: Translation,
  found: { path: string; text: string }[],
): void {
  if (!Array.isArray(rows)) return;
  for (const [i, row] of rows.entries()) {
    if (!isObject(row)) continue;
    const key = rowKey(row, i);
    const fields = fieldsOf(row);
    if (fields)
      textIn(
        form,
        fields,
        row,
        `${at}[${key.startsWith('#') ? key.slice(1) : `_id=${key}`}]`,
        mode,
        found,
      );
  }
}
