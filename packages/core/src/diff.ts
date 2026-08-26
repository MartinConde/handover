import { isObject, rowKey, TRANSLATED_PROPS } from './content.js';
import { type Field, type Form, humanise, type Translation } from './schema.js';

/** A run of a text field's words: what stayed, what went, what arrived. */
export interface WordPart {
  text: string;
  mark?: 'del' | 'ins';
}

/** A block or array row against the rows around it. */
export type RowAt = 'added' | 'removed' | 'moved-up' | 'moved-down' | 'same';

/**
 * One field's change in the shape it is read in: a sentence with the words that moved marked,
 * a value against the value it replaced, a body too long to read twice, or a row.
 */
export type Change = { path: string; label: string } & (
  | { kind: 'words'; parts: WordPart[] }
  | { kind: 'value'; before?: string; after?: string }
  | { kind: 'whole' }
  | { kind: 'row'; type?: string; at: RowAt; above?: string; changes: Change[] }
);

/** The changes one language made, or the ones its languages share. */
export interface DiffGroup {
  /** Absent on the group of fields every language holds the same value in. */
  locale?: string;
  changes: Change[];
}

/** Which fields a group takes: the ones every language shares, or the ones one language owns. */
type Wants = (mode: Translation) => boolean;

/**
 * What changed between two states of one entry, field by field and language by language.
 *
 * **Fields, not lines.** Both sides are parsed entries per language — the draft against the file
 * at HEAD, or one version against another — and the walk is the schema's, so the marks a file
 * carries (`_i18n`, `_machine`, `_locales`) are never a change anybody made.
 *
 * The groups are the languages, plus one for the values they share: a price written into every
 * file would otherwise read as having changed twice. An entry in a single language has no shared
 * group, because nothing in it is doubled, and a language nothing happened in still gets a group
 * — silence reads as "not loaded".
 */
export function diffEntry(
  _siteId: string,
  form: Form,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): DiffGroup[] {
  const locales = [...Object.keys(after), ...Object.keys(before).filter((l) => !(l in after))];
  if (locales.length === 0) return [];
  const shared = locales.length > 1;
  const groups: DiffGroup[] = [];
  if (shared) {
    // Every file is read, not only the first: a shared value is only shared while the files agree,
    // and one that moved in the German file alone is exactly what a conflict view exists to catch.
    const seen = new Set<string>();
    const changes: Change[] = [];
    for (const locale of locales)
      for (const change of walk(form, before[locale], after[locale], (m) => m === 'duplicate'))
        if (!seen.has(change.path)) {
          seen.add(change.path);
          changes.push(change);
        }
    groups.push({ changes });
  }
  for (const locale of locales)
    groups.push({
      locale,
      changes: walk(form, before[locale], after[locale], (m) => !shared || m !== 'duplicate'),
    });
  return groups;
}

const walk = (form: Form, before: unknown, after: unknown, wants: Wants): Change[] => {
  const found: Change[] = [];
  changesIn(form, form.fields, before, after, '', '', true, wants, found);
  return found;
};

// The same descent `driftIn` and `overlay` make: groups, blocks fields and arrays of rows, and
// nowhere else. `at` addresses a value the way `_machine` does; `named` is what a reader sees.
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
    if (field.type === 'group')
      changesIn(form, field.fields, was, now, path, label, mode, wants, found);
    else if (field.type === 'blocks')
      rowsIn(form, (row) => form.blocks[String(row._type)], was, now, path, mode, wants, found);
    else if (field.type === 'array' && field.item.some((f) => f.path.length > 0))
      rowsIn(form, () => field.item, was, now, path, mode, wants, found);
    else leafIn(field, was, now, path, label, mode, wants, found);
  }
}

/**
 * A leaf, or the properties of one. A structured field is not one value: only the properties a
 * translator retypes are that language's — getting this wrong is what makes clients retype image
 * URLs, and here it would report the same replaced picture under every language.
 */
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
  for (const key of keys) {
    const was = isObject(before) ? before[key] : undefined;
    const now = isObject(after) ? after[key] : undefined;
    const inner = [...under, key];
    const to = `${path}.${inner.join('.')}`;
    const says = [label, ...inner.map(humanise)].join(' · ');
    if (isObject(was) || isObject(now)) {
      propsIn(field, translated, was, now, path, label, inner, mode, wants, found);
      continue;
    }
    // Shared unless this property is one of the field's translated ones — and only where the
    // field itself is translated at all.
    const own: Translation =
      mode === true && !translated.includes(inner.join('.')) ? 'duplicate' : mode;
    if (!wants(own) || show(was) === show(now)) continue;
    found.push({ path: to, label: says, kind: 'value', before: show(was), after: show(now) });
  }
}

/**
 * Rows keyed by `_id`, so a block that moved says it moved instead of arriving as one deletion
 * plus one addition; rows without one — a template's list — pair by position and never move.
 * A row that arrived or left is not read into: the row itself is the change.
 */
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
        address(at, key),
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
      path: address(at, key),
      label: rowLabel(fieldsOf(asRow(row)) ?? [], row, key),
      kind: 'row',
      ...typeOf(row),
      at: shown,
      ...(shown !== 'same' && above !== undefined
        ? { above: rowLabel(fieldsOf(asRow(now.get(above))) ?? [], now.get(above), above) }
        : {}),
      changes,
    });
  }
  if (wants(mode))
    for (const [key, row] of was)
      if (!now.has(key))
        rows.push({
          path: address(at, key),
          label: rowLabel(fieldsOf(asRow(row)) ?? [], row, key),
          kind: 'row',
          ...typeOf(row),
          at: 'removed',
          changes: [],
        });
  found.push(...rows);
}

const keyed = (rows: unknown): Map<string, unknown> =>
  new Map(Array.isArray(rows) ? rows.map((row, i) => [rowKey(row, i), row]) : []);

const address = (at: string, key: string) =>
  `${at}[${key.startsWith('#') ? key.slice(1) : `_id=${key}`}]`;

const asRow = (row: unknown): Record<string, unknown> => (isObject(row) ? row : {});

const typeOf = (row: unknown) =>
  isObject(row) && typeof row._type === 'string' ? { type: humanise(row._type) } : {};

/** What a row is called: the first words it says, falling back to its type or its place. */
function rowLabel(fields: readonly Field[], row: unknown, key: string): string {
  for (const field of fields) {
    const value = isObject(row) ? row[field.path[0] ?? ''] : undefined;
    if (field.type === 'group') {
      const inner = rowLabel(field.fields, value, '');
      if (inner) return inner;
    } else if ((field.type === 'text' || field.type === 'richtext') && typeof value === 'string')
      return value;
  }
  if (isObject(row) && typeof row._type === 'string') return humanise(row._type);
  return key.startsWith('#') ? `Row ${Number(key.slice(1)) + 1}` : key;
}

/**
 * Which rows a reader would call moved: the longest run that kept its order is where the entry
 * stood still, and everything else went somewhere. Two rows that swapped are one move, not two.
 */
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

/**
 * One text field's sentence with the words that went and the words that arrived marked in it.
 * Split on word boundaries rather than on spaces, so adding a comma to a word is not the whole
 * word being replaced, and never on lines: a line diff would leak the file format into the UI.
 */
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

// A list of plain words is a sentence, not the brackets the file writes it in: an array of rows
// went to `rowsIn` long before this, so what is left here is `['sea', 'view']`.
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
