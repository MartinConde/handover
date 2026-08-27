import type { ContentEntry } from './content.js';

// Write order inside an object; everything unprefixed follows in schema order.
export const RESERVED_KEYS = [
  '_version',
  '_type',
  '_id',
  '_label',
  '_ref',
  '_i18n',
  '_locales',
  '_status',
  '_machine',
] as const;

const ID = /^[0-9a-z]{8}$/;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function newId(_siteId: string): string {
  let id = '';
  while (id.length < 8) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1));
    // 252 = 7 × 36: reject the tail so every letter is equally likely.
    if (byte !== undefined && byte < 252) id += ALPHABET[byte % 36];
  }
  return id;
}

// Throws on a reserved key whose shape is wrong; entry-level keys are rejected on blocks and
// vice versa. Unprefixed keys are the schema's business and are not looked at.
export function checkReserved(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) checkReserved(item, `${path}[${i}]`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  const at = (k: string) => (path ? `${path}.${k}` : k);
  const fail = (k: string, want: string) => {
    throw new Error(`${at(k)}: expected ${want}, got ${JSON.stringify(obj[k])}`);
  };
  const top = path === '';
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k === '_version' && (typeof v !== 'number' || !top))
      fail(k, top ? 'a number' : 'no _version below the top level');
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

// Deep copy with a fresh `_id` on every block and array item, and one on an array item that
// never had it — a hand-written template is the file that arrives without any. Pass the same
// `ids` map for each locale file of an entry so the copies keep one shared skeleton.
export function regenerateIds<T>(siteId: string, data: T, ids = new Map<string, string>()): T {
  const renamed = walk(siteId, data, ids) as T;
  const machine = (renamed as { _machine?: string[] })._machine;
  if (machine) {
    (renamed as { _machine: string[] })._machine = machine.map((p) =>
      p.replace(/\[_id=([0-9a-z]+)\]/g, (_m, old: string) => `[_id=${ids.get(old) ?? old}]`),
    );
  }
  return renamed;
}

function walk(siteId: string, value: unknown, ids: Map<string, string>, at = ''): unknown {
  if (Array.isArray(value)) return value.map((v, i) => walk(siteId, v, ids, `${at}[${i}]`));
  if (!value || typeof value !== 'object') return value;
  const copy = Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      if (k !== '_id' || typeof v !== 'string') return [k, walk(siteId, v, ids, `${at}.${k}`)];
      const next = ids.get(v) ?? newId(siteId);
      ids.set(v, next);
      return [k, next];
    }),
  );
  // The identity the editor keys rows on and `_machine` addresses fields through, which the
  // form gives every row it adds. Keyed by where it sits, so the languages of one copy agree
  // about it the way a regenerated one makes them: `rowKey` pairs rows across files by `_id`,
  // and two files inventing their own would read as drift. `stringifyEntry` sorts it to the front.
  if (at.endsWith(']') && typeof copy._id !== 'string')
    copy._id = ids.get(at) ?? ids.set(at, newId(siteId)).get(at);
  return copy;
}

/**
 * Whether a file renders: no `_status`, and — given a locale — one the entry is offered in.
 * The top-level `_locales` is written into every file the entry has, so whichever one is read
 * says the same thing. Called with no locale it is the check it has always been.
 */
export function isLive(_siteId: string, data: unknown, locale?: string): boolean {
  const entry = data as { _status?: unknown; _locales?: unknown } | null;
  if (entry?._status !== undefined) return false;
  if (locale === undefined || !Array.isArray(entry?._locales)) return true;
  return entry._locales.includes(locale);
}

export function filterLive<T>(siteId: string, entries: ContentEntry<T>[]): ContentEntry<T>[] {
  return entries.filter((e) => isLive(siteId, e.data));
}
