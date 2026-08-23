import { Document, isMap, isScalar, isSeq, parse, parseDocument, visit } from 'yaml';
import { checkReserved, RESERVED_KEYS } from './reserved.js';

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
export function mergeEntry(
  _siteId: string,
  entry: unknown,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const reserved = Object.entries((entry ?? {}) as Record<string, unknown>).filter(([k]) =>
    k.startsWith('_'),
  );
  return { _version: FORMAT_VERSION, ...Object.fromEntries(reserved), ...values };
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
