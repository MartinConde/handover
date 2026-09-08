import { type Field, type Form, rowFields } from './schema.js';

/** A site swaps DeepL for its own function; callers only know a machine answered. */
export type Translate = (texts: string[], from: string, to: string) => Promise<string[]>;

// DeepL's cap on one request, so the call is split and the answers reassembled in order.
const PER_REQUEST = 50;

/** A `:fx` key only answers on the free host; a source language has no regional variant. */
export function deeplTranslate(_siteId: string, key: string): Translate {
  const host = key.trimEnd().endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  return async (texts, from, to) => {
    const out: string[] = [];
    for (let i = 0; i < texts.length; i += PER_REQUEST) {
      const batch = texts.slice(i, i + PER_REQUEST);
      const res = await fetch(`https://${host}/v2/translate`, {
        method: 'POST',
        headers: { authorization: `DeepL-Auth-Key ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: batch,
          source_lang: from.split('-')[0]?.toUpperCase(),
          target_lang: to.toUpperCase(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        translations?: { text?: string }[];
        message?: string;
      };
      // DeepL's message names the rule broken, which is more use than a status code.
      if (!res.ok)
        throw new Error(
          `DeepL refused the translation (${res.status})${body.message ? `: ${body.message}` : ''}`,
        );
      out.push(...batch.map((_, n) => body.translations?.[n]?.text ?? ''));
    }
    return out;
  };
}

/** `_machine` names every path a machine's words still stand at; see `keptMachine`. */
export function machineFilled(
  _siteId: string,
  data: unknown,
  filled: Record<string, string>,
): Record<string, unknown> {
  const out = structuredClone(isObject(data) ? data : {});
  const was = Array.isArray(out._machine) ? (out._machine as string[]) : [];
  // A path the file has no room for writes nothing, or `_machine` would badge an empty field.
  const written = Object.entries(filled).filter(([path, text]) => writeAt(out, path, text));
  const put = new Set(written.map(([path]) => path));
  const machine = [...was.filter((p) => !put.has(p)), ...put];
  if (machine.length) out._machine = machine;
  return out;
}

/** The browser never says which values it touched, so an unchanged value keeps its badge. */
export function keptMachine(_siteId: string, before: unknown, after: unknown): string[] {
  const machine = isObject(before) && Array.isArray(before._machine) ? before._machine : [];
  return (machine as string[]).filter((path) => {
    const now = readAt(after, path);
    return now !== undefined && now === readAt(before, path);
  });
}

/** Rows are addressed by `_id`, since a row's position changes when somebody moves it. */
export function fieldAddress(
  _siteId: string,
  path: readonly string[],
  root: unknown,
  form?: Form,
): string | undefined {
  if (form && !fieldAt(form, path, root)) return undefined;
  let node: unknown = root;
  let out = '';
  for (const key of path) {
    if (Array.isArray(node)) {
      const index = indexOf(key, node.length);
      if (index === undefined) return undefined;
      const row = node[index];
      const stable = isObject(row) && typeof row._id === 'string' ? row._id : undefined;
      if (
        stable &&
        node.filter((candidate) => isObject(candidate) && candidate._id === stable).length > 1
      )
        return undefined;
      const id = stable ? `_id=${stable}` : key;
      out += `[${id}]`;
      node = row;
    } else {
      out += out ? `.${key}` : key;
      node = isObject(node) ? node[key] : undefined;
    }
  }
  return out;
}

/** `fieldAddress` read back to positions; a row the data no longer has ends the walk. */
export function fieldPosition(
  _siteId: string,
  address: string,
  root: unknown,
  form?: Form,
): string[] | undefined {
  const resolved = positionOf(address, root);
  if (!resolved.ok) return undefined;
  return !form || fieldAt(form, resolved.path, root) ? resolved.path : undefined;
}

export type FieldTargetFailure = 'ambiguous' | 'deleted' | 'schema';

export type FieldTarget = {
  address: string;
  path: string[];
  field: Field;
};

export type FieldTargetResult =
  | { ok: true; target: FieldTarget }
  | { ok: false; reason: FieldTargetFailure };

/** Resolve an external stable address against both the current data and its declared form. */
export function resolveFieldTarget(
  _siteId: string,
  form: Form,
  address: string,
  root: unknown,
): FieldTargetResult {
  const resolved = positionOf(address, root);
  if (!resolved.ok) return resolved;
  const field = fieldAt(form, resolved.path, root);
  if (!field) return { ok: false, reason: 'schema' };
  const canonical = fieldAddress(_siteId, resolved.path, root, form);
  if (!canonical) return { ok: false, reason: 'ambiguous' };
  return { ok: true, target: { address: canonical, path: resolved.path, field } };
}

type PositionResult = { ok: true; path: string[] } | { ok: false; reason: 'ambiguous' | 'deleted' };

function positionOf(address: string, root: unknown): PositionResult {
  let node: unknown = root;
  const out: string[] = [];
  const steps = stepsOf(address);
  if (!steps.length) return { ok: false, reason: 'deleted' };
  for (const { row, key, stable } of steps) {
    if (row !== undefined) {
      if (!Array.isArray(node)) return { ok: false, reason: 'deleted' };
      const matches = stable
        ? node.flatMap((candidate, i) => (isObject(candidate) && candidate._id === row ? [i] : []))
        : [];
      if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
      const i = stable ? matches[0] : indexOf(row, node.length);
      if (i === undefined) return { ok: false, reason: 'deleted' };
      out.push(String(i));
      node = node[i];
    } else {
      out.push(key ?? '');
      node = isObject(node) ? node[key ?? ''] : undefined;
    }
  }
  return { ok: true, path: out };
}

// A step is a key, or a row of the array under the key before it.
const STEPS = /\[(_id=)?([^\]]+)\]|([^.[\]]+)/g;

const stepsOf = (path: string) =>
  [...path.matchAll(STEPS)].map(([, marker, row, key]) => ({
    row,
    key,
    // Old addresses without the marker used non-numeric ids; continue to read those.
    stable: marker !== undefined || (row !== undefined && !/^\d+$/.test(row)),
  }));

const indexOf = (key: string, length: number): number | undefined => {
  if (!/^\d+$/.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length ? index : undefined;
};

/** The schema leaf that owns a positional path, including a widget's internal properties. */
function fieldAt(form: Form, path: readonly string[], root: unknown): Field | undefined {
  const walk = (fields: readonly Field[], offset: number, node: unknown): Field | undefined => {
    for (const field of fields) {
      if (!field.path.every((key, i) => path[offset + i] === key)) continue;
      const after = offset + field.path.length;
      const value = field.path.reduce<unknown>(
        (parent, key) => (isObject(parent) ? parent[key] : undefined),
        node,
      );
      if (after >= path.length) return field;
      if (field.type === 'group') return walk(field.fields, after, value);
      if (field.type === 'blocks') {
        if (!Array.isArray(value)) return undefined;
        const row = indexOf(path[after] ?? '', value.length);
        if (row === undefined) return undefined;
        if (after + 1 >= path.length) return field;
        const item = value[row];
        const type = isObject(item) && typeof item._type === 'string' ? item._type : '';
        const nested = form.blocks[type];
        return nested ? walk(nested, after + 1, item) : undefined;
      }
      const nested = rowFields(field);
      if (nested) {
        if (!Array.isArray(value)) return undefined;
        const row = indexOf(path[after] ?? '', value.length);
        if (row === undefined) return undefined;
        return after + 1 >= path.length ? field : walk(nested, after + 1, value[row]);
      }
      // Link/media/SEO and unsupported widgets own their internal schema paths atomically.
      return field;
    }
    return undefined;
  };
  return walk(form.fields, 0, root);
}

function readAt(data: unknown, path: string): unknown {
  let node: unknown = data;
  for (const { row, key } of stepsOf(path)) {
    if (row !== undefined) node = rowOf(node, row);
    else node = isObject(node) ? node[key ?? ''] : undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

/** A missing group is made on the way down; a missing row is not, as a fill never adds blocks. */
function writeAt(data: Record<string, unknown>, path: string, value: string): boolean {
  const steps = stepsOf(path);
  const last = steps.pop();
  if (!last) return false;
  let node: unknown = data;
  for (const { row, key } of steps) {
    if (row !== undefined) node = rowOf(node, row);
    else if (isObject(node)) node = node[key ?? ''] ??= {};
    else node = undefined;
    if (node === undefined) return false;
  }
  if (last.row !== undefined) {
    const rows = Array.isArray(node) ? node : undefined;
    const at = rows?.findIndex((r, i) => rowKey(r, i) === last.row) ?? -1;
    if (!rows || at < 0) return false;
    rows[at] = value;
    return true;
  }
  if (!isObject(node)) return false;
  node[last.key ?? ''] = value;
  return true;
}

const rowOf = (node: unknown, id: string) => {
  if (!Array.isArray(node)) return undefined;
  const matches = node.filter((row, i) => rowKey(row, i) === id);
  return matches.length === 1 ? matches[0] : undefined;
};

const rowKey = (row: unknown, i: number) =>
  isObject(row) && typeof row._id === 'string' ? row._id : String(i);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
