import { eachRow, isObject, rowAddress, rowKey, TRANSLATED_PROPS } from './entry-format.js';
import { hasWords } from './richtext.js';
import { type Field, type Form, rowFields, type Translation } from './schema.js';

/** Translated leaves sorted by `_machine` address, so moving a block is not a change. */
export function translatedValues(form: Form, data: unknown): [string, string][] {
  const found: [string, string][] = [];
  valuesIn(form, form.fields, data, '', true, found);
  return found.sort(([a], [b]) => (a < b ? -1 : 1));
}

// The same descent `driftIn` and `overlay` make.
export function valuesIn(
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
        const inner = propAt(value, prop);
        if (inner !== undefined) found.push([`${path}.${prop}`, JSON.stringify(inner)]);
      }
    else if (field.type === 'blocks' || row)
      eachRow(
        value,
        field.type === 'blocks' ? (r) => form.blocks[String(r._type)] : () => row,
        path,
        (inner, r, address) => valuesIn(form, inner, r, address, mode, found, want),
      );
    else if (mode === want && value !== undefined) found.push([path, JSON.stringify(value)]);
  }
}

const propAt = (value: unknown, prop: string) =>
  prop.split('.').reduce<unknown>((v, k) => (isObject(v) ? v[k] : undefined), value);

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
        const rowAt = rowAddress(path, id);
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
    const inner = propAt(value, prop);
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
    // An empty menu label means "use the page title", which is already translated.
    else if (
      field.type === 'blocks' ||
      (field.type === 'array' && field.item.some((f) => f.path.length > 0))
    )
      eachRow(
        value,
        field.type === 'blocks' ? (r) => form.blocks[String(r._type)] : () => field.item,
        path,
        (inner, r, address) => textIn(form, inner, r, address, mode, found),
      );
    else if (mode !== true) continue;
    else if (field.type === 'text' || field.type === 'richtext') {
      if (typeof value === 'string' && value) found.push({ path, text: value });
    } else if (field.type === 'link') {
      const label = isObject(value) ? value.label : undefined;
      if (typeof label === 'string' && label) found.push({ path: `${path}.label`, text: label });
    }
  }
}
