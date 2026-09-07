import { isObject, rowKey, TRANSLATED_PROPS, translatedValues } from './content.js';
import { type Field, type Form, humanise, rowFields, type Translation } from './schema.js';

export interface WordPart {
  text: string;
  mark?: 'del' | 'ins';
}

export type RowAt = 'added' | 'removed' | 'moved-up' | 'moved-down' | 'same';

export type Change = { path: string; label: string } & (
  | { kind: 'words'; parts: WordPart[] }
  | { kind: 'value'; before?: string; after?: string }
  /** Two keys into storage, never a value that moved. */
  | { kind: 'picture'; before?: string; after?: string }
  | { kind: 'whole' }
  | { kind: 'row'; type?: string; at: RowAt; above?: string; changes: Change[] }
);

export interface DiffGroup {
  /** Absent on the shared group. */
  locale?: string;
  /** One event, not a deletion per field. */
  removed?: true;
  changes: Change[];
}

type Wants = (mode: Translation) => boolean;

/** The walk is the schema's, so marks like `_i18n` are never a change. */
export function diffEntry(
  _siteId: string,
  form: Form,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): DiffGroup[] {
  const gone = Object.keys(before).filter((l) => !(l in after));
  const locales = [...Object.keys(after), ...gone];
  if (locales.length === 0) return [];
  const shared = locales.length > 1;
  const groups: DiffGroup[] = [];
  if (shared) {
    // Every surviving file is read: a shared value moved in one file alone is what this catches.
    const seen = new Set<string>();
    const changes: Change[] = [];
    for (const locale of locales)
      if (!gone.includes(locale))
        for (const change of walk(form, before[locale], after[locale], (m) => m === 'duplicate'))
          if (!seen.has(change.path)) {
            seen.add(change.path);
            changes.push(change);
          }
    groups.push({ changes });
  }
  for (const locale of locales)
    groups.push(
      gone.includes(locale)
        ? { locale, removed: true, changes: [] }
        : {
            locale,
            changes: walk(form, before[locale], after[locale], (m) => !shared || m !== 'duplicate'),
          },
    );
  return groups;
}

const walk = (form: Form, before: unknown, after: unknown, wants: Wants): Change[] => {
  const found: Change[] = [];
  changesIn(form, form.fields, before, after, '', '', true, wants, found);
  return found;
};

// `at` addresses a value the way `_machine` does; `named` is what a reader sees.
function changesIn(
  form: Form,
  fields: readonly Field[],
  before: unknown,
  after: unknown,
  at: string,
  named: string,
  inherited: Translation,
  wants: Wants,
  found: Change[],
): void {
  for (const field of fields) {
    const key = field.path[0];
    if (key === undefined) continue;
    const was = isObject(before) ? before[key] : undefined;
    const now = isObject(after) ? after[key] : undefined;
    const path = at ? `${at}.${key}` : key;
    const label = named ? `${named} · ${field.label}` : field.label;
    const mode = field.i18n ?? inherited;
    const item = rowFields(field);
    if (field.type === 'group')
      changesIn(form, field.fields, was, now, path, label, mode, wants, found);
    else if (field.type === 'blocks')
      rowsIn(form, (row) => form.blocks[String(row._type)], was, now, path, mode, wants, found);
    else if (item) rowsIn(form, () => item, was, now, path, mode, wants, found);
    else leafIn(field, was, now, path, label, mode, wants, found);
  }
}

/** Only the properties a translator retypes are the language's. */
function leafIn(
  field: Field,
  before: unknown,
  after: unknown,
  path: string,
  label: string,
  mode: Translation,
  wants: Wants,
  found: Change[],
): void {
  const translated = TRANSLATED_PROPS[field.type];
  if (translated && (isObject(before) || isObject(after))) {
    propsIn(field, translated, before, after, path, label, [], mode, wants, found);
    return;
  }
  if (!wants(mode) || show(before) === show(after)) return;
  if (field.type === 'text' || field.type === 'array')
    found.push({ path, label, kind: 'words', parts: wordDiff(str(before), str(after)) });
  else if (field.type === 'unsupported' && (linkTarget(before) || linkTarget(after)))
    found.push({
      path,
      label,
      kind: 'value',
      before: linkTarget(before),
      after: linkTarget(after),
    });
  else if (field.type === 'richtext' || field.type === 'unsupported')
    found.push({ path, label, kind: 'whole' });
  else found.push({ path, label, kind: 'value', before: show(before), after: show(after) });
}

function propsIn(
  field: Field,
  translated: readonly string[],
  before: unknown,
  after: unknown,
  path: string,
  label: string,
  under: string[],
  mode: Translation,
  wants: Wants,
  found: Change[],
): void {
  const keys = [
    ...Object.keys(isObject(before) ? before : {}),
    ...Object.keys(isObject(after) ? after : {}).filter((k) => !(isObject(before) && k in before)),
  ].filter((k) => !k.startsWith('_'));
  // A replaced picture is two keys, not a moved value, and its size is never a change of its own.
  const picture =
    field.type === 'image'
      ? under.length === 0
      : field.type === 'seo' && under.join('.') === 'image';
  for (const key of keys) {
    if (picture && (key === 'width' || key === 'height')) continue;
    const was = isObject(before) ? before[key] : undefined;
    const now = isObject(after) ? after[key] : undefined;
    const inner = [...under, key];
    const to = `${path}.${inner.join('.')}`;
    if (isObject(was) || isObject(now)) {
      propsIn(field, translated, was, now, path, label, inner, mode, wants, found);
      continue;
    }
    // Shared unless the property is a translated one of a translated field.
    const own: Translation =
      mode === true && !translated.includes(inner.join('.')) ? 'duplicate' : mode;
    if (!wants(own) || show(was) === show(now)) continue;
    if (picture && key === 'src')
      found.push({
        path: to,
        label: [label, ...under.map(humanise)].join(' · '),
        kind: 'picture',
        ...(typeof was === 'string' ? { before: was } : {}),
        ...(typeof now === 'string' ? { after: now } : {}),
      });
    else
      found.push({
        path: to,
        label: [label, ...inner.map(humanise)].join(' · '),
        kind: 'value',
        before: show(was),
        after: show(now),
      });
  }
}

/** Keyed by `_id` so a moved block says so; rows without one pair by position and never move. */
function rowsIn(
  form: Form,
  fieldsOf: (row: Record<string, unknown>) => readonly Field[] | undefined,
  before: unknown,
  after: unknown,
  at: string,
  mode: Translation,
  wants: Wants,
  found: Change[],
): void {
  const was = keyed(before);
  const now = keyed(after);
  const moved = movers([...was.keys()], [...now.keys()]);
  const nowKeys = [...now.keys()];
  const rows: Change[] = [];
  for (const [i, key] of nowKeys.entries()) {
    const row = now.get(key);
    const old = was.get(key);
    const changes: Change[] = [];
    if (old !== undefined)
      changesIn(
        form,
        fieldsOf(asRow(row)) ?? [],
        old,
        row,
        rowAddress(at, key),
        '',
        mode,
        wants,
        changes,
      );
    const at_ = old === undefined ? 'added' : (moved.get(key) ?? 'same');
    const shown = wants(mode) ? at_ : 'same';
    if (shown === 'same' && changes.length === 0) continue;
    const above = nowKeys[i + 1];
    rows.push({
      path: rowAddress(at, key),
      label: rowLabel(fieldsOf(asRow(row)) ?? [], row, i),
      kind: 'row',
      ...typeOf(row),
      at: shown,
      ...(shown !== 'same' && above !== undefined
        ? { above: rowLabel(fieldsOf(asRow(now.get(above))) ?? [], now.get(above), i + 1) }
        : {}),
      changes,
    });
  }
  if (wants(mode))
    for (const [i, [key, row]] of [...was].entries())
      if (!now.has(key))
        rows.push({
          path: rowAddress(at, key),
          label: rowLabel(fieldsOf(asRow(row)) ?? [], row, i),
          kind: 'row',
          ...typeOf(row),
          at: 'removed',
          changes: [],
        });
  found.push(...rows);
}

const keyed = (rows: unknown): Map<string, unknown> =>
  new Map(Array.isArray(rows) ? rows.map((row, i) => [rowKey(row, i), row]) : []);

export const rowAddress = (at: string, key: string) =>
  `${at}[${key.startsWith('#') ? key.slice(1) : `_id=${key}`}]`;

const asRow = (row: unknown): Record<string, unknown> => (isObject(row) ? row : {});

const typeOf = (row: unknown) =>
  isObject(row) && typeof row._type === 'string' ? { type: humanise(row._type) } : {};

/** A menu item named by its page keeps no label of its own, hence the link fallback. */
function rowLabel(fields: readonly Field[], row: unknown, index: number): string {
  return (
    firstWords(fields, row) ||
    linkTarget(isObject(row) ? row.link : undefined) ||
    typeOf(row).type ||
    `Row ${index + 1}`
  );
}

// A reader knows a link by what it names, never by its JSON.
const linkTarget = (link: unknown): string | undefined =>
  isObject(link)
    ? [link.ref, link.href, link.collection].find((v): v is string => typeof v === 'string')
    : undefined;

function firstWords(fields: readonly Field[], row: unknown): string | undefined {
  for (const field of fields) {
    const value = isObject(row) ? row[field.path[0] ?? ''] : undefined;
    if (field.type === 'group') {
      const inner = firstWords(field.fields, value);
      if (inner) return inner;
    } else if ((field.type === 'text' || field.type === 'richtext') && typeof value === 'string')
      return value;
  }
  return undefined;
}

/** The longest run that kept its order stood still; two rows that swapped are one move, not two. */
function movers(before: string[], after: string[]): Map<string, 'moved-up' | 'moved-down'> {
  const kept = new Set(after);
  const had = new Set(before);
  const from = before.filter((k) => kept.has(k));
  const to = after.filter((k) => had.has(k));
  const still = new Set(lcs(from, to));
  const moved = new Map<string, 'moved-up' | 'moved-down'>();
  for (const key of to)
    if (!still.has(key))
      moved.set(key, to.indexOf(key) < from.indexOf(key) ? 'moved-up' : 'moved-down');
  return moved;
}

function lcs<T extends string>(a: T[], b: T[]): T[] {
  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const here = a[i];
    if (here !== undefined && here === b[j]) {
      out.push(here);
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) i++;
    else j++;
  }
  return out;
}

/** Split on word boundaries, so adding a comma is not the whole word replaced; never on lines. */
function wordDiff(before: string, after: string): WordPart[] {
  const a = words(before);
  const b = words(after);
  const same = lcs(a, b);
  const parts: WordPart[] = [];
  const put = (text: string, mark?: 'del' | 'ins') => {
    const last = parts[parts.length - 1];
    if (last && last.mark === mark) last.text += text;
    else parts.push(mark ? { text, mark } : { text });
  };
  let i = 0;
  let j = 0;
  for (const word of [...same, undefined]) {
    while (i < a.length && a[i] !== word) put(a[i++] ?? '', 'del');
    while (j < b.length && b[j] !== word) put(b[j++] ?? '', 'ins');
    if (word !== undefined) {
      put(word);
      i++;
      j++;
    }
  }
  return parts;
}

const words = (text: string) => text.split(/([^\p{L}\p{N}]+)/u).filter((w) => w !== '');

// Only a plain-word array reaches here, and it reads as a sentence, not brackets.
const str = (value: unknown): string =>
  Array.isArray(value)
    ? value.map((item) => str(item)).join(', ')
    : typeof value === 'string'
      ? value
      : (show(value) ?? '');

const show = (value: unknown): string | undefined =>
  value === undefined || value === null
    ? undefined
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

/** Keyed the way `_machine` addresses a field; a field only the newer source has is not stale. */
export function sourceChanges(
  _siteId: string,
  form: Form,
  translatedFrom: unknown,
  now: unknown,
): Record<string, WordPart[]> {
  const current = new Map(translatedValues(form, now));
  const changed: Record<string, WordPart[]> = {};
  for (const [path, was] of translatedValues(form, translatedFrom)) {
    const is = current.get(path) ?? '';
    if (is !== was) changed[path] = wordDiff(said(was), said(is));
  }
  return changed;
}

// `translatedValues` encodes for its hash; a reader is shown the sentence, not the quotes.
const said = (encoded: string): string => {
  if (encoded === '') return '';
  try {
    const value: unknown = JSON.parse(encoded);
    return typeof value === 'string' ? value : encoded;
  } catch {
    return encoded;
  }
};
