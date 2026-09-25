import { blobSha } from '../publishing/git.js';
import { isObject, overlay, parseEntry, stringifyEntry, withSource } from './entry-format.js';
import { translatedValues, valuesIn } from './field-text.js';
import type { I18nRouting } from './names.js';
import type { Form } from './schema.js';

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
