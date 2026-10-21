import type { Field, Form, LocaleSeed } from '@handover/core';
import { isRecord } from '../request.js';

export type EntryData = Record<string, unknown>;

export type FieldContext = {
  field: Field;
  mode: true | 'duplicate' | false;
  path: string[];
};

export const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    );
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
  );
};

export const clone = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  return value;
};

const indexOf = (key: string, length: number): number | undefined => {
  if (!/^\d+$/.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length ? index : undefined;
};

export const read = (root: unknown, path: readonly string[]) =>
  path.reduce<unknown>(
    (node, key) =>
      Array.isArray(node)
        ? node[indexOf(key, node.length) ?? -1]
        : isRecord(node)
          ? node[key]
          : undefined,
    root,
  );

// Find the owning field and inherited translation mode for one resolved positional path.
export function fieldContext(
  form: Form,
  path: readonly string[],
  root: unknown,
): FieldContext | undefined {
  const walk = (
    fields: readonly Field[],
    offset: number,
    node: unknown,
    inherited: true | 'duplicate' | false,
  ): FieldContext | undefined => {
    for (const field of fields) {
      if (!field.path.every((key, i) => path[offset + i] === key)) continue;
      const after = offset + field.path.length;
      const value = field.path.reduce<unknown>(
        (parent, key) => (isRecord(parent) ? parent[key] : undefined),
        node,
      );
      const mode = field.i18n ?? inherited;
      if (after >= path.length) return { field, mode, path: [...path.slice(0, after)] };
      if (field.type === 'group') return walk(field.fields, after, value, mode);
      if (field.type === 'blocks') {
        if (!Array.isArray(value)) return undefined;
        const row = indexOf(path[after] ?? '', value.length);
        if (row === undefined) return undefined;
        if (after + 1 >= path.length) return { field, mode, path: [...path.slice(0, after)] };
        const item = value[row];
        const type = isRecord(item) && typeof item._type === 'string' ? item._type : '';
        const nested = form.blocks[type];
        return nested ? walk(nested, after + 1, item, mode) : undefined;
      }
      if (field.type === 'array') {
        if (!Array.isArray(value)) return undefined;
        const row = indexOf(path[after] ?? '', value.length);
        if (row === undefined) return undefined;
        if (after + 1 >= path.length) {
          const scalar = field.item.length === 1 ? field.item[0] : undefined;
          return scalar?.path.length === 0
            ? { field: scalar, mode: scalar.i18n ?? mode, path: [...path.slice(0, after + 1)] }
            : { field, mode, path: [...path.slice(0, after)] };
        }
        return walk(field.item, after + 1, value[row], mode);
      }
      // Structured widgets own their internal properties as one schema field.
      return { field, mode, path: [...path.slice(0, after)] };
    }
  };
  return walk(form.fields, 0, root, true);
}

export function write(root: EntryData, path: readonly string[], value: unknown): void {
  let node: Record<string, unknown> = root;
  for (const key of path.slice(0, -1)) {
    const current = node[key];
    if (!isRecord(current) && !Array.isArray(current)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const key = path.at(-1);
  if (key === undefined) return;
  if (value === undefined) delete node[key];
  else node[key] = value;
}

export const inReferencedBlock = (root: unknown, path: readonly string[]) => {
  let node: unknown = root;
  for (const key of path) {
    if (isRecord(node) && typeof node._ref === 'string') return true;
    node = Array.isArray(node)
      ? node[indexOf(key, node.length) ?? -1]
      : isRecord(node)
        ? node[key]
        : undefined;
  }
  return false;
};

export const rowId = (row: unknown): string | undefined =>
  isRecord(row) && typeof row._id === 'string' ? row._id : undefined;

export const rowAddress = (container: string, id: string) => `${container}[_id=${id}]`;

export const insertedIds = (before: readonly unknown[], after: readonly unknown[]) => {
  const beforeIds = new Set(before.map(rowId).filter((id): id is string => id !== undefined));
  return new Set(
    after.map(rowId).filter((id): id is string => id !== undefined && !beforeIds.has(id)),
  );
};

const machinePaths = (snapshot: EntryData): string[] =>
  Array.isArray(snapshot._machine)
    ? snapshot._machine.filter((path): path is string => typeof path === 'string')
    : [];

export const scopedMachine = (snapshot: EntryData, address: string): string[] =>
  machinePaths(snapshot).filter((path) => path.startsWith(`${address}.`));

const setMachinePaths = (snapshot: EntryData, paths: readonly string[]) => {
  if (paths.length) snapshot._machine = [...new Set(paths)];
  else delete snapshot._machine;
};

export const remapMachinePath = (path: string, ids: ReadonlyMap<string, string>) =>
  path.replace(/\[_id=([0-9a-z]+)\]/g, (_match, old: string) => `[_id=${ids.get(old) ?? old}]`);

export const updateRemovedMachinePaths = (
  snapshot: EntryData,
  address: string,
  before: readonly unknown[],
  after: readonly unknown[],
) => {
  const remaining = new Set(after.map(rowId).filter((id): id is string => id !== undefined));
  const removed = new Set(
    before.map(rowId).filter((id): id is string => id !== undefined && !remaining.has(id)),
  );
  if (!removed.size) return;
  setMachinePaths(
    snapshot,
    machinePaths(snapshot).filter(
      (path) => ![...removed].some((id) => path.startsWith(`${rowAddress(address, id)}.`)),
    ),
  );
};

export const addInsertedMachinePaths = (
  snapshot: EntryData,
  before: readonly unknown[],
  after: readonly unknown[],
  seeds: readonly LocaleSeed[],
) => {
  const inserted = insertedIds(before, after);
  const additions = seeds
    .filter((seed) => {
      const id = rowId(seed.value);
      return id !== undefined && inserted.has(id);
    })
    .flatMap((seed) => seed.machine ?? []);
  setMachinePaths(snapshot, [...machinePaths(snapshot), ...additions]);
};
