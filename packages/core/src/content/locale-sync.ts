import {
  FORMAT_VERSION,
  isObject,
  type LocaleSeed,
  overlay,
  overlayProps,
  rowKey,
  type SeedState,
  skeletonOf,
  TRANSLATED_PROPS,
} from './entry-format.js';
import { type FieldsOf, translatedValues } from './provenance.js';
import { type Field, type Form, rowFields, type Translation } from './schema.js';
import { fieldAddress, fieldPosition, keptMachine } from './translate.js';

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
