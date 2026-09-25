import { Document, isMap, isScalar, isSeq, parse, parseDocument, visit } from 'yaml';
import { checkReserved, RESERVED_KEYS } from './reserved.js';
import { type Field, type FieldsOf, type Form, rowFields, type Translation } from './schema.js';
import { keptMachine } from './translate.js';

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

/** An `_i18n` mark against a language that has gone stays, and reads stale until retranslated. */
export function offeredEntry(
  siteId: string,
  entry: unknown,
  offer: { offered: string[]; locales: string[]; source?: string },
): Record<string, unknown> {
  const written = writtenEntry(siteId, entry);
  const kept = offer.locales.filter((locale) => offer.offered.includes(locale));
  if (kept.length === offer.locales.length) delete written._locales;
  else written._locales = kept;
  return offer.source ? withSource(siteId, written, offer.source) : written;
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

// `ordered()` ranks every `_` key alike, so the position is pinned here.
export function withSource(
  _siteId: string,
  data: unknown,
  locale: string,
): Record<string, unknown> {
  const { _version, _source, ...rest } = isObject(data) ? data : {};
  return { _version: _version ?? FORMAT_VERSION, _source: locale, ...rest };
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

export interface SeedState {
  seeds: Map<string, LocaleSeed>;
  used: Set<LocaleSeed>;
}

const into = (sync: Skeleton | undefined, key: string): Skeleton | undefined =>
  sync && {
    ...sync,
    was: isObject(sync.was) ? sync.was[key] : undefined,
    at: sync.at ? `${sync.at}.${key}` : key,
  };

/** `pick` claims fields from `from`, absent ones included; `sync` takes its structure too. */
export function overlay(
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
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const kind = Array.isArray(data) ? 'an array' : data === null ? 'null' : typeof data;
    throw new Error(`Entry: expected an object, got ${kind}`);
  }
  checkReserved(data);
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

export const rowAddress = (at: string, key: string) =>
  `${at}[${key.startsWith('#') ? key.slice(1) : `_id=${key}`}]`;

/** Here and not in `schema.ts`, which this file imports: rows need `rowKey` and `rowAddress`. */
export function eachRow(
  rows: unknown,
  fieldsOf: FieldsOf,
  at: string,
  visit: (fields: readonly Field[], row: Record<string, unknown>, address: string) => void,
): void {
  if (!Array.isArray(rows)) return;
  for (const [i, row] of rows.entries()) {
    if (!isObject(row)) continue;
    const fields = fieldsOf(row);
    if (fields) visit(fields, row, rowAddress(at, rowKey(row, i)));
  }
}

// A row is written to the languages `_locales` names, and to all of them when it names none.
const inLocale = (row: unknown, locale: string) =>
  !isObject(row) || !Array.isArray(row._locales) || row._locales.includes(locale);

// The written file keeps its own rows and order; the other side supplies values, paired by `_id`.
function pairRows(
  form: Form,
  fieldsOf: FieldsOf,
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
export function overlayProps(
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
  fieldsOf: FieldsOf,
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
    const address = rowAddress(sync.at ?? '', key);
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
export function skeletonOf(
  source: Record<string, unknown>,
  target: unknown,
): Record<string, unknown> {
  const keys = (obj: Record<string, unknown>, reserved: boolean) =>
    Object.entries(obj).filter(([k]) => k.startsWith('_') === reserved);
  return Object.fromEntries([
    ...keys(isObject(target) ? target : {}, false),
    ...keys(source, true),
  ]);
}
