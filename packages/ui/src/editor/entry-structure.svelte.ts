import {
  type Field,
  type Form,
  fieldAddress,
  type LocaleSeed,
  regenerateIds,
  resolveFieldTarget,
  syncLocale,
} from '@handover/core';
import { isRecord } from '../request.js';
import type { createEntryHistory, StructuralHistoryTransaction } from './entry-history.svelte';
import {
  addInsertedMachinePaths,
  clone,
  type EntryData,
  equal,
  type FieldContext,
  fieldContext,
  inReferencedBlock,
  insertedIds,
  read,
  remapMachinePath,
  rowAddress,
  rowId,
  scopedMachine,
  updateRemovedMachinePaths,
  write,
} from './entry-paths';
import type {
  FieldCommandFailure,
  FieldCommandResult,
  ListCommand,
  ListCommandResult,
  ListOperation,
  StructuralSaveEnvelope,
} from './entry-session.svelte';

type PendingStructure = {
  container: string;
  seeds: Record<string, LocaleSeed[]>;
  version: number;
};

const validListIndex = (index: number, length: number, insert = false) =>
  Number.isSafeInteger(index) && index >= 0 && index < length + (insert ? 1 : 0);

const validInsertedRow = (field: Field, value: unknown) => {
  if (field.type === 'blocks') {
    if (!isRecord(value) || typeof value._id !== 'string' || typeof value._type !== 'string')
      return false;
    return field.types.includes(value._type);
  }
  return field.type === 'array';
};

const duplicateRowId = (rows: readonly unknown[]) => {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row._id !== 'string') continue;
    if (seen.has(row._id)) return true;
    seen.add(row._id);
  }
  return false;
};

// Each list operation edits `rows` in place and returns its refusal, if any.
const insertRow = (
  current: EntryData,
  context: FieldContext,
  held: unknown,
  rows: unknown[],
  operation: Extract<ListOperation, { type: 'insert' }>,
): FieldCommandFailure | undefined => {
  const insertedId = isRecord(operation.value) ? operation.value._id : undefined;
  if (typeof insertedId === 'string' && rows.some((row) => isRecord(row) && row._id === insertedId))
    return 'ambiguous';
  if (
    !validListIndex(operation.index, rows.length, true) ||
    !validInsertedRow(context.field, operation.value)
  )
    return 'schema';
  if (held === undefined) write(current, context.path, [operation.value]);
  else rows.splice(operation.index, 0, operation.value);
};

const replaceRow = (
  field: Field,
  rows: unknown[],
  operation: Extract<ListOperation, { type: 'replace' }>,
): FieldCommandFailure | undefined => {
  if (!validListIndex(operation.index, rows.length) || !validInsertedRow(field, operation.value))
    return 'schema';
  const replacementId = isRecord(operation.value) ? operation.value._id : undefined;
  if (
    typeof replacementId === 'string' &&
    rows.some(
      (row, index) => index !== operation.index && isRecord(row) && row._id === replacementId,
    )
  )
    return 'ambiguous';
  rows.splice(operation.index, 1, operation.value);
};

const removeRow = (
  rows: unknown[],
  operation: Extract<ListOperation, { type: 'remove' }>,
): FieldCommandFailure | undefined => {
  if (!validListIndex(operation.index, rows.length)) return 'deleted';
  rows.splice(operation.index, 1);
};

const moveRow = (
  rows: unknown[],
  operation: Extract<ListOperation, { type: 'move' }>,
): FieldCommandFailure | undefined => {
  if (!validListIndex(operation.from, rows.length) || !validListIndex(operation.to, rows.length))
    return 'deleted';
  if (operation.from !== operation.to)
    rows.splice(operation.to, 0, ...rows.splice(operation.from, 1));
};

export function createEntryStructure({
  sourceLocale,
  form,
  snapshots,
  openedRevisions,
  locales,
  versionOf,
  mutated,
  history,
}: {
  sourceLocale: string;
  form: Form | undefined;
  snapshots: () => Record<string, EntryData>;
  openedRevisions: () => Record<string, string | undefined>;
  locales: () => string[];
  versionOf: (locale: string) => number;
  mutated: (locale: string) => number;
  history: () => Pick<ReturnType<typeof createEntryHistory>, 'recordStructure'>;
}) {
  const pendingStructure = $state<PendingStructure[]>([]);

  const listTarget = (snapshot: EntryData, address: string) => {
    if (!form) return undefined;
    const resolved = resolveFieldTarget(form, address, snapshot);
    if (!resolved.ok) return undefined;
    const context = fieldContext(form, resolved.target.path, snapshot);
    if (
      !context ||
      resolved.target.path.length !== context.path.length ||
      (context.field.type !== 'array' && context.field.type !== 'blocks')
    )
      return undefined;
    const held = read(snapshot, context.path);
    const rows = held === undefined ? [] : Array.isArray(held) ? held : undefined;
    return rows ? { context, held, rows } : undefined;
  };

  // Capture only row-owned locale data; entry metadata and parent identities never enter seeds.
  const captureSeeds = (address: string): Record<string, LocaleSeed[]> => {
    const captured: Record<string, LocaleSeed[]> = {};
    for (const locale of locales()) {
      const snapshot = snapshots()[locale];
      const target = snapshot && listTarget(snapshot, address);
      if (!snapshot || !target) continue;
      captured[locale] = target.rows.flatMap((row) => {
        const id = rowId(row);
        if (!id || !isRecord(row)) return [];
        const at = rowAddress(address, id);
        const machine = scopedMachine(snapshot, at);
        return [
          {
            address: at,
            value: clone(row),
            ...(machine.length ? { machine: [...machine] } : {}),
          },
        ];
      });
    }
    return captured;
  };

  const seedsForInsertedRows = (
    before: readonly unknown[],
    after: readonly unknown[],
    seeds: Record<string, LocaleSeed[]>,
  ) => {
    const inserted = insertedIds(before, after);
    const selected: Record<string, LocaleSeed[]> = {};
    for (const [locale, localeSeeds] of Object.entries(seeds)) {
      if (locale === sourceLocale) continue;
      const rows = localeSeeds.filter((seed) => {
        const id = rowId(seed.value);
        return id !== undefined && inserted.has(id);
      });
      if (rows.length) selected[locale] = rows;
    }
    return selected;
  };

  const queueStructure = (
    address: string,
    before: readonly unknown[],
    after: readonly unknown[],
    seeds: Record<string, LocaleSeed[]>,
  ) => {
    pendingStructure.push({
      container: address,
      seeds: seedsForInsertedRows(before, after, seeds),
      version: versionOf(sourceLocale),
    });
  };

  const projectLocales = (
    before: EntryData,
    after: EntryData,
    restoration: Record<string, LocaleSeed[]> = {},
  ) => {
    if (!form) return;
    for (const locale of locales()) {
      if (locale === sourceLocale) continue;
      const target = snapshots()[locale];
      if (!target) continue;
      const projected = syncLocale(form, locale, { before, after }, target, {
        seeds: restoration[locale],
      });
      if (!Object.hasOwn(target, '_version')) delete projected._version;
      if (equal(target, projected)) continue;
      snapshots()[locale] = projected;
      mutated(locale);
    }
  };

  // Also fills `seeds` with each locale's copy of the duplicated row.
  const duplicateRow = (
    current: EntryData,
    address: string,
    rows: unknown[],
    beforeRows: readonly unknown[],
    operation: Extract<ListOperation, { type: 'duplicate' }>,
    seeds: Record<string, LocaleSeed[]>,
  ): FieldCommandFailure | undefined => {
    if (!validListIndex(operation.index, rows.length)) return 'deleted';
    const original = rows[operation.index];
    const originalId = rowId(original);
    if (!originalId || !isRecord(original)) return 'schema';
    const ids = new Map<string, string>();
    const copy = regenerateIds(original, ids);
    const copyId = rowId(copy);
    if (!copyId || copyId === originalId) return 'ambiguous';
    rows.splice(operation.index + 1, 0, copy);

    for (const locale of locales()) {
      const snapshot = snapshots()[locale];
      const target = snapshot && listTarget(snapshot, address);
      const localeRow = target?.rows.find((row) => rowId(row) === originalId);
      if (!snapshot || !localeRow || !isRecord(localeRow)) continue;
      const localeCopy = regenerateIds(localeRow, ids);
      const localeCopyId = rowId(localeCopy);
      if (!localeCopyId) continue;
      const from = rowAddress(address, originalId);
      const machine = scopedMachine(snapshot, from).map((path) => remapMachinePath(path, ids));
      seeds[locale] = [
        {
          address: rowAddress(address, localeCopyId),
          value: localeCopy,
          ...(machine.length ? { machine } : {}),
        },
      ];
    }
    addInsertedMachinePaths(current, beforeRows, rows, seeds[sourceLocale] ?? []);
  };

  return {
    // The session has already run every gate.
    list(locale: string, current: EntryData, command: ListCommand): ListCommandResult {
      if (!form) return { ok: false, reason: 'schema' };
      const resolved = resolveFieldTarget(form, command.address, current);
      if (!resolved.ok) return resolved;
      const context = fieldContext(form, resolved.target.path, current);
      if (!context || resolved.target.path.length !== context.path.length)
        return { ok: false, reason: 'schema' };
      if (context.field.type !== 'array' && context.field.type !== 'blocks')
        return { ok: false, reason: 'schema' };
      if (!fieldAddress(context.path, current, form)) return { ok: false, reason: 'ambiguous' };
      if (inReferencedBlock(current, context.path)) return { ok: false, reason: 'referenced' };

      const held = read(current, context.path);
      const rows = held === undefined ? [] : Array.isArray(held) ? held : undefined;
      if (!rows) return { ok: false, reason: 'schema' };
      if (duplicateRowId(rows)) return { ok: false, reason: 'ambiguous' };

      const operation = command.operation;
      const beforeSource = clone(current);
      const beforeRows = clone(rows);
      const beforeSeeds = captureSeeds(command.address);
      const duplicateSeeds: Record<string, LocaleSeed[]> = {};
      const refused =
        operation.type === 'insert'
          ? insertRow(current, context, held, rows, operation)
          : operation.type === 'replace'
            ? replaceRow(context.field, rows, operation)
            : operation.type === 'remove'
              ? removeRow(rows, operation)
              : operation.type === 'move'
                ? moveRow(rows, operation)
                : duplicateRow(
                    current,
                    command.address,
                    rows,
                    beforeRows,
                    operation,
                    duplicateSeeds,
                  );
      if (refused) return { ok: false, reason: refused };
      const afterRows = clone(listTarget(current, command.address)?.rows ?? []);
      if (equal(beforeRows, afterRows)) return { ok: true, contentVersion: command.contentVersion };
      updateRemovedMachinePaths(current, command.address, beforeRows, afterRows);
      const nextVersion = mutated(locale);
      projectLocales(beforeSource, current, duplicateSeeds);
      const afterSeeds = captureSeeds(command.address);
      history().recordStructure({
        type: 'structure',
        address: command.address,
        before: held === undefined ? undefined : beforeRows,
        after: afterRows,
        beforeSeeds,
        afterSeeds,
      });
      queueStructure(command.address, beforeRows, afterRows, afterSeeds);
      return { ok: true, contentVersion: nextVersion };
    },
    restore(
      transaction: StructuralHistoryTransaction,
      direction: 'redo' | 'undo',
    ): FieldCommandResult {
      const current = snapshots()[sourceLocale];
      if (!current) return { ok: false, reason: 'schema' };
      const target = listTarget(current, transaction.address);
      if (!target) return { ok: false, reason: 'deleted' };
      const expected = direction === 'undo' ? transaction.after : transaction.before;
      const destination = direction === 'undo' ? transaction.before : transaction.after;
      const seeds = direction === 'undo' ? transaction.beforeSeeds : transaction.afterSeeds;
      if (!equal(target.rows, expected ?? [])) return { ok: false, reason: 'stale' };

      const beforeSource = clone(current);
      const beforeRows = clone(target.rows);
      write(current, target.context.path, clone(destination));
      const afterRows = destination ?? [];
      updateRemovedMachinePaths(current, transaction.address, beforeRows, afterRows);
      addInsertedMachinePaths(current, beforeRows, afterRows, seeds[sourceLocale] ?? []);
      const nextVersion = mutated(sourceLocale);
      projectLocales(beforeSource, current, seeds);
      queueStructure(transaction.address, beforeRows, afterRows, seeds);
      return { ok: true, contentVersion: nextVersion };
    },
    hasPending(contentVersion: number): boolean {
      return pendingStructure.some((item) => item.version <= contentVersion);
    },
    envelope(contentVersion: number): StructuralSaveEnvelope | undefined {
      if (!form) return undefined;
      const pending = pendingStructure.filter((item) => item.version <= contentVersion);
      if (!pending.length) return undefined;
      const revisions: Record<string, string> = {};
      for (const locale of locales()) {
        const revision = openedRevisions()[locale];
        if (!revision) return undefined;
        revisions[locale] = revision;
      }
      const source = snapshots()[sourceLocale];
      if (!source) return undefined;
      const containers = [
        ...new Set(
          pending
            .map((item) => item.container)
            .filter((address) => listTarget(source, address) !== undefined),
        ),
      ];
      if (!containers.length) return undefined;
      const seeds = new Map<string, Map<string, LocaleSeed>>();
      for (const item of pending)
        for (const [locale, localeSeeds] of Object.entries(item.seeds)) {
          const held = seeds.get(locale) ?? new Map<string, LocaleSeed>();
          seeds.set(locale, held);
          for (const seed of localeSeeds) {
            const container = containers.find((address) =>
              seed.address.startsWith(`${address}[_id=`),
            );
            const resolved = resolveFieldTarget(form, seed.address, source);
            if (container && resolved.ok && resolved.target.address === seed.address)
              held.set(seed.address, clone(seed));
          }
        }
      return {
        containers,
        revisions,
        seeds: Object.fromEntries(
          [...seeds]
            .filter(([, localeSeeds]) => localeSeeds.size)
            .map(([locale, localeSeeds]) => [locale, [...localeSeeds.values()]]),
        ),
      };
    },
    settle(contentVersion: number): void {
      pendingStructure.splice(
        0,
        pendingStructure.length,
        ...pendingStructure.filter((item) => item.version > contentVersion),
      );
    },
  };
}
