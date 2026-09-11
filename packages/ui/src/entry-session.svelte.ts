import {
  type Drift,
  type Field,
  type FieldTargetResult,
  type Form,
  fieldAddress,
  fieldPosition,
  type LocaleSeed,
  regenerateIds,
  resolveFieldTarget,
  syncLocale,
  TRANSLATED_PROPS,
} from '@handover/core';
import { type SaveState, saveCoordinator, saveLane } from './save';

export type EntryData = Record<string, unknown>;
export type EntryProblem = { path: string; message: string };

export type EntrySession = ReturnType<typeof createEntrySession>;

export type FieldChange = { path?: readonly string[]; value: unknown };
export type LogicalSelection = {
  /** Stable entry identity; prevents a selection leaking into a replacement document. */
  document: string;
  locale: string;
  /** Stable field address, independent of the row's current position. */
  address: string;
  kind?: 'text' | 'node';
  anchor?: number;
  head?: number;
};
export type FieldHistory = {
  /** Typing coalesces for one second; a shared composition id coalesces until its boundary. */
  kind?: 'change' | 'composition' | 'format' | 'paste' | 'typing';
  group?: string;
  before?: LogicalSelection;
  after?: LogicalSelection;
};
export type FieldCommand = {
  /** Stable address at or within the schema field which owns every relative change. */
  address: string;
  /** The local snapshot version this command was made against. */
  contentVersion: number;
  changes: readonly FieldChange[];
  /** Optional editing intent and selection carried by this reversible transaction. */
  history?: FieldHistory;
};
export type FieldCommandFailure =
  | 'ambiguous'
  | 'closed'
  | 'deleted'
  | 'drift'
  | 'readonly'
  | 'referenced'
  | 'schema'
  | 'stale'
  | 'structural';
export type FieldCommandResult =
  | { ok: true; contentVersion: number }
  | { ok: false; reason: FieldCommandFailure };

export type HistoryFailure = FieldCommandFailure | 'empty' | 'frozen';
export type HistoryResult =
  | { ok: true; contentVersion: number; selection?: LogicalSelection }
  | { ok: false; reason: HistoryFailure };

export type ListOperation =
  | { type: 'insert'; index: number; value: unknown }
  | { type: 'replace'; index: number; value: unknown }
  | { type: 'remove'; index: number }
  | { type: 'move'; from: number; to: number }
  | { type: 'duplicate'; index: number };
export type ListCommand = {
  /** Stable address of the array or block-list field being changed. */
  address: string;
  /** The local snapshot version this command was made against. */
  contentVersion: number;
  operation: ListOperation;
};
export type ListCommandResult = FieldCommandResult;

export type StructuralSaveEnvelope = {
  containers: string[];
  revisions: Record<string, string>;
  seeds: Record<string, LocaleSeed[]>;
};

export type MachineTranslationResponse = {
  data: EntryData;
  pending: boolean;
  revision?: string;
};
export type MachineTranslationFailure = 'busy' | 'closed' | 'drift' | 'request' | 'save' | 'stale';
export type MachineTranslationResult =
  | { ok: true; response: MachineTranslationResponse }
  | { ok: false; reason: MachineTranslationFailure };

export type HistoricalRestoreResponse = { ok: true } | { ok: false; error: string };
export type HistoricalRestoreFailure =
  | 'busy'
  | 'closed'
  | 'refused'
  | 'reload'
  | 'save'
  | 'stale'
  | 'uncertain';
export type HistoricalRestoreResult =
  | { ok: true }
  | { ok: false; reason: HistoricalRestoreFailure; error?: string };

type FieldContext = {
  field: Field;
  mode: true | 'duplicate' | false;
  path: string[];
};

type HistoryChange = { path: string[]; value: unknown };
type FieldHistoryTransaction = {
  type: 'field';
  address: string;
  after?: LogicalSelection;
  before?: LogicalSelection;
  forward: HistoryChange[];
  inverse: HistoryChange[];
  kind: NonNullable<FieldHistory['kind']>;
  locale: string;
};

type StructuralHistoryTransaction = {
  type: 'structure';
  address: string;
  before: unknown[] | undefined;
  after: unknown[] | undefined;
  beforeSeeds: Record<string, LocaleSeed[]>;
  afterSeeds: Record<string, LocaleSeed[]>;
};

type HistoryTransaction = FieldHistoryTransaction | StructuralHistoryTransaction;

type PendingStructure = {
  container: string;
  seeds: Record<string, LocaleSeed[]>;
  version: number;
};

type ActiveHistoryGroup = {
  address: string;
  group?: string;
  kind: 'composition' | 'typing';
  locale: string;
  startedAt: number;
};

const object = (value: unknown): value is EntryData =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    );
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
  );
};

const indexOf = (key: string, length: number): number | undefined => {
  if (!/^\d+$/.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length ? index : undefined;
};

const read = (root: unknown, path: readonly string[]) =>
  path.reduce<unknown>(
    (node, key) =>
      Array.isArray(node)
        ? node[indexOf(key, node.length) ?? -1]
        : object(node)
          ? node[key]
          : undefined,
    root,
  );

/** Find the owning field and inherited translation mode for one resolved positional path. */
function fieldContext(
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
        (parent, key) => (object(parent) ? parent[key] : undefined),
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
        const type = object(item) && typeof item._type === 'string' ? item._type : '';
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

function write(root: EntryData, path: readonly string[], value: unknown): void {
  let node: Record<string, unknown> = root;
  for (const key of path.slice(0, -1)) {
    const current = node[key];
    if (!object(current) && !Array.isArray(current)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const key = path.at(-1);
  if (key === undefined) return;
  if (value === undefined) delete node[key];
  else node[key] = value;
}

const STRUCTURAL = new Set<Field['type']>(['array', 'blocks', 'group', 'menus']);
const PROPERTIES: Partial<Record<Field['type'], readonly string[]>> = {
  link: ['type', 'ref', 'href', 'label', 'newTab'],
  image: ['src', 'alt', 'width', 'height', 'focal'],
  file: ['src', 'name', 'bytes', 'mime'],
  embed: ['provider', 'id', 'title', 'start'],
  seo: [
    'title',
    'description',
    'image',
    'image.src',
    'image.alt',
    'image.width',
    'image.height',
    'image.focal',
    'noindex',
    'canonical',
  ],
};

const allowedPath = (field: Field, path: readonly string[]) =>
  !path.length || PROPERTIES[field.type]?.includes(path.join('.')) === true;

const inReferencedBlock = (root: unknown, path: readonly string[]) => {
  let node: unknown = root;
  for (const key of path) {
    if (object(node) && typeof node._ref === 'string') return true;
    node = Array.isArray(node)
      ? node[indexOf(key, node.length) ?? -1]
      : object(node)
        ? node[key]
        : undefined;
  }
  return false;
};

const validListIndex = (index: number, length: number, insert = false) =>
  Number.isSafeInteger(index) && index >= 0 && index < length + (insert ? 1 : 0);

const validInsertedRow = (field: Field, value: unknown) => {
  if (field.type === 'blocks') {
    if (!object(value) || typeof value._id !== 'string' || typeof value._type !== 'string')
      return false;
    if (!field.types.includes(value._type)) return false;
    return true;
  }
  return field.type === 'array';
};

const duplicateRowId = (rows: readonly unknown[]) => {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!object(row) || typeof row._id !== 'string') continue;
    if (seen.has(row._id)) return true;
    seen.add(row._id);
  }
  return false;
};

const rowId = (row: unknown): string | undefined =>
  object(row) && typeof row._id === 'string' ? row._id : undefined;

const rowAddress = (container: string, id: string) => `${container}[_id=${id}]`;

const machinePaths = (snapshot: EntryData): string[] =>
  Array.isArray(snapshot._machine)
    ? snapshot._machine.filter((path): path is string => typeof path === 'string')
    : [];

const scopedMachine = (snapshot: EntryData, address: string): string[] =>
  machinePaths(snapshot).filter((path) => path.startsWith(`${address}.`));

const setMachinePaths = (snapshot: EntryData, paths: readonly string[]) => {
  if (paths.length) snapshot._machine = [...new Set(paths)];
  else delete snapshot._machine;
};

const remapMachinePath = (path: string, ids: ReadonlyMap<string, string>) =>
  path.replace(/\[_id=([0-9a-z]+)\]/g, (_match, old: string) => `[_id=${ids.get(old) ?? old}]`);

const sourceTextChange = (context: FieldContext, changes: readonly { path: readonly string[] }[]) =>
  (context.mode === true &&
    (context.field.type === 'text' || context.field.type === 'richtext') &&
    changes.every((change) => change.path.length === 0)) ||
  (context.field.type === 'link' &&
    context.mode === true &&
    changes.every((change) => change.path.join('.') === 'label'));

/** Working locale files and their opaque revisions for the lifetime of one opened entry. */
export function createEntrySession({
  document = 'default',
  sourceLocale,
  data,
  translations,
  revisions = {},
  form,
  problems = {},
  drift = [],
  onactivity,
  onreconciled,
}: {
  /** Stable identity shared by every logical selection in this entry-lifetime session. */
  document?: string;
  sourceLocale: string;
  data: EntryData;
  translations: Record<string, EntryData>;
  revisions?: Record<string, string>;
  form?: Form;
  problems?: Record<string, EntryProblem[]>;
  /** Unresolved structural disagreement blocks every editing surface in this session. */
  drift?: readonly Drift[];
  /** One local mutation, regardless of which editing surface produced it. */
  onactivity?: () => void;
  /** Re-read the complete entry after reconciliation, including every loaded locale. */
  onreconciled?: () => void | Promise<void>;
}) {
  const snapshots = $state<Record<string, EntryData>>(
    structuredClone({ ...translations, [sourceLocale]: data }),
  );
  const initialSerialized = Object.fromEntries(
    Object.entries(snapshots).map(([locale, snapshot]) => [locale, JSON.stringify(snapshot)]),
  );
  const openedRevisions = $state<Record<string, string | undefined>>({ ...revisions });
  const saveStates = $state<Record<string, SaveState>>(
    Object.fromEntries(
      Object.entries(initialSerialized).map(([locale, saved]) => [
        locale,
        { saved, phase: 'idle' },
      ]),
    ),
  );
  const versions = $state<Record<string, number>>(
    Object.fromEntries(Object.keys(snapshots).map((locale) => [locale, 0])),
  );
  const savedVersions = $state<Record<string, number>>(
    Object.fromEntries(Object.keys(snapshots).map((locale) => [locale, 0])),
  );
  const serialized = new Map<string, { version: number; value: string }>(
    Object.entries(initialSerialized).map(([locale, value]) => [locale, { version: 0, value }]),
  );
  const validation = $state<Record<string, Record<string, string>>>({});
  const undoStack = $state<HistoryTransaction[]>([]);
  const redoStack = $state<HistoryTransaction[]>([]);
  const pendingStructure = $state<PendingStructure[]>([]);
  const coordinators = new Map<string, ReturnType<typeof saveCoordinator>>();
  const drifted = drift.length > 0;
  let lane: ReturnType<typeof saveLane> | undefined;
  let mutationOpen = true;
  let epoch = 0;
  let persistedAction = $state<
    | {
        id: number;
        kind: 'machine-translation';
        locale: string;
        phase: 'preflush' | 'running';
        epoch: number;
      }
    | {
        id: number;
        kind: 'historical-restore';
        phase: 'preflush' | 'running' | 'reloading';
        epoch: number;
      }
    | undefined
  >();
  let nextActionId = 0;
  let historyIsFrozen = $state(false);
  let activeHistoryGroup: ActiveHistoryGroup | undefined;
  let logicalSelection = $state<LogicalSelection>();
  let replayingHistory = false;

  const locales = () => [sourceLocale, ...Object.keys(snapshots).filter((l) => l !== sourceLocale)];
  const coordinator = (locale: string) => {
    const found = coordinators.get(locale);
    if (!found) throw new Error(`Autosave is not configured for the ${locale} locale.`);
    return found;
  };
  const dirty = (locale: string) =>
    (versions[locale] ?? 0) !== (savedVersions[locale] ?? 0) ||
    saveStates[locale]?.phase === 'saving';
  const versionOf = (locale: string) => versions[locale] ?? 0;
  const mutated = (locale: string) => {
    versions[locale] = versionOf(locale) + 1;
    serialized.delete(locale);
    coordinators.get(locale)?.change();
    onactivity?.();
    return versions[locale] as number;
  };
  const serialize = (locale: string) => {
    const version = versionOf(locale);
    const found = serialized.get(locale);
    if (found?.version === version) return found.value;
    const value = JSON.stringify(snapshots[locale]);
    serialized.set(locale, { version, value });
    return value;
  };
  const clone = <T>(value: T): T => {
    if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
    if (object(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, clone(item)]),
      ) as T;
    return value;
  };
  const sameSelection = (a: LogicalSelection | undefined, b: LogicalSelection | undefined) =>
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.document === b.document &&
      a.locale === b.locale &&
      a.address === b.address &&
      a.kind === b.kind &&
      a.anchor === b.anchor &&
      a.head === b.head);
  const validSelection = (
    locale: string,
    selection: LogicalSelection | undefined,
  ): LogicalSelection | undefined => {
    const current = snapshots[locale];
    if (
      !selection ||
      selection.document !== document ||
      selection.locale !== locale ||
      !current ||
      !form
    )
      return undefined;
    return resolveFieldTarget('default', form, selection.address, current).ok
      ? clone(selection)
      : undefined;
  };
  const clearActiveHistoryGroup = () => {
    activeHistoryGroup = undefined;
  };
  const resetHistory = () => {
    undoStack.splice(0);
    redoStack.splice(0);
    logicalSelection = undefined;
    clearActiveHistoryGroup();
    historyIsFrozen = !mutationOpen;
  };
  const freezeHistory = () => {
    historyIsFrozen = true;
    clearActiveHistoryGroup();
  };
  const resetLocaleHistory = (locale: string) => {
    const belongsToLocale = (item: HistoryTransaction) =>
      item.type === 'structure' ? Object.hasOwn(item.beforeSeeds, locale) : item.locale === locale;
    undoStack.splice(0, undoStack.length, ...undoStack.filter((item) => !belongsToLocale(item)));
    redoStack.splice(0, redoStack.length, ...redoStack.filter((item) => !belongsToLocale(item)));
    if (activeHistoryGroup?.locale === locale) clearActiveHistoryGroup();
    if (logicalSelection?.locale === locale) logicalSelection = undefined;
  };
  const normalize = (snapshot: EntryData, found: EntryProblem[]) => {
    const normalized: Record<string, string> = {};
    for (const problem of found) {
      const address = fieldAddress(
        'default',
        problem.path ? problem.path.split('.') : [],
        snapshot,
        form,
      );
      // A duplicate id cannot safely attach an error to either occurrence.
      if (address !== undefined && normalized[address] === undefined)
        normalized[address] = problem.message;
    }
    return normalized;
  };
  const drain = async (): Promise<boolean> => {
    do {
      for (const locale of locales()) {
        if (!(await coordinator(locale).flush())) return false;
      }
    } while (locales().some(dirty));
    return true;
  };

  for (const [locale, found] of Object.entries(problems)) {
    const snapshot = snapshots[locale];
    if (snapshot) validation[locale] = normalize(snapshot, found);
  }

  const setHistorySelection = (selection?: LogicalSelection) => {
    const next = selection ? validSelection(selection.locale, selection) : undefined;
    if (!sameSelection(logicalSelection, next)) clearActiveHistoryGroup();
    logicalSelection = next;
  };

  const recordHistory = (
    locale: string,
    address: string,
    forward: HistoryChange[],
    inverse: HistoryChange[],
    history: FieldHistory | undefined,
  ) => {
    if (historyIsFrozen || replayingHistory) return;
    const before = validSelection(locale, history?.before ?? logicalSelection);
    const after = validSelection(locale, history?.after ?? before);
    const simpleText =
      forward.length === 1 &&
      (typeof forward[0]?.value === 'string' || forward[0]?.value === undefined) &&
      (typeof inverse[0]?.value === 'string' || inverse[0]?.value === undefined);
    const kind = history?.kind ?? (simpleText ? 'typing' : 'change');
    const now = Date.now();
    const current = undoStack.at(-1);
    const sameTarget =
      activeHistoryGroup?.locale === locale && activeHistoryGroup.address === address;
    const groupedTyping =
      kind === 'typing' &&
      activeHistoryGroup?.kind === 'typing' &&
      sameTarget &&
      now - activeHistoryGroup.startedAt <= 1000 &&
      current?.type === 'field' &&
      sameSelection(current.after, before);
    const groupedComposition =
      kind === 'composition' &&
      history?.group !== undefined &&
      activeHistoryGroup?.kind === 'composition' &&
      sameTarget &&
      activeHistoryGroup.group === history.group;

    if (current?.type === 'field' && (groupedTyping || groupedComposition)) {
      current.forward.push(...forward);
      current.inverse.unshift(...inverse);
      current.after = after;
    } else {
      undoStack.push({ type: 'field', address, after, before, forward, inverse, kind, locale });
    }
    redoStack.splice(0);
    logicalSelection = after;
    activeHistoryGroup =
      kind === 'typing' || (kind === 'composition' && history?.group !== undefined)
        ? {
            address,
            group: history?.group,
            kind,
            locale,
            startedAt: groupedTyping
              ? (activeHistoryGroup?.startedAt ?? now)
              : groupedComposition
                ? (activeHistoryGroup?.startedAt ?? now)
                : now,
          }
        : undefined;
  };

  const listTarget = (snapshot: EntryData, address: string) => {
    if (!form) return undefined;
    const resolved = resolveFieldTarget('default', form, address, snapshot);
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

  /** Capture only row-owned locale data; entry metadata and parent identities never enter seeds. */
  const captureSeeds = (address: string): Record<string, LocaleSeed[]> => {
    const captured: Record<string, LocaleSeed[]> = {};
    for (const locale of locales()) {
      const snapshot = snapshots[locale];
      const target = snapshot && listTarget(snapshot, address);
      if (!snapshot || !target) continue;
      captured[locale] = target.rows.flatMap((row) => {
        const id = rowId(row);
        if (!id || !object(row)) return [];
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

  const insertedIds = (before: readonly unknown[], after: readonly unknown[]) => {
    const beforeIds = new Set(before.map(rowId).filter((id): id is string => id !== undefined));
    return new Set(
      after.map(rowId).filter((id): id is string => id !== undefined && !beforeIds.has(id)),
    );
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
      const target = snapshots[locale];
      if (!target) continue;
      const projected = syncLocale('default', form, locale, { before, after }, target, {
        seeds: restoration[locale],
      });
      if (!Object.hasOwn(target, '_version')) delete projected._version;
      if (equal(target, projected)) continue;
      snapshots[locale] = projected;
      mutated(locale);
    }
  };

  const updateRemovedMachinePaths = (
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

  const addInsertedMachinePaths = (
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

  const restoreStructure = (
    transaction: StructuralHistoryTransaction,
    direction: 'redo' | 'undo',
  ): FieldCommandResult => {
    const current = snapshots[sourceLocale];
    if (!current) return { ok: false, reason: 'schema' };
    const target = listTarget(current, transaction.address);
    if (!target) return { ok: false, reason: 'deleted' };
    const expected = direction === 'undo' ? transaction.after : transaction.before;
    const destination = direction === 'undo' ? transaction.before : transaction.after;
    const seeds = direction === 'undo' ? transaction.beforeSeeds : transaction.afterSeeds;
    if (!equal(target.rows, expected ?? [])) return { ok: false, reason: 'stale' };

    const beforeSource = clone(current);
    const beforeRows = clone(target.rows);
    if (destination === undefined) write(current, target.context.path, undefined);
    else write(current, target.context.path, clone(destination));
    const afterRows = destination ?? [];
    updateRemovedMachinePaths(current, transaction.address, beforeRows, afterRows);
    addInsertedMachinePaths(current, beforeRows, afterRows, seeds[sourceLocale] ?? []);
    const nextVersion = mutated(sourceLocale);
    projectLocales(beforeSource, current, seeds);
    queueStructure(transaction.address, beforeRows, afterRows, seeds);
    return { ok: true, contentVersion: nextVersion };
  };

  const structuralEnvelope = (contentVersion: number): StructuralSaveEnvelope | undefined => {
    if (!form) return undefined;
    const pending = pendingStructure.filter((item) => item.version <= contentVersion);
    if (!pending.length) return undefined;
    const revisions: Record<string, string> = {};
    for (const locale of locales()) {
      const revision = openedRevisions[locale];
      if (!revision) return undefined;
      revisions[locale] = revision;
    }
    const source = snapshots[sourceLocale];
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
          const resolved = resolveFieldTarget('default', form, seed.address, source);
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
  };

  const runFieldCommand = (locale: string, command: FieldCommand): FieldCommandResult => {
    const current = snapshots[locale];
    if (!current || !form) return { ok: false, reason: 'schema' };
    if (drifted) return { ok: false, reason: 'drift' };
    if (!mutationOpen) return { ok: false, reason: 'closed' };
    if (
      persistedAction &&
      (persistedAction.kind === 'historical-restore' ||
        persistedAction.phase === 'preflush' ||
        locale !== sourceLocale)
    )
      return { ok: false, reason: 'closed' };
    const beforeVersion = versionOf(locale);
    if (command.contentVersion !== beforeVersion) return { ok: false, reason: 'stale' };

    const resolved = resolveFieldTarget('default', form, command.address, current);
    if (!resolved.ok) return resolved;
    const context = fieldContext(form, resolved.target.path, current);
    if (!context) return { ok: false, reason: 'schema' };
    const ownerAddress = fieldAddress('default', context.path, current, form);
    if (!ownerAddress) return { ok: false, reason: 'ambiguous' };
    if (inReferencedBlock(current, context.path)) return { ok: false, reason: 'referenced' };
    if (STRUCTURAL.has(context.field.type)) return { ok: false, reason: 'structural' };
    if (context.field.type === 'unsupported') return { ok: false, reason: 'readonly' };

    const base = resolved.target.path.slice(context.path.length);
    const changes = command.changes.map((change) => ({
      path: [...base, ...(change.path ?? [])],
      value: clone(change.value),
    }));
    if (!changes.length || changes.some((change) => !allowedPath(context.field, change.path)))
      return { ok: false, reason: 'schema' };

    if (persistedAction && !sourceTextChange(context, changes))
      return { ok: false, reason: 'closed' };

    if (locale !== sourceLocale) {
      if (context.mode !== true) return { ok: false, reason: 'readonly' };
      const translated = TRANSLATED_PROPS[context.field.type];
      if (
        translated
          ? changes.some((change) => !translated.includes(change.path.join('.')))
          : context.field.type === 'reference' || changes.some((change) => change.path.length > 0)
      )
        return { ok: false, reason: 'readonly' };
    }

    const beforeSource = locale === sourceLocale ? clone(current) : undefined;
    const inverse: HistoryChange[] = [];
    for (const change of changes) {
      const path = [...context.path, ...change.path];
      inverse.unshift({ path: [...change.path], value: clone(read(current, path)) });
      write(current, path, clone(change.value));
    }
    const changed = changes.some(
      (change, index) => !equal(change.value, inverse.at(-1 - index)?.value),
    );
    const nextVersion = changed ? mutated(locale) : beforeVersion;
    if (changed) {
      if (beforeSource) projectLocales(beforeSource, current);
      recordHistory(locale, ownerAddress, changes, inverse, command.history);
    } else if (command.history?.after) {
      setHistorySelection(command.history.after);
    }
    return { ok: true, contentVersion: nextVersion };
  };

  const replayHistory = (
    from: HistoryTransaction[],
    to: HistoryTransaction[],
    direction: 'redo' | 'undo',
  ): HistoryResult => {
    if (historyIsFrozen) return { ok: false, reason: 'frozen' };
    if (persistedAction) return { ok: false, reason: 'closed' };
    const transaction = from.at(-1);
    if (!transaction) return { ok: false, reason: 'empty' };
    clearActiveHistoryGroup();
    replayingHistory = true;
    let result: FieldCommandResult;
    try {
      result =
        transaction.type === 'structure'
          ? restoreStructure(transaction, direction)
          : runFieldCommand(transaction.locale, {
              address: transaction.address,
              contentVersion: versionOf(transaction.locale),
              changes: direction === 'undo' ? transaction.inverse : transaction.forward,
            });
    } finally {
      replayingHistory = false;
    }
    if (!result.ok) return result;
    from.pop();
    to.push(transaction);
    const selection = validSelection(
      transaction.type === 'structure' ? sourceLocale : transaction.locale,
      transaction.type === 'structure'
        ? undefined
        : direction === 'undo'
          ? transaction.before
          : transaction.after,
    );
    logicalSelection = selection;
    return selection ? { ...result, selection } : result;
  };

  return {
    snapshots,
    documentIdentity(): string {
      return document;
    },
    hasSnapshot(locale: string): boolean {
      return Object.hasOwn(snapshots, locale);
    },
    snapshot(locale: string): EntryData {
      const snapshot = snapshots[locale];
      if (!snapshot) throw new Error(`The ${locale} locale is not loaded in this entry session.`);
      return snapshot;
    },
    replaceSnapshot(locale: string, snapshot: EntryData): void {
      if (!equal(snapshots[locale], snapshot)) {
        snapshots[locale] = structuredClone(snapshot);
        mutated(locale);
      }
      resetLocaleHistory(locale);
    },
    /** Apply the source document's derived locale projection without creating a history boundary. */
    synchronizeSnapshot(locale: string, snapshot: EntryData): void {
      if (!equal(snapshots[locale], snapshot)) {
        snapshots[locale] = structuredClone(snapshot);
        mutated(locale);
      }
    },
    contentVersion(locale: string): number {
      return versionOf(locale);
    },
    /** Materialize plain snapshot data only when a Canvas render is actually requested. */
    renderSnapshots(): Record<string, EntryData> {
      return structuredClone($state.snapshot(snapshots));
    },
    revision(locale: string): string | undefined {
      return openedRevisions[locale];
    },
    setRevision(locale: string, revision: string): void {
      openedRevisions[locale] = revision;
    },
    mergeRevisions(revisions: Record<string, string> | undefined): void {
      if (!revisions) return;
      for (const [locale, revision] of Object.entries(revisions)) {
        openedRevisions[locale] = revision;
      }
    },
    saveState(locale: string): SaveState {
      const state = saveStates[locale];
      if (!state) throw new Error(`The ${locale} locale is not loaded in this entry session.`);
      return state;
    },
    /** Configure once so save scheduling survives locale-pane mount cycles. */
    configureAutosave(
      write: (
        locale: string,
        snapshot: string,
        revision: string | undefined,
        contentVersion: number,
        structure?: StructuralSaveEnvelope,
      ) => Promise<boolean>,
    ): void {
      if (coordinators.size) throw new Error('Autosave is already configured for this entry.');
      lane = saveLane();
      for (const locale of locales()) {
        const initial = saveStates[locale];
        if (!initial) continue;
        coordinators.set(
          locale,
          saveCoordinator({
            current: () => serialize(locale),
            dirty: () => dirty(locale),
            saved: initial.saved,
            lane,
            write: async (snapshot) => {
              const sentVersion = versionOf(locale);
              const hasStructure =
                locale === sourceLocale &&
                pendingStructure.some((item) => item.version <= sentVersion);
              const structure =
                locale === sourceLocale ? structuralEnvelope(sentVersion) : undefined;
              // Never silently downgrade a structural save when its complete revision set is gone.
              if (hasStructure && !structure) return false;
              const saved = structure
                ? await write(locale, snapshot, openedRevisions[locale], sentVersion, structure)
                : await write(locale, snapshot, openedRevisions[locale], sentVersion);
              if (saved) savedVersions[locale] = sentVersion;
              if (saved && locale === sourceLocale && structure)
                pendingStructure.splice(
                  0,
                  pendingStructure.length,
                  ...pendingStructure.filter((item) => item.version > sentVersion),
                );
              return saved;
            },
            onstate: (state) => {
              saveStates[locale] = state;
            },
          }),
        );
      }
    },
    change(locale: string): void {
      coordinator(locale).change();
    },
    /** Store wire-format errors by stable identity only when they describe the current version. */
    acceptProblems(
      locale: string,
      found: EntryProblem[],
      validatedSnapshot: string,
      validatedVersion: number,
    ): boolean {
      if (validatedVersion !== versionOf(locale) || validatedSnapshot !== serialize(locale))
        return false;
      validation[locale] = normalize(JSON.parse(validatedSnapshot) as EntryData, found);
      return true;
    },
    /** Stable addresses are consumed directly by Canvas and future session commands. */
    problemAddresses(locale: string): Record<string, string> {
      return { ...(validation[locale] ?? {}) };
    },
    /** Form controls still consume the API's positional dotted-path shape. */
    positionalProblems(locale: string): Record<string, string> {
      const current = snapshots[locale];
      if (!current) return {};
      const positional: Record<string, string> = {};
      for (const [address, message] of Object.entries(validation[locale] ?? {})) {
        const path = fieldPosition('default', address, current, form);
        if (path) positional[path.join('.')] = message;
      }
      return positional;
    },
    /** Resolve a command target against this session's current schema and locale data. */
    resolveField(locale: string, address: string): FieldTargetResult {
      const current = snapshots[locale];
      if (!current) throw new Error(`The ${locale} locale is not loaded in this entry session.`);
      return form
        ? resolveFieldTarget('default', form, address, current)
        : { ok: false, reason: 'schema' };
    },
    /** Resolve the schema widget that owns an address, including a structured widget property. */
    inspectField(locale: string, address: string) {
      const current = snapshots[locale];
      if (!current || !form) return { ok: false as const, reason: 'schema' as const };
      const resolved = resolveFieldTarget('default', form, address, current);
      if (!resolved.ok) return resolved;
      const context = fieldContext(form, resolved.target.path, current);
      if (!context) return { ok: false as const, reason: 'schema' as const };
      const ownerAddress = fieldAddress('default', context.path, current, form);
      if (!ownerAddress) return { ok: false as const, reason: 'ambiguous' as const };
      return {
        ok: true as const,
        target: {
          address: ownerAddress,
          field: context.field,
          mode: context.mode,
          path: context.path,
        },
      };
    },
    /** Apply one schema-aware field action after re-resolving its stable target. */
    fieldCommand(locale: string, command: FieldCommand): FieldCommandResult {
      return runFieldCommand(locale, command);
    },
    /** Apply one same-list structural action after re-resolving its stable container. */
    listCommand(locale: string, command: ListCommand): ListCommandResult {
      clearActiveHistoryGroup();
      const current = snapshots[locale];
      if (!current || !form) return { ok: false, reason: 'schema' };
      if (drifted) return { ok: false, reason: 'drift' };
      if (!mutationOpen) return { ok: false, reason: 'closed' };
      if (persistedAction) return { ok: false, reason: 'closed' };
      if (command.contentVersion !== versionOf(locale)) return { ok: false, reason: 'stale' };
      if (locale !== sourceLocale) return { ok: false, reason: 'readonly' };

      const resolved = resolveFieldTarget('default', form, command.address, current);
      if (!resolved.ok) return resolved;
      const context = fieldContext(form, resolved.target.path, current);
      if (!context || resolved.target.path.length !== context.path.length)
        return { ok: false, reason: 'schema' };
      if (context.field.type !== 'array' && context.field.type !== 'blocks')
        return { ok: false, reason: 'schema' };
      if (!fieldAddress('default', context.path, current, form))
        return { ok: false, reason: 'ambiguous' };
      if (inReferencedBlock(current, context.path)) return { ok: false, reason: 'referenced' };

      const held = read(current, context.path);
      const rows = held === undefined ? [] : Array.isArray(held) ? held : undefined;
      if (!rows) return { ok: false, reason: 'schema' };
      if (duplicateRowId(rows)) return { ok: false, reason: 'ambiguous' };

      const operation = command.operation;
      const beforeSource = clone(current);
      const beforeRows = clone(rows);
      const beforeSeeds = captureSeeds(command.address);
      let duplicateSeeds: Record<string, LocaleSeed[]> = {};
      if (operation.type === 'insert') {
        const insertedId = object(operation.value) ? operation.value._id : undefined;
        if (
          typeof insertedId === 'string' &&
          rows.some((row) => object(row) && row._id === insertedId)
        )
          return { ok: false, reason: 'ambiguous' };
        if (
          !validListIndex(operation.index, rows.length, true) ||
          !validInsertedRow(context.field, operation.value)
        )
          return { ok: false, reason: 'schema' };
        if (held === undefined) write(current, context.path, [operation.value]);
        else rows.splice(operation.index, 0, operation.value);
      } else if (operation.type === 'replace') {
        if (
          !validListIndex(operation.index, rows.length) ||
          !validInsertedRow(context.field, operation.value)
        )
          return { ok: false, reason: 'schema' };
        const replacementId = object(operation.value) ? operation.value._id : undefined;
        if (
          typeof replacementId === 'string' &&
          rows.some(
            (row, index) => index !== operation.index && object(row) && row._id === replacementId,
          )
        )
          return { ok: false, reason: 'ambiguous' };
        rows.splice(operation.index, 1, operation.value);
      } else if (operation.type === 'remove') {
        if (!validListIndex(operation.index, rows.length)) return { ok: false, reason: 'deleted' };
        rows.splice(operation.index, 1);
      } else if (operation.type === 'move') {
        if (
          !validListIndex(operation.from, rows.length) ||
          !validListIndex(operation.to, rows.length)
        )
          return { ok: false, reason: 'deleted' };
        if (operation.from !== operation.to)
          rows.splice(operation.to, 0, ...rows.splice(operation.from, 1));
      } else {
        if (!validListIndex(operation.index, rows.length)) return { ok: false, reason: 'deleted' };
        const original = rows[operation.index];
        const originalId = rowId(original);
        if (!originalId || !object(original)) return { ok: false, reason: 'schema' };
        const ids = new Map<string, string>();
        const copy = regenerateIds('default', original, ids);
        const copyId = rowId(copy);
        if (!copyId || copyId === originalId) return { ok: false, reason: 'ambiguous' };
        rows.splice(operation.index + 1, 0, copy);

        for (const locale of locales()) {
          const snapshot = snapshots[locale];
          const target = snapshot && listTarget(snapshot, command.address);
          const localeRow = target?.rows.find((row) => rowId(row) === originalId);
          if (!snapshot || !localeRow || !object(localeRow)) continue;
          const localeCopy = regenerateIds('default', localeRow, ids);
          const localeCopyId = rowId(localeCopy);
          if (!localeCopyId) continue;
          const from = rowAddress(command.address, originalId);
          const machine = scopedMachine(snapshot, from).map((path) => remapMachinePath(path, ids));
          duplicateSeeds[locale] = [
            {
              address: rowAddress(command.address, localeCopyId),
              value: localeCopy,
              ...(machine.length ? { machine } : {}),
            },
          ];
        }
        addInsertedMachinePaths(current, beforeRows, rows, duplicateSeeds[sourceLocale] ?? []);
      }
      const afterRows = clone(listTarget(current, command.address)?.rows ?? []);
      if (equal(beforeRows, afterRows)) return { ok: true, contentVersion: command.contentVersion };
      updateRemovedMachinePaths(current, command.address, beforeRows, afterRows);
      const nextVersion = mutated(locale);
      projectLocales(beforeSource, current, duplicateSeeds);
      const afterSeeds = captureSeeds(command.address);
      undoStack.push({
        type: 'structure',
        address: command.address,
        before: held === undefined ? undefined : beforeRows,
        after: afterRows,
        beforeSeeds,
        afterSeeds,
      });
      redoStack.splice(0);
      queueStructure(command.address, beforeRows, afterRows, afterSeeds);
      return { ok: true, contentVersion: nextVersion };
    },
    canUndo(): boolean {
      return (
        !historyIsFrozen &&
        mutationOpen &&
        !drifted &&
        persistedAction === undefined &&
        undoStack.length > 0
      );
    },
    canRedo(): boolean {
      return (
        !historyIsFrozen &&
        mutationOpen &&
        !drifted &&
        persistedAction === undefined &&
        redoStack.length > 0
      );
    },
    undo(): HistoryResult {
      return replayHistory(undoStack, redoStack, 'undo');
    },
    redo(): HistoryResult {
      return replayHistory(redoStack, undoStack, 'redo');
    },
    /** A cursor move is not history, but it ends any typing transaction in progress. */
    setHistorySelection(selection?: LogicalSelection): void {
      setHistorySelection(selection);
    },
    /** The mounted editor matching this target restores it after session replay/reconciliation. */
    historySelection(): LogicalSelection | undefined {
      return logicalSelection ? clone(logicalSelection) : undefined;
    },
    /** Blur, formatting, paste, and explicit editing transitions call this group boundary. */
    historyBoundary(): void {
      clearActiveHistoryGroup();
    },
    resetHistory(): void {
      resetHistory();
    },
    freezeHistory(): void {
      freezeHistory();
    },
    historyFrozen(): boolean {
      return historyIsFrozen;
    },
    /** Drain every loaded locale, including dirty panes which are no longer mounted. */
    async flush(): Promise<boolean> {
      // Navigation remains available while the reconciliation panel owns the screen.
      if (drifted) return !locales().some(dirty);
      // An admitted persisted action owns the lane until its guarded acknowledgement.
      if (persistedAction) return false;
      return drain();
    },
    unsaved(locale?: string): boolean {
      return locale === undefined
        ? persistedAction !== undefined || locales().some(dirty)
        : dirty(locale);
    },
    accept(locale: string, snapshot: string): void {
      if (snapshot === serialize(locale)) savedVersions[locale] = versionOf(locale);
      coordinator(locale).accept(snapshot);
    },
    hasDrift(): boolean {
      return drifted;
    },
    persistedActionPending(): boolean {
      return persistedAction !== undefined;
    },
    localeMutationBlocked(locale: string): boolean {
      return (
        !mutationOpen ||
        (persistedAction !== undefined &&
          (persistedAction.kind === 'historical-restore' ||
            persistedAction.phase === 'preflush' ||
            locale !== sourceLocale))
      );
    },
    sourceTextOnly(locale: string): boolean {
      return (
        mutationOpen &&
        locale === sourceLocale &&
        persistedAction?.kind === 'machine-translation' &&
        persistedAction.phase === 'running'
      );
    },
    structureMutationBlocked(): boolean {
      return !mutationOpen || persistedAction !== undefined;
    },
    machineTranslationPending(locale: string): boolean {
      return persistedAction?.kind === 'machine-translation' && persistedAction.locale === locale;
    },
    /** Reserve the entry, drain old writes, then translate and acknowledge on the shared lane. */
    async machineTranslate(
      locale: string,
      request: () => Promise<MachineTranslationResponse | undefined>,
    ): Promise<MachineTranslationResult> {
      if (!mutationOpen) return { ok: false, reason: 'closed' };
      if (drifted) return { ok: false, reason: 'drift' };
      if (persistedAction) return { ok: false, reason: 'busy' };
      if (!lane || !snapshots[locale] || locale === sourceLocale)
        return { ok: false, reason: 'closed' };

      const admitted = {
        id: ++nextActionId,
        kind: 'machine-translation' as const,
        locale,
        phase: 'preflush' as const,
        epoch,
      };
      persistedAction = admitted;
      if (!(await drain())) {
        if (persistedAction?.id === admitted.id) persistedAction = undefined;
        return { ok: false, reason: 'save' };
      }

      const expectedRevision = openedRevisions[locale];
      const expectedVersion = versionOf(locale);
      const running = { ...admitted, phase: 'running' as const };
      try {
        return await lane(async (): Promise<MachineTranslationResult> => {
          if (
            !mutationOpen ||
            epoch !== admitted.epoch ||
            openedRevisions[locale] !== expectedRevision ||
            versionOf(locale) !== expectedVersion
          )
            return { ok: false, reason: 'stale' };
          // Only now is the request dispatching; source prose can queue behind this lane work.
          persistedAction = running;
          let response: MachineTranslationResponse | undefined;
          try {
            response = await request();
          } catch {
            return { ok: false, reason: 'request' };
          }
          if (!response) return { ok: false, reason: 'request' };
          if (
            !mutationOpen ||
            epoch !== admitted.epoch ||
            openedRevisions[locale] !== expectedRevision ||
            versionOf(locale) !== expectedVersion
          )
            return { ok: false, reason: 'stale' };

          snapshots[locale] = structuredClone(response.data);
          mutated(locale);
          resetLocaleHistory(locale);
          if (response.revision !== undefined) openedRevisions[locale] = response.revision;
          const accepted = serialize(locale);
          savedVersions[locale] = versionOf(locale);
          coordinator(locale).accept(accepted);
          return { ok: true, response };
        });
      } catch {
        return { ok: false, reason: 'request' };
      } finally {
        if (persistedAction?.id === running.id) persistedAction = undefined;
      }
    },
    /** Drain old writes, restore on the shared lane, then replace every in-memory locale. */
    async historicalRestore(
      request: () => Promise<HistoricalRestoreResponse>,
      reload: (outcome: 'restored' | 'uncertain') => void | Promise<void>,
    ): Promise<HistoricalRestoreResult> {
      if (!mutationOpen) return { ok: false, reason: 'closed' };
      if (persistedAction) return { ok: false, reason: 'busy' };
      if (!lane) return { ok: false, reason: 'closed' };

      const admitted = {
        id: ++nextActionId,
        kind: 'historical-restore' as const,
        phase: 'preflush' as const,
        epoch,
      };
      persistedAction = admitted;
      // Drift itself does not forbid replacing the drafts with a historical version, but there
      // must not be an older local snapshot waiting to overwrite that replacement.
      const flushed = drifted ? !locales().some(dirty) : await drain();
      if (!flushed) {
        if (persistedAction?.id === admitted.id) persistedAction = undefined;
        return { ok: false, reason: 'save' };
      }

      const running = { ...admitted, phase: 'running' as const };
      let keepClosed = false;
      try {
        return await lane(async (): Promise<HistoricalRestoreResult> => {
          if (!mutationOpen || epoch !== admitted.epoch) return { ok: false, reason: 'stale' };
          persistedAction = running;

          let response: HistoricalRestoreResponse;
          try {
            response = await request();
          } catch {
            // The request may have reached the server. Preserve the local snapshots for this
            // component's remaining lifetime, but never let them save over an unknown result.
            keepClosed = true;
            mutationOpen = false;
            freezeHistory();
            epoch += 1;
            persistedAction = { ...running, phase: 'reloading' };
            for (const saves of coordinators.values()) saves.close();
            try {
              await reload('uncertain');
            } catch {
              // The old session remains closed; a later page reload is the only safe recovery.
            }
            return { ok: false, reason: 'uncertain' };
          }

          if (!response.ok) return { ok: false, reason: 'refused', error: response.error };

          // A confirmed restore invalidates this session and any render made from its snapshots.
          // The replacement session is created only after the parent has re-read every locale.
          keepClosed = true;
          mutationOpen = false;
          freezeHistory();
          epoch += 1;
          persistedAction = { ...running, phase: 'reloading' };
          for (const saves of coordinators.values()) saves.close();
          try {
            await reload('restored');
          } catch {
            return { ok: false, reason: 'reload' };
          }
          return { ok: true };
        });
      } catch {
        return { ok: false, reason: keepClosed ? 'reload' : 'stale' };
      } finally {
        if (!keepClosed && persistedAction?.id === admitted.id) persistedAction = undefined;
      }
    },
    /** Keep the gate closed until the parent replaces this session with one fresh entry read. */
    async afterReconciliation(): Promise<void> {
      mutationOpen = false;
      freezeHistory();
      epoch += 1;
      for (const saves of coordinators.values()) saves.close();
      await onreconciled?.();
    },
    closeSaveGate(): void {
      mutationOpen = false;
      freezeHistory();
      epoch += 1;
      for (const saves of coordinators.values()) saves.close();
    },
  };
}
