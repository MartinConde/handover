import { Document, isMap, isScalar, isSeq, parse, parseDocument, visit } from 'yaml';
import type { ContentFile } from './entries.js';
import { blobSha } from './git.js';
import { entryAddress, entryUrl, type I18nRouting } from './names.js';
import { checkReserved, isLive, RESERVED_KEYS } from './reserved.js';
import { type Field, type Form, humanise, rowFields, type Translation } from './schema.js';
import { fieldAddress, fieldPosition, keptMachine } from './translate.js';

export interface ContentEntry<T = unknown> {
  id: string;
  data: T;
}

// What every `load()` in a site's `src/loaders/` takes; ids are `${locale}/${slug}`.
export interface ContentSource<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Set by draftSource for authenticated preview; public sources omit it. */
  readonly preview?: boolean;
  getEntry<K extends keyof C & string>(
    collection: K,
    id: string,
  ): Promise<ContentEntry<C[K]> | undefined>;
  getCollection<K extends keyof C & string>(
    collection: K,
    locale: string,
  ): Promise<ContentEntry<C[K]>[]>;
  /** Unvalidated data for addresses, titles and visibility only; never render content from it. */
  getEntryMetadata?(
    collection: keyof C & string,
    id: string,
  ): Promise<ContentEntry<unknown> | undefined>;
  getCollectionMetadata?(
    collection: keyof C & string,
    locale: string,
  ): Promise<ContentEntry<unknown>[]>;
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
    // Ask the collection first: Astro's `getEntry` logs a miss for every untranslated entry.
    getEntry: async (collection, id) => {
      const all = await astro.getCollection(collection);
      if (!all.some((e) => e.id === id)) return undefined;
      return astro.getEntry(collection, id) as Promise<
        ContentEntry<C[typeof collection]> | undefined
      >;
    },
    getCollection: async (collection, locale) => {
      const all = await astro.getCollection(collection);
      // Without generateId the glob loader files entries under their data `slug`, a 404 everywhere.
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

/** The build's snapshot with the draft rows laid over it; metadata reads skip `validate`. */
export function draftSource<C extends Record<string, unknown>>(
  siteId: string,
  built: ContentSource<C>,
  rows: readonly ContentFile[],
  validate: (collection: string, data: unknown, path: string) => unknown,
): ContentSource<C> {
  const pathOf = (collection: string, id: string) => `src/content/${collection}/${id}.yaml`;
  const byPath = new Map<string, ContentFile>();
  const byCollectionLocale = new Map<string, { id: string; row: ContentFile }[]>();
  for (const row of rows) {
    // Canvas snapshots precede stored drafts, so the first row at a path intentionally wins.
    if (byPath.has(row.path)) continue;
    byPath.set(row.path, row);
    const match = /^src\/content\/([^/]+)\/([^/]+)\/([^/]+)\.yaml$/.exec(row.path);
    if (!match) continue;
    const [, collection, locale, name] = match;
    const key = `${collection}\0${locale}`;
    const found = byCollectionLocale.get(key) ?? [];
    found.push({ id: `${locale}/${name}`, row });
    byCollectionLocale.set(key, found);
  }
  const parsed = new Map<string, unknown>();
  const validated = new Map<string, unknown>();
  const read = <K extends keyof C & string>(
    collection: K,
    id: string,
    contents: string,
    checked: boolean,
  ) => {
    const path = pathOf(collection, id);
    if (!parsed.has(path)) parsed.set(path, parseEntry(siteId, contents));
    const data = parsed.get(path);
    if (checked && !validated.has(path))
      validated.set(path, validate(collection, structuredClone(data), path));
    return { id, data: (checked ? validated.get(path) : data) as C[K] };
  };
  const overlay = (checked: boolean): ContentSource<C> => ({
    preview: true,
    getEntry: async (collection, id) => {
      const row = byPath.get(pathOf(collection, id));
      if (!row) return built.getEntry(collection, id);
      return row.contents ? read(collection, id, row.contents, checked) : undefined;
    },
    getCollection: async (collection, locale) => {
      const mine = byCollectionLocale.get(`${collection}\0${locale}`) ?? [];
      const snapshot = await built.getCollection(collection, locale);
      const drafted = new Map(mine.map((item) => [item.id, item.row]));
      const kept = snapshot.flatMap((e) => {
        const row = drafted.get(e.id);
        if (!row) return [e];
        return row.contents ? [read(collection, e.id, row.contents, checked)] : [];
      });
      // An entry the snapshot has never seen is new since the build, so it goes at the end.
      const builtIds = new Set(snapshot.map((entry) => entry.id));
      const added = mine.filter((item) => item.row.contents && !builtIds.has(item.id));
      return [...kept, ...added.map((m) => read(collection, m.id, m.row.contents, checked))];
    },
  });
  const metadata = overlay(false);
  return {
    ...overlay(true),
    getEntryMetadata: metadata.getEntry,
    getCollectionMetadata: metadata.getCollection,
  };
}

function entryMetadata<C extends Record<string, unknown>>(
  source: ContentSource<C>,
  collection: keyof C & string,
  id: string,
): Promise<ContentEntry<unknown> | undefined> {
  return source.getEntryMetadata
    ? source.getEntryMetadata(collection, id)
    : source.getEntry(collection, id);
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

/** The switcher's languages: a file that exists and is live, never the `_locales` mark. */
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
      const entry = await entryMetadata(source, collection, `${locale}/${slug}`);
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

/** An item whose entry is missing or hidden in this language is dropped, children included. */
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
  // An index is not an entry: the address is this language's index page, or nothing.
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
  const entry = await entryMetadata(source, collection as keyof C & string, `${locale}/${name}`);
  if (!entry || !isLive(siteId, entry.data)) return undefined;
  const of = site.collections[collection];
  const address = of?.localizedSlugs ? entryAddress(siteId, entry.data, name) : name;
  const url = entryUrl(siteId, site.i18n, of?.route, address, locale);
  const titled = isObject(entry.data) ? entry.data[of?.titleField ?? 'title'] : undefined;
  return url ? { href: url, name: typeof titled === 'string' ? titled : name } : undefined;
}

/** With localized slugs a file whose `slug` moved is not served under its file name. */
export async function entryAt<C extends Record<string, unknown>, K extends keyof C & string>(
  siteId: string,
  source: ContentSource<C>,
  site: LocaleSite,
  collection: K,
  locale: string,
  address: string,
): Promise<ContentEntry<C[K]> | undefined> {
  const visible = (entry: ContentEntry<C[K]> | undefined) =>
    entry && (source.preview === true || isLive(siteId, entry.data)) ? entry : undefined;
  if (!site.collections[collection]?.localizedSlugs)
    return visible(await source.getEntry(collection, `${locale}/${address}`));
  // Resolve from metadata first so a slug scan does not validate every page in the language.
  const named = await entryMetadata(source, collection, `${locale}/${address}`);
  if (named && entryAddress(siteId, named.data, address) === address)
    return visible(await source.getEntry(collection, named.id));
  const found = source.getCollectionMetadata
    ? await source.getCollectionMetadata(collection, locale)
    : await source.getCollection(collection, locale);
  const match = found.find(
    (e) => entryAddress(siteId, e.data, e.id.slice(locale.length + 1)) === address,
  );
  return match ? visible(await source.getEntry(collection, match.id)) : undefined;
}

/** Every `_ref` naming an undeclared global: refused at build like an unregistered `_type`. */
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

/** Content a loader requires cannot be rendered; preview reports it as a readable 422. */
export class ContentError extends Error {}

export interface GlobalsSelection {
  /** Globals read directly by the layout, such as site details and navigation. */
  required?: readonly string[];
  /** The tree passed to Blocks; references are discovered through nested arrays and objects. */
  blocks?: unknown;
}

/** Omit selection to read the whole collection; selected globals use validated entry reads. */
export async function globalsAt<C extends Record<string, unknown>>(
  _siteId: string,
  source: ContentSource<C>,
  locale: string,
  selection?: GlobalsSelection,
): Promise<Record<string, unknown>> {
  if (!selection) {
    const found = await source.getCollection('globals' as keyof C & string, locale);
    return Object.fromEntries(found.map((e) => [e.id.slice(locale.length + 1), e.data]));
  }
  const names = new Set(selection.required?.map((name) => name.replace(/^globals\//, '')));
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return;
    const block = value as Record<string, unknown>;
    // Match Blocks: a ref is replaced as a whole, without walking the replacement again.
    if (typeof block._ref === 'string') names.add(block._ref.replace(/^globals\//, ''));
    else Object.values(block).forEach(walk);
  };
  walk(selection.blocks);
  const found = await Promise.all(
    [...names].map(async (name) => {
      const entry = await source.getEntry('globals' as keyof C & string, `${locale}/${name}`);
      if (!entry)
        throw new ContentError(
          `src/content/globals/${locale}/${name}.yaml: No global "${name}" in this language`,
        );
      return [name, entry.data] as const;
    }),
  );
  return Object.fromEntries(found);
}

export function parseEntry(_siteId: string, contents: string): unknown {
  const data: unknown = parse(contents);
  checkReserved(data);
  return data;
}

// Copied from js-yaml's timestamp.js: a plain scalar matching these is a Date to Astro's loader.
const YAML_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const YAML_TIMESTAMP =
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?$/;

// Test the style, not PLAIN, so an unknown scalar style is reported rather than skipped.
const QUOTED = ['QUOTE_DOUBLE', 'QUOTE_SINGLE', 'BLOCK_LITERAL', 'BLOCK_FOLDED'];

/** Every unquoted date, checked before Astro's loader whose own message never mentions quotes. */
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

// Pinned so publish can compare blob SHAs: parse then stringify must return the text unchanged.
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

/** Reserved `_` keys, then schema order, then undeclared keys in the place the file gave them. */
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

/** Every non-editor write stamps `_version` and the canonical key order. */
export function writtenEntry(
  _siteId: string,
  entry: unknown,
  fields: readonly Field[] = [],
): Record<string, unknown> {
  return { _version: FORMAT_VERSION, ...ordered(fields, (entry ?? {}) as Record<string, unknown>) };
}

/** An `_i18n` mark against a language that has gone is dropped: nobody could ever clear it. */
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

// Undeclared keys, `_` keys and fields this locale's form never drew survive a save (decap#6978).
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
  // Typing over a machine value takes its badge off, and only the save can notice.
  const machine = keptMachine(_siteId, entry, out);
  if (machine.length) out._machine = machine;
  else delete out._machine;
  return out;
}

/** One saved locale-owned row that can fill a subtree reintroduced by a structural edit. */
export interface LocaleSeed {
  /** Stable address of the row in the source edit's `after` tree. */
  address: string;
  /** The same row as this locale last knew it, including translated and opaque values. */
  value: unknown;
  /** Entry-level `_machine` paths scoped to this row. */
  machine?: readonly string[];
}

export interface LocaleSyncOptions {
  /** Seeds are considered only for rows absent from both source-before and this target. */
  seeds?: readonly LocaleSeed[];
}

/** The skeleton follows `after`; rows only `target` has stay put, as drift is somebody's call. */
export function syncLocale(
  siteId: string,
  form: Form,
  locale: string,
  edit: { before: unknown; after: unknown },
  target: unknown,
  options: LocaleSyncOptions = {},
): Record<string, unknown> {
  const seeds = seedMap(options.seeds ?? []);
  const state: SeedState = { seeds, used: new Set() };
  const synced = overlay(form, form.fields, edit.after, target, (m) => m === 'duplicate', true, {
    locale,
    was: edit.before,
    at: '',
    state,
  });
  const out: Record<string, unknown> = { _version: FORMAT_VERSION, ...synced };
  delete out._machine;

  // Structural changes can remove a marked subtree. Existing marks survive only while their
  // translated string does; new marks additionally have to be proven by the accepted seed.
  const translated = new Set(translatedValues(form, out).map(([path]) => path));
  const machine = keptMachine(siteId, target, out).filter(
    (path) => translatedString(siteId, form, out, path, translated) !== undefined,
  );
  const marked = new Set(machine);
  for (const seed of state.used)
    for (const path of seed.machine ?? []) {
      if (marked.has(path)) continue;
      const prefix = `${seed.address}.`;
      if (!path.startsWith(prefix)) continue;
      const seeded = valueAt(siteId, seed.value, path.slice(prefix.length));
      const current = translatedString(siteId, form, out, path, translated);
      if (typeof seeded !== 'string' || current !== seeded) continue;
      machine.push(path);
      marked.add(path);
    }
  if (machine.length) out._machine = machine;
  return out;
}

/** Project one non-structural field without walking either locale's complete document. */
export function syncLocaleField(
  field: Field,
  mode: Translation,
  source: unknown,
  target: unknown,
): unknown {
  if (mode === 'duplicate') return source;
  const translated = TRANSLATED_PROPS[field.type];
  return mode === true && translated
    ? overlayProps(source, target, translated, (candidate) => candidate === 'duplicate')
    : target;
}

function translatedString(
  siteId: string,
  form: Form,
  root: unknown,
  address: string,
  translated: ReadonlySet<string>,
): string | undefined {
  const position = fieldPosition(siteId, address, root, form);
  const canonical = position && fieldAddress(siteId, position, root, form);
  const value =
    canonical && translated.has(canonical) ? valueAt(siteId, root, address, form) : undefined;
  return typeof value === 'string' ? value : undefined;
}

function valueAt(siteId: string, root: unknown, address: string, form?: Form): unknown {
  const position = fieldPosition(siteId, address, root, form);
  return position?.reduce<unknown>(
    (value, key) =>
      Array.isArray(value) ? value[Number(key)] : isObject(value) ? value[key] : undefined,
    root,
  );
}

/** One row of drift as somebody answered it: the languages it should end up in. */
export interface DriftChoice {
  /** The row's `path` in the report it came from. */
  path: string;
  /** Empty takes the row out of every file. */
  locales: string[];
}

/** `_locales` is rewritten only where the answer differs from what the mark already said. */
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

/** A file the answer names gets the row behind the last row before it that this file also has. */
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
  // A language the mark names but has no file cannot disagree, so the answer keeps it.
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

// A row arriving in a file that lacked it: shared values, skeleton, and its neighbours' place.
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

/** The mark a translation carries: the source language, and that language as it stood. */
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

/** A source language moving on makes the mark disagree: stale is a warning, never a refusal. */
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

/** A file with no `_i18n`, no hash, or a source the entry has no file in is never stale. */
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

// Sixteen characters of `blobSha` over the values, for want of another hash in the bundle.
const hashOf = async (form: Form, data: unknown) =>
  (
    await blobSha(
      translatedValues(form, data)
        .map(([path, value]) => `${path}=${value}`)
        .join('\n'),
    )
  ).slice(0, 16);

/** Translated leaves sorted by `_machine` address, so moving a block is not a change. */
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

/** Rows the languages disagree about; a publish is refused while one stands. */
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

// The same descent `overlay` makes.
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

/** Prose only: the reconciliation panel shows words, and nobody decides between two numbers. */
function rowWords(fields: readonly Field[], data: unknown, found: string[]): void {
  for (const field of fields) {
    const value = isObject(data) ? data[field.path[0] ?? ''] : undefined;
    if (field.type === 'group') rowWords(field.fields, value, found);
    else if ((field.type === 'text' || field.type === 'richtext') && typeof value === 'string')
      found.push(value);
  }
}

// Getting this wrong is what makes clients retype image URLs.
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
  /** Stable address of the field whose rows are being synchronized. */
  at?: string;
  state?: SeedState;
}

interface SeedState {
  seeds: Map<string, LocaleSeed>;
  used: Set<LocaleSeed>;
}

function seedMap(seeds: readonly LocaleSeed[]): Map<string, LocaleSeed> {
  const unique = new Map<string, LocaleSeed>();
  const repeated = new Set<string>();
  for (const seed of seeds) {
    if (repeated.has(seed.address)) continue;
    if (unique.has(seed.address)) {
      unique.delete(seed.address);
      repeated.add(seed.address);
    } else unique.set(seed.address, seed);
  }
  return unique;
}

const into = (sync: Skeleton | undefined, key: string): Skeleton | undefined =>
  sync && {
    ...sync,
    was: isObject(sync.was) ? sync.was[key] : undefined,
    at: sync.at ? `${sync.at}.${key}` : key,
  };

/** `pick` claims fields from `from`, absent ones included; `sync` takes its structure too. */
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
  // Re-order so a key this walk added does not land after the translated ones.
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

// The yaml library drops `|` for a quoted string on trailing spaces or newlines, changing bytes.
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

// The written file keeps its own rows and order; the other side supplies values, paired by `_id`.
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

// An image's `alt` is translated and its `src` shared, so one field is written from two files.
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

/** A row only `onto` has holds its place behind the last row both sides know. */
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
    const address = `${sync.at ?? ''}[${key.startsWith('#') ? key.slice(1) : `_id=${key}`}]`;
    const candidate =
      sync.state && !key.startsWith('#') && !before.has(key) && there === undefined
        ? sync.state.seeds.get(address)
        : undefined;
    const seed = candidate && seedMatches(candidate, row, key) ? candidate : undefined;
    if (seed) sync.state?.used.add(seed);
    const localeRow = there ?? seed?.value;
    // An unknown block type cannot be split, so the file keeps its row and a new one arrives whole.
    out.push(
      fields && isObject(row)
        ? overlay(form, fields, row, skeletonOf(row, localeRow), pick, mode, {
            locale: sync.locale,
            was: before.get(key),
            at: address,
            state: sync.state,
          })
        : (there ?? row),
    );
    out.push(...(kept.get(key) ?? []));
  }
  return out;
}

function seedMatches(seed: LocaleSeed, source: unknown, key: string): boolean {
  if (!isObject(seed.value) || seed.value._id !== key || !isObject(source)) return false;
  return typeof source._type !== 'string' || seed.value._type === source._type;
}

// The `_` keys are the skeleton and come from the saved language; values are the other's own.
function skeletonOf(source: Record<string, unknown>, target: unknown): Record<string, unknown> {
  const keys = (obj: Record<string, unknown>, reserved: boolean) =>
    Object.entries(obj).filter(([k]) => k.startsWith('_') === reserved);
  return Object.fromEntries([
    ...keys(isObject(target) ? target : {}, false),
    ...keys(source, true),
  ]);
}

/** Only leaves the second column draws: a machine's words nobody sees are never corrected. */
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
    // An empty menu label means "use the page title", which is already translated.
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
