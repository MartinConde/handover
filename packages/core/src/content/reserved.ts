import type { ContentEntry } from './content.js';

// Write order inside an object; everything unprefixed follows in schema order.
export const RESERVED_KEYS = [
  '_version',
  '_source',
  '_type',
  '_id',
  '_label',
  '_ref',
  '_i18n',
  '_locales',
  '_status',
  '_machine',
] as const;

/** An entry's data has a shape the files cannot hold; the editor shows its message. */
export class EntryShapeError extends Error {}

const ID = /^[0-9a-z]{8}$/;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function newId(): string {
  let id = '';
  while (id.length < 8) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1));
    // 252 = 7 × 36: reject the tail so every letter is equally likely.
    if (byte !== undefined && byte < 252) id += ALPHABET[byte % 36];
  }
  return id;
}

// Entry-level keys stay out of rows, and row IDs stay unambiguous inside each addressed list.
export function checkReserved(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    const identities = new Map<string, string>();
    for (const [i, item] of value.entries()) {
      const itemPath = `${path}[${i}]`;
      checkReserved(item, itemPath);
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const id = (item as Record<string, unknown>)._id;
      if (typeof id !== 'string') continue;
      const first = identities.get(id);
      if (first)
        throw new EntryShapeError(
          `${itemPath}._id: duplicate row identity ${JSON.stringify(id)}; already used at ${first}._id. Give each row in ${path || 'this collection'} a unique _id and keep matching IDs aligned across locale files.`,
        );
      identities.set(id, itemPath);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  const at = (k: string) => (path ? `${path}.${k}` : k);
  const fail = (k: string, want: string) => {
    throw new EntryShapeError(`${at(k)}: expected ${want}, got ${JSON.stringify(obj[k])}`);
  };
  const top = path === '';
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k === '_version' && (typeof v !== 'number' || !top))
      fail(k, top ? 'a number' : 'no _version below the top level');
    if (k === '_source' && (!top || typeof v !== 'string' || !v))
      fail(k, top ? 'a locale code' : 'no _source below the top level');
    if (k === '_status' && (v !== 'hidden' || !top))
      fail(k, top ? '"hidden" or no key' : 'no _status below the top level');
    if (k === '_machine' && (!top || !isStringArray(v)))
      fail(k, top ? 'a list of field paths' : 'no _machine below the top level');
    if (k === '_i18n' && (!top || !v || typeof v !== 'object' || Array.isArray(v)))
      fail(k, top ? 'an object' : 'no _i18n below the top level');
    if (k === '_id' && (typeof v !== 'string' || !ID.test(v)))
      fail(k, 'eight characters from 0-9a-z');
    // On the entry, the languages it is offered in; on a row, the files it is written to.
    if (k === '_locales' && (!isStringArray(v) || v.length === 0))
      fail(k, 'a non-empty list of locales');
    if ((k === '_type' || k === '_label' || k === '_ref') && typeof v !== 'string')
      fail(k, 'a string');
    if (v && typeof v === 'object') checkReserved(v, at(k));
  }
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');

// Pass the same `ids` map for each locale file of an entry so the copies share one skeleton.
export function regenerateIds<T>(data: T, ids = new Map<string, string>()): T {
  const renamed = walk(data, ids) as T;
  const machine = (renamed as { _machine?: string[] })._machine;
  if (machine) {
    (renamed as { _machine: string[] })._machine = machine.map((p) =>
      p.replace(/\[_id=([0-9a-z]+)\]/g, (_m, old: string) => `[_id=${ids.get(old) ?? old}]`),
    );
  }
  return renamed;
}

function walk(value: unknown, ids: Map<string, string>, at = ''): unknown {
  if (Array.isArray(value)) return value.map((v, i) => walk(v, ids, `${at}[${i}]`));
  if (!value || typeof value !== 'object') return value;
  const copy = Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      if (k !== '_id' || typeof v !== 'string') return [k, walk(v, ids, `${at}.${k}`)];
      const next = ids.get(v) ?? newId();
      ids.set(v, next);
      return [k, next];
    }),
  );
  // Keyed by position, so the languages of one copy agree on the id instead of reading as drift.
  if (at.endsWith(']') && typeof copy._id !== 'string')
    copy._id = ids.get(at) ?? ids.set(at, newId()).get(at);
  return copy;
}

/** `_locales` is written into every file the entry has, so whichever is read says the same. */
export function isLive(data: unknown, locale?: string): boolean {
  const entry = data as { _status?: unknown; _locales?: unknown } | null;
  if (entry?._status !== undefined) return false;
  if (locale === undefined || !Array.isArray(entry?._locales)) return true;
  return entry._locales.includes(locale);
}

export function filterLive<T>(entries: ContentEntry<T>[]): ContentEntry<T>[] {
  return entries.filter((e) => isLive(e.data));
}
