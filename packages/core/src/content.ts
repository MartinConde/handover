import { Document, isMap, isScalar, isSeq, parse, parseDocument, visit } from 'yaml';
import { checkReserved, RESERVED_KEYS } from './reserved.js';
import type { Field, Form, Translation } from './schema.js';

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
    getEntry: (collection, id) =>
      astro.getEntry(collection, id) as Promise<ContentEntry<C[typeof collection]> | undefined>,
    getCollection: async (collection, locale) =>
      (await astro.getCollection(collection)).filter((e) =>
        e.id.startsWith(`${locale}/`),
      ) as ContentEntry<C[typeof collection]>[],
  };
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
  return { _version: FORMAT_VERSION, ...Object.fromEntries(reserved), ...merged };
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
    else if (field.type === 'array' && field.item.some((f) => f.path.length > 0))
      applyRows(form, () => field.item, copies, key, path, mode, ctx);
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
    if (field.type === 'group') driftIn(form, field.fields, under, path, found);
    else if (field.type === 'blocks')
      driftRows(form, (row) => form.blocks[String(row._type)], under, path, found);
    else if (field.type === 'array' && field.item.some((f) => f.path.length > 0))
      driftRows(form, () => field.item, under, path, found);
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
    if (has.join() !== expected.join()) {
      const type = isObject(first) && typeof first._type === 'string' ? first._type : undefined;
      found.push({ path, type, in: has, expected });
    }
    // A row only one file has cannot disagree with anything below it, and a block type the
    // form has never heard of has no rows the CMS knows about either.
    const fields = isObject(first) ? fieldsOf(first) : undefined;
    if (fields && row.length > 1) driftIn(form, fields, row, path, found);
  }
}

// The properties a structured field translates; everything else in one is the same in every
// language. Getting this wrong is what makes clients retype image URLs.
const TRANSLATED_PROPS: Partial<Record<Field['type'], readonly string[]>> = {
  image: ['alt'],
  file: ['name'],
  embed: ['title'],
  link: ['label'],
  seo: ['title', 'description', 'image.alt'],
};

const isObject = (v: unknown): v is Record<string, unknown> =>
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
    } else if (field.type === 'array' && field.item.some((f) => f.path.length > 0)) {
      const rows = pairRows(
        form,
        () => field.item,
        sent[key],
        out[key],
        pick,
        mode,
        into(sync, key),
      );
      if (rows) out[key] = rows;
    } else if (pick(mode)) {
      if (key in sent) out[key] = sent[key];
      else delete out[key];
    }
  }
  return out;
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
const rowKey = (row: unknown, i: number) =>
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
