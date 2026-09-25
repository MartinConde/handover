import { type Change, type DiffGroup, diffEntry, joinedName } from '../content/diff.js';
import { isObject, rowAddress, rowKey, TRANSLATED_PROPS } from '../content/entry-format.js';
import { type Field, type Form, rowFields } from '../content/schema.js';
import type { Labels } from '../content/ui-locale.js';

/** One file of an entry as the three sides have it: what it was, what we wrote, what is in git. */
export interface ThreeWay {
  /** The file at the commit the draft was loaded from. */
  base: unknown;
  /** The draft. */
  ours: unknown;
  /** The file at HEAD. */
  theirs: unknown;
}

/** A field both sides changed, and the only thing a person has to answer. */
export interface Question {
  path: string;
  label: string;
  labels?: Labels;
  /** Absent on a value every language holds the same. */
  locale?: string;
  /** What both sides started from, where it is a value short enough to be read. */
  base?: string;
  ours: Change;
  theirs: Change;
}

/** A field only one side changed, which is merged without asking. */
export interface MergedChange {
  locale?: string;
  label: string;
  labels?: Labels;
  side: 'ours' | 'theirs';
  change: Change;
}

/** One answer: which side of a question to keep. */
export interface Answer {
  path: string;
  locale?: string;
  side: 'ours' | 'theirs';
}

/** Two diffs laid over each other; a question is only ever about a field, never a moved block. */
export function conflictReport(
  siteId: string,
  form: Form,
  files: Record<string, ThreeWay>,
): { questions: Question[]; merged: MergedChange[] } {
  const side = (of: keyof ThreeWay) =>
    Object.fromEntries(Object.entries(files).map(([locale, f]) => [locale, f[of]]));
  const base = side('base');
  const ours = flatten(diffEntry(siteId, form, base, side('ours')));
  const theirs = flatten(diffEntry(siteId, form, base, side('theirs')));
  const questions: Question[] = [];
  const merged: MergedChange[] = [];
  for (const [key, mine] of ours) {
    const yours = theirs.get(key);
    // A moved block has no pair of answers to offer for a position, so ours stands.
    if (!yours || mine.change.kind === 'row' || yours.change.kind === 'row') {
      merged.push({ ...mine, side: 'ours' });
      continue;
    }
    // Both changed it to the same thing, so an answer would be a choice between identical values.
    if (after(mine.change) !== undefined && after(mine.change) === after(yours.change)) {
      merged.push({ ...mine, side: 'ours' });
      continue;
    }
    questions.push({
      path: mine.path,
      label: mine.label,
      ...(mine.labels ? { labels: mine.labels } : {}),
      ...(mine.locale ? { locale: mine.locale } : {}),
      ...(before(mine.change) !== undefined ? { base: before(mine.change) } : {}),
      ours: mine.change,
      theirs: yours.change,
    });
  }
  for (const [key, yours] of theirs) if (!ours.has(key)) merged.push({ ...yours, side: 'theirs' });
  return { questions, merged };
}

/** HEAD is the ground, our fields laid over it; the file's marks stay the repository's. */
export function applyResolution(
  siteId: string,
  form: Form,
  files: Record<string, ThreeWay>,
  answers: Answer[],
): Record<string, unknown> {
  const side = (of: keyof ThreeWay) =>
    Object.fromEntries(Object.entries(files).map(([locale, f]) => [locale, f[of]]));
  const base = side('base');
  const wins = new Map<string, 'ours' | 'theirs'>();
  for (const key of flatten(diffEntry(siteId, form, base, side('ours'))).keys())
    wins.set(key, 'ours');
  for (const answer of answers) wins.set(keyOf(answer.locale, answer.path), answer.side);
  return Object.fromEntries(
    Object.entries(files).map(([locale, f]) => [
      locale,
      fieldsIn(form, form.fields, f, '', { locale, wins }),
    ]),
  );
}

interface Flat {
  labels?: Labels;
  locale?: string;
  path: string;
  label: string;
  change: Change;
}

const keyOf = (locale: string | undefined, path: string) => `${locale ?? ''}\u0000${path}`;

/** Every change in a report by the language and path it is at, a row's own included. */
function flatten(groups: DiffGroup[]): Map<string, Flat> {
  const found = new Map<string, Flat>();
  const walk = (
    changes: Change[],
    locale: string | undefined,
    prefix: { label: string; labels?: Labels },
  ) => {
    for (const change of changes) {
      const named = joinedName(prefix, change);
      if (change.kind === 'row') {
        if (change.at !== 'same')
          found.set(keyOf(locale, change.path), { locale, path: change.path, ...named, change });
        walk(change.changes, locale, named);
      } else found.set(keyOf(locale, change.path), { locale, path: change.path, ...named, change });
    }
  };
  for (const group of groups) walk(group.changes, group.locale, { label: '' });
  return found;
}

/** What a change leaves behind, where that is something to compare two of. */
const after = (change: Change): string | undefined =>
  change.kind === 'value'
    ? change.after
    : change.kind === 'words'
      ? change.parts
          .filter((p) => p.mark !== 'del')
          .map((p) => p.text)
          .join('')
      : undefined;

/** And what it started from, which is the one thing that makes two answers answerable. */
const before = (change: Change): string | undefined =>
  change.kind === 'value'
    ? change.before
    : change.kind === 'words'
      ? change.parts
          .filter((p) => p.mark !== 'ins')
          .map((p) => p.text)
          .join('')
      : undefined;

interface Sides {
  locale: string;
  wins: Map<string, 'ours' | 'theirs'>;
}

const won = (at: string, ctx: Sides): 'ours' | 'theirs' =>
  ctx.wins.get(keyOf(ctx.locale, at)) ?? ctx.wins.get(keyOf(undefined, at)) ?? 'theirs';

// The same descent the diff makes, so its paths are the ones decided here; the rest is HEAD's.
function fieldsIn(
  form: Form,
  fields: readonly Field[],
  at: ThreeWay,
  path: string,
  ctx: Sides,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(isObject(at.theirs) ? at.theirs : {}) };
  for (const field of fields) {
    const key = field.path[0];
    if (key === undefined) continue;
    const here = into(at, key);
    const inner = path ? `${path}.${key}` : key;
    const item = rowFields(field);
    if (field.type === 'group') {
      if (isObject(here.ours) || isObject(here.theirs))
        out[key] = fieldsIn(form, field.fields, here, inner, ctx);
    } else if (field.type === 'blocks')
      set(
        out,
        key,
        rowsIn(form, (row) => form.blocks[String(row._type)], here, inner, ctx),
      );
    else if (item)
      set(
        out,
        key,
        rowsIn(form, () => item, here, inner, ctx),
      );
    else set(out, key, leafIn(field, here, inner, ctx));
  }
  return out;
}

const into = (at: ThreeWay, key: string): ThreeWay => ({
  base: isObject(at.base) ? at.base[key] : undefined,
  ours: isObject(at.ours) ? at.ours[key] : undefined,
  theirs: isObject(at.theirs) ? at.theirs[key] : undefined,
});

const set = (out: Record<string, unknown>, key: string, value: unknown) => {
  if (value === undefined) delete out[key];
  else out[key] = value;
};

/** The diff's split, so a replaced picture file and a retyped `alt` both come out. */
function leafIn(field: Field, at: ThreeWay, path: string, ctx: Sides): unknown {
  const translated = TRANSLATED_PROPS[field.type];
  if (translated && (isObject(at.ours) || isObject(at.theirs)))
    return propsIn(field, at, path, [], ctx);
  return won(path, ctx) === 'ours' ? at.ours : at.theirs;
}

function propsIn(field: Field, at: ThreeWay, path: string, under: string[], ctx: Sides): unknown {
  const picture =
    (field.type === 'image' && under.length === 0) ||
    (field.type === 'seo' && under.join('.') === 'image');
  const sourceSide = picture ? won(`${path}.${[...under, 'src'].join('.')}`, ctx) : undefined;
  const asset = sourceSide === 'ours' ? at.ours : at.theirs;
  if (picture && (!isObject(asset) || typeof asset.src !== 'string')) return undefined;
  const out: Record<string, unknown> = { ...(isObject(at.theirs) ? at.theirs : {}) };
  const keys = [
    ...Object.keys(isObject(at.ours) ? at.ours : {}),
    ...Object.keys(isObject(at.theirs) ? at.theirs : {}).filter(
      (k) => !(isObject(at.ours) && k in at.ours),
    ),
  ].filter((k) => !k.startsWith('_'));
  for (const key of keys) {
    const here = into(at, key);
    const inner = [...under, key];
    if (isObject(here.ours) || isObject(here.theirs))
      set(out, key, propsIn(field, here, path, inner, ctx));
    else if (picture && (key === 'width' || key === 'height'))
      set(out, key, isObject(asset) ? asset[key] : undefined);
    else set(out, key, won(`${path}.${inner.join('.')}`, ctx) === 'ours' ? here.ours : here.theirs);
  }
  return out;
}

/** Rows keyed by `_id`; ours is the order, since a position has no pair of answers to offer. */
function rowsIn(
  form: Form,
  fieldsOf: (row: Record<string, unknown>) => readonly Field[] | undefined,
  at: ThreeWay,
  path: string,
  ctx: Sides,
): unknown[] | undefined {
  if (!Array.isArray(at.ours) && !Array.isArray(at.theirs)) return undefined;
  const base = keyed(at.base);
  const ours = keyed(at.ours);
  const theirs = keyed(at.theirs);
  const order = [...ours.keys()].filter((key) => !base.has(key) || theirs.has(key));
  const theirKeys = [...theirs.keys()];
  for (const [i, key] of theirKeys.entries()) {
    if (base.has(key) || ours.has(key)) continue;
    const before = theirKeys[i - 1];
    const after = before === undefined ? -1 : order.indexOf(before);
    order.splice(after + 1, 0, key);
  }
  return order.map((key) => {
    const row = { base: base.get(key), ours: ours.get(key), theirs: theirs.get(key) };
    if (row.ours === undefined) return row.theirs;
    if (row.theirs === undefined) return row.ours;
    const fields = fieldsOf(asRow(row.theirs)) ?? fieldsOf(asRow(row.ours)) ?? [];
    return fieldsIn(form, fields, row, rowAddress(path, key), ctx);
  });
}

const keyed = (rows: unknown): Map<string, unknown> =>
  new Map(Array.isArray(rows) ? rows.map((row, i) => [rowKey(row, i), row]) : []);

const asRow = (row: unknown): Record<string, unknown> => (isObject(row) ? row : {});
