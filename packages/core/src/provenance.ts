import {
  isObject,
  overlay,
  parseEntry,
  rowKey,
  stringifyEntry,
  TRANSLATED_PROPS,
  withSource,
} from './entry-format.js';
import { blobSha } from './git.js';
import type { I18nRouting } from './names.js';
import { hasWords } from './richtext.js';
import { type Field, type Form, rowFields, type Translation } from './schema.js';

/** The mark a translation carries: the source language, and that language as it stood. */
export interface I18nMark {
  sourceLocale: string;
  /** Git blob SHA of the source language's file the translation was made from. */
  sourceBlob: string;
  /** Hash of the values that file was translated from; two of these agreeing is "not stale". */
  sourceHash: string;
  translatedAt: string;
}

/** One immutable source-language snapshot a translation was based on. */
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
  preserveStampedSource = false,
): Promise<string> {
  const data = parseEntry(siteId, contents);
  if (!isObject(data)) return contents;
  const before = new Map(was ? translatedValues(form, parseEntry(siteId, was)) : []);
  const after = new Map(translatedValues(form, data));
  const typed =
    before.size !== after.size ||
    [...after].some(([path, value]) => !before.has(path) || before.get(path) !== value);
  if (was !== undefined && !typed) return contents;
  // API saves stamp the exact source snapshot the translator saw. Publishing must carry that
  // mark forward instead of silently replacing it with a source that moved in the meantime.
  const stamped = completeMark(data._i18n);
  const previousData = was === undefined ? undefined : parseEntry(siteId, was);
  const previous = completeMark(isObject(previousData) ? previousData._i18n : undefined);
  if (preserveStampedSource && stamped && !sameMark(stamped, previous)) return contents;
  const mark: I18nMark = {
    sourceLocale: source.locale,
    sourceBlob: source.blob_sha,
    sourceHash: await hashOf(form, parseEntry(siteId, source.contents)),
    translatedAt: new Date().toISOString(),
  };
  return stringifyEntry(siteId, { ...data, _i18n: mark });
}

const completeMark = (value: unknown): I18nMark | undefined => {
  if (!isObject(value)) return undefined;
  const { sourceLocale, sourceBlob, sourceHash, translatedAt } = value;
  return typeof sourceLocale === 'string' &&
    typeof sourceBlob === 'string' &&
    typeof sourceHash === 'string' &&
    typeof translatedAt === 'string'
    ? { sourceLocale, sourceBlob, sourceHash, translatedAt }
    : undefined;
};

const sameMark = (left: I18nMark, right: I18nMark | undefined) =>
  right !== undefined &&
  left.sourceLocale === right.sourceLocale &&
  left.sourceBlob === right.sourceBlob &&
  left.sourceHash === right.sourceHash &&
  left.translatedAt === right.translatedAt;

/** The language an entry is written in, or why its files cannot say. */
export type EntrySource =
  | { locale: string; recorded: boolean }
  | { problem: 'conflict' | 'undeclared' | 'missing'; marks: Record<string, string> };

/** `files` is each declared language's effective data; an unmarked file agrees with a marked one. */
export function entrySource(
  _siteId: string,
  i18n: Pick<I18nRouting, 'locales' | 'defaultLocale'>,
  files: Record<string, unknown>,
): EntrySource | undefined {
  const present = i18n.locales.filter((locale) => files[locale] !== undefined);
  if (i18n.locales.length < 2)
    return present.includes(i18n.defaultLocale)
      ? { locale: i18n.defaultLocale, recorded: false }
      : undefined;
  if (!present.length) return undefined;
  const marks: Record<string, string> = {};
  for (const locale of present) {
    const data = files[locale];
    if (isObject(data) && typeof data._source === 'string') marks[locale] = data._source;
  }
  const values = [...new Set(Object.values(marks))];
  if (values.length > 1) return { problem: 'conflict', marks };
  const [value] = values;
  if (value !== undefined) {
    if (!i18n.locales.includes(value)) return { problem: 'undeclared', marks };
    if (!present.includes(value)) return { problem: 'missing', marks };
    return { locale: value, recorded: true };
  }
  // Unrecorded: the only answer that depends on the configuration, as the baseline gave it.
  const order = [...new Set([i18n.defaultLocale, ...i18n.locales])];
  const locale = order.find((l) => present.includes(l));
  return locale === undefined ? undefined : { locale, recorded: false };
}

// Every file's `_i18n` once `to` is the source; marks move only when `from` and `to` are in sync.
// `blob` is `to`'s file as written, `at` the time for a mark `from` did not already have.
export async function provenance(
  _siteId: string,
  form: Form,
  files: Record<string, unknown>,
  change: { from: string; to: string; blob: string; at: string },
): Promise<Record<string, unknown>> {
  const { from, to } = change;
  const markOf = (locale: string) => {
    const data = files[locale];
    return completeMark(isObject(data) ? data._i18n : undefined);
  };
  const hashes = new Map<string, Promise<string>>();
  const hash = (locale: string) => {
    if (!hashes.has(locale)) hashes.set(locale, hashOf(form, files[locale]));
    return hashes.get(locale) as Promise<string>;
  };
  const inSync = async (locale: string, of: string) => {
    const mark = markOf(locale);
    return (
      mark?.sourceLocale === of && files[of] !== undefined && mark.sourceHash === (await hash(of))
    );
  };
  const out: Record<string, unknown> = {};
  for (const [locale, data] of Object.entries(files))
    out[locale] = isObject(data) ? data._i18n : undefined;
  out[to] = undefined;
  if (files[from] === undefined || files[to] === undefined) return out;
  const fromMarked = await inSync(from, to);
  if (!fromMarked && !(await inSync(to, from))) return out;
  const rebased = async (translatedAt: string): Promise<I18nMark> => ({
    sourceLocale: to,
    sourceBlob: change.blob,
    sourceHash: await hash(to),
    translatedAt,
  });
  for (const locale of Object.keys(files)) {
    const own = markOf(locale)?.translatedAt;
    if (locale !== from && locale !== to && own && (await inSync(locale, from)))
      out[locale] = await rebased(own);
  }
  out[from] = await rebased((fromMarked && markOf(from)?.translatedAt) || change.at);
  return out;
}

const EMPTY = new Set(['""', 'null', '[]', '{}']);

/** Source-only values `target` holds that are not the source's; taking the source's would lose them. */
export function sourceOnlyConflicts(form: Form, source: unknown, target: unknown): string[] {
  const values = (data: unknown) => {
    const found: [string, string][] = [];
    valuesIn(form, form.fields, data, '', true, found, false);
    return new Map(found);
  };
  const theirs = values(source);
  return [...values(target)]
    .filter(([path, value]) => !EMPTY.has(value) && theirs.get(path) !== value)
    .map(([path]) => path);
}

/** Every file once `to` is the source; without `from` (recovery) files are only stamped. */
export async function changeSource(
  siteId: string,
  form: Form,
  files: Record<string, unknown>,
  change: { from?: string; to: string; at: string },
): Promise<Record<string, Record<string, unknown>>> {
  const { from, to } = change;
  const target = isObject(files[to]) ? files[to] : {};
  const taken =
    from === undefined
      ? { ...target }
      : overlay(form, form.fields, files[from], target, (m) => m !== true, true);
  delete taken._i18n;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [locale, data] of Object.entries(files))
    out[locale] = withSource(siteId, locale === to ? taken : data, to);
  if (from === undefined) return out;
  // Handed its old mark back: that is what says whether the two languages are in sync.
  const marks = await provenance(
    siteId,
    form,
    { ...files, [to]: { ...out[to], _i18n: target._i18n } },
    { from, to, blob: await blobSha(stringifyEntry(siteId, out[to])), at: change.at },
  );
  for (const [locale, mark] of Object.entries(marks)) {
    const file = out[locale];
    if (!file || locale === to) continue;
    if (mark === undefined) delete file._i18n;
    else file._i18n = mark;
  }
  return out;
}

/** Stale: a complete mark naming another language than the source, or the source as it no longer is. */
export async function staleLocales(
  _siteId: string,
  form: Form,
  files: Record<string, unknown>,
  source: string,
): Promise<string[]> {
  let hash: Promise<string> | undefined;
  const stale: string[] = [];
  for (const [locale, data] of Object.entries(files)) {
    const mark = completeMark(isObject(data) ? data._i18n : undefined);
    if (locale === source || !mark) continue;
    if (mark.sourceLocale !== source) {
      stale.push(locale);
      continue;
    }
    hash ??= hashOf(form, files[source]);
    if ((await hash) !== mark.sourceHash) stale.push(locale);
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

export type FieldsOf = (row: Record<string, unknown>) => readonly Field[] | undefined;

// The same descent `driftIn` and `overlay` make.
function valuesIn(
  form: Form,
  fields: readonly Field[],
  data: unknown,
  at: string,
  inherited: Translation,
  found: [string, string][],
  want: Translation = true,
): void {
  for (const field of fields) {
    const key = field.path[0];
    if (key === undefined) continue;
    const value = isObject(data) ? data[key] : undefined;
    const path = at ? `${at}.${key}` : key;
    const mode = field.i18n ?? inherited;
    const props = TRANSLATED_PROPS[field.type];
    const row = rowFields(field);
    if (field.type === 'group') valuesIn(form, field.fields, value, path, mode, found, want);
    else if (props && mode === true && want === true)
      for (const prop of props) {
        const inner = prop
          .split('.')
          .reduce<unknown>((v, k) => (isObject(v) ? v[k] : undefined), value);
        if (inner !== undefined) found.push([`${path}.${prop}`, JSON.stringify(inner)]);
      }
    else if (field.type === 'blocks')
      valuesInRows(form, (row) => form.blocks[String(row._type)], value, path, mode, found, want);
    else if (row) valuesInRows(form, () => row, value, path, mode, found, want);
    else if (mode === want && value !== undefined) found.push([path, JSON.stringify(value)]);
  }
}

function valuesInRows(
  form: Form,
  fieldsOf: FieldsOf,
  rows: unknown,
  at: string,
  mode: Translation,
  found: [string, string][],
  want: Translation,
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
        want,
      );
  }
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

/** How much of the source's own words `target` answers; a metric, not publish readiness. */
export function answeredText(
  siteId: string,
  form: Form,
  source: unknown,
  target: unknown,
  locale: string,
): { written: number; of: number } {
  return answeredCount(
    answeredPaths(siteId, form, source),
    answeredPaths(siteId, form, target),
    locale,
  );
}

/** A file's answered text paths; `rows` holds the `_locales` of each row that names some. */
export interface AnsweredPaths {
  paths: string[];
  rows?: Record<string, string[]>;
}

/** Every language at once, so a build can keep it and count any pair later. */
export function answeredPaths(_siteId: string, form: Form, data: unknown): AnsweredPaths {
  const rows: Record<string, string[]> = {};
  const paths = [...answeredIn(form, form.fields, data, '', true, rows, new Map(), []).keys()];
  return Object.keys(rows).length ? { paths, rows } : { paths };
}

/** What `locale`'s file says at each answered path, and the rows it has, so a gap reads as one. */
export function referenceText(
  _siteId: string,
  form: Form,
  data: unknown,
  locale: string,
): { values: Record<string, string>; rows: string[] } {
  const locales: Record<string, string[]> = {};
  const present: string[] = [];
  const values = Object.fromEntries(
    answeredIn(form, form.fields, data, '', true, locales, new Map(), present),
  );
  const elsewhere = Object.keys(locales).filter((row) => !locales[row]?.includes(locale));
  const rows = present.filter(
    (row) => !elsewhere.some((out) => row === out || row.startsWith(`${out}.`)),
  );
  return { values, rows };
}

export function answeredCount(
  source: AnsweredPaths,
  target: AnsweredPaths,
  locale: string,
): { written: number; of: number } {
  const { paths, unanswered } = answeredWork(source, target, locale);
  return { written: paths.length - unanswered.length, of: paths.length };
}

/** What a language owes: the source paths it is asked for, and those its file leaves empty. */
export function answeredWork(
  source: AnsweredPaths,
  target: AnsweredPaths,
  locale: string,
): { paths: string[]; unanswered: string[] } {
  // A path under a row written to other languages is nobody's work in this one.
  const within = ({ paths, rows = {} }: AnsweredPaths) =>
    paths.filter((path) =>
      Object.entries(rows).every(([row, to]) => to.includes(locale) || !path.startsWith(`${row}.`)),
    );
  const paths = within(source);
  const answered = new Set(within(target));
  return { paths, unanswered: paths.filter((path) => !answered.has(path)) };
}

// Not `rowFields`: a blank menu label means "use the page title", so it is never owed.
function answeredIn(
  form: Form,
  fields: readonly Field[],
  data: unknown,
  at: string,
  inherited: Translation,
  rows: Record<string, string[]>,
  found: Map<string, string>,
  present: string[],
): Map<string, string> {
  for (const field of fields) {
    const key = field.path[0];
    if (key === undefined) continue;
    const value = isObject(data) ? data[key] : undefined;
    const path = at ? `${at}.${key}` : key;
    const mode = field.i18n ?? inherited;
    if (field.type === 'group')
      answeredIn(form, field.fields, value, path, mode, rows, found, present);
    else if (field.type === 'blocks' || field.type === 'array') {
      const scalar =
        field.type === 'array' && field.item[0]?.path.length === 0 ? field.item[0] : undefined;
      for (const [i, row] of (Array.isArray(value) ? value : []).entries()) {
        if (scalar) {
          present.push(`${path}[${i}]`);
          answeredAt(scalar, row, `${path}[${i}]`, scalar.i18n ?? mode, found);
        }
        if (scalar || !isObject(row)) continue;
        const id = rowKey(row, i);
        const inner = field.type === 'blocks' ? form.blocks[String(row._type)] : field.item;
        const rowAt = `${path}[${id.startsWith('#') ? id.slice(1) : `_id=${id}`}]`;
        present.push(rowAt);
        if (Array.isArray(row._locales)) rows[rowAt] = row._locales.map(String);
        if (inner) answeredIn(form, inner, row, rowAt, mode, rows, found, present);
      }
    } else answeredAt(field, value, path, mode, found);
  }
  return found;
}

function answeredAt(
  field: Field,
  value: unknown,
  path: string,
  mode: Translation,
  found: Map<string, string>,
): void {
  if (mode !== true) return;
  if (field.type === 'text' || field.type === 'richtext') {
    if (typeof value !== 'string') return;
    if (field.type === 'text' ? value.trim() : hasWords(value)) found.set(path, value);
    return;
  }
  for (const prop of TRANSLATED_PROPS[field.type] ?? []) {
    const inner = prop
      .split('.')
      .reduce<unknown>((v, k) => (isObject(v) ? v[k] : undefined), value);
    if (typeof inner === 'string' && inner.trim()) found.set(`${path}.${prop}`, inner);
  }
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
