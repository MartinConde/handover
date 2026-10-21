import { type Form, type LocaleSeed, resolveFieldTarget } from '@handover/core';
import { clone, type EntryData, equal } from './entry-paths';
import type { FieldCommandFailure, FieldCommandResult } from './entry-session.svelte';

const TYPING_GROUP_MS = 1000;
// A long typing session must not keep every copy of a large field forever.
const HISTORY_TRANSACTION_LIMIT = 200;
const HISTORY_CHARACTER_LIMIT = 2_000_000;

export type LogicalSelection = {
  // Stable entry identity; prevents a selection leaking into a replacement document.
  document: string;
  locale: string;
  // Stable field address, independent of the row's current position.
  address: string;
  kind?: 'text' | 'node';
  anchor?: number;
  head?: number;
};
export type FieldHistory = {
  // Typing coalesces for one second; a shared composition id coalesces until its boundary.
  kind?: 'change' | 'composition' | 'format' | 'paste' | 'typing';
  group?: string;
  before?: LogicalSelection;
  after?: LogicalSelection;
};

type HistoryFailure = FieldCommandFailure | 'empty' | 'frozen';
type HistoryResult =
  | { ok: true; contentVersion: number; selection?: LogicalSelection }
  | { ok: false; reason: HistoryFailure };

export type HistoryChange = { path: string[]; value: unknown };
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

export type StructuralHistoryTransaction = {
  type: 'structure';
  address: string;
  before: unknown[] | undefined;
  after: unknown[] | undefined;
  beforeSeeds: Record<string, LocaleSeed[]>;
  afterSeeds: Record<string, LocaleSeed[]>;
};

export type HistoryTransaction = FieldHistoryTransaction | StructuralHistoryTransaction;

type HistoryStats = {
  redoTransactions: number;
  retainedCharacters: number;
  retainedFieldValues: number;
  undoTransactions: number;
};

type ActiveHistoryGroup = {
  address: string;
  group?: string;
  kind: 'composition' | 'typing';
  locale: string;
  startedAt: number;
};

const historyCharacters = (transaction: HistoryTransaction): number =>
  transaction.type === 'field'
    ? [...transaction.forward, ...transaction.inverse].reduce(
        (total, change) => total + (typeof change.value === 'string' ? change.value.length : 0),
        0,
      )
    : 0;

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

export function createEntryHistory({
  document,
  sourceLocale,
  form,
  snapshots,
  blocked,
  apply,
}: {
  document: string;
  sourceLocale: string;
  form: Form | undefined;
  snapshots: Record<string, EntryData>;
  // A persisted action owns the entry; replay must wait for it.
  blocked: () => boolean;
  apply: (transaction: HistoryTransaction, direction: 'redo' | 'undo') => FieldCommandResult;
}) {
  const undoStack = $state<HistoryTransaction[]>([]);
  const redoStack = $state<HistoryTransaction[]>([]);
  let undoCharacters = 0;
  let historyIsFrozen = $state(false);
  let activeHistoryGroup: ActiveHistoryGroup | undefined;
  let logicalSelection = $state<LogicalSelection>();
  let replayingHistory = false;

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
    return resolveFieldTarget(form, selection.address, current).ok ? clone(selection) : undefined;
  };
  const clearActiveHistoryGroup = () => {
    activeHistoryGroup = undefined;
  };
  const trimHistory = () => {
    while (
      undoStack.length > 1 &&
      (undoStack.length > HISTORY_TRANSACTION_LIMIT || undoCharacters > HISTORY_CHARACTER_LIMIT)
    ) {
      const dropped = undoStack.shift();
      if (dropped) undoCharacters -= historyCharacters(dropped);
    }
  };

  const replayHistory = (
    from: HistoryTransaction[],
    to: HistoryTransaction[],
    direction: 'redo' | 'undo',
  ): HistoryResult => {
    if (historyIsFrozen) return { ok: false, reason: 'frozen' };
    if (blocked()) return { ok: false, reason: 'closed' };
    const transaction = from.at(-1);
    if (!transaction) return { ok: false, reason: 'empty' };
    clearActiveHistoryGroup();
    replayingHistory = true;
    let result: FieldCommandResult;
    try {
      result = apply(transaction, direction);
    } finally {
      replayingHistory = false;
    }
    if (!result.ok) return result;
    from.pop();
    to.push(transaction);
    if (direction === 'undo') undoCharacters -= historyCharacters(transaction);
    else undoCharacters += historyCharacters(transaction);
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
    get frozen() {
      return historyIsFrozen;
    },
    get undoable() {
      return undoStack.length > 0;
    },
    get redoable() {
      return redoStack.length > 0;
    },
    boundary: clearActiveHistoryGroup,
    freeze() {
      historyIsFrozen = true;
      clearActiveHistoryGroup();
    },
    resetLocale(locale: string) {
      const belongsToLocale = (item: HistoryTransaction) =>
        item.type === 'structure'
          ? Object.hasOwn(item.beforeSeeds, locale)
          : item.locale === locale;
      undoStack.splice(0, undoStack.length, ...undoStack.filter((item) => !belongsToLocale(item)));
      redoStack.splice(0, redoStack.length, ...redoStack.filter((item) => !belongsToLocale(item)));
      undoCharacters = undoStack.reduce((total, item) => total + historyCharacters(item), 0);
      if (activeHistoryGroup?.locale === locale) clearActiveHistoryGroup();
      if (logicalSelection?.locale === locale) logicalSelection = undefined;
    },
    select(selection?: LogicalSelection) {
      const next = selection ? validSelection(selection.locale, selection) : undefined;
      if (!sameSelection(logicalSelection, next)) clearActiveHistoryGroup();
      logicalSelection = next;
    },
    selection(): LogicalSelection | undefined {
      return logicalSelection ? clone(logicalSelection) : undefined;
    },
    recordField(
      locale: string,
      address: string,
      forward: HistoryChange[],
      inverse: HistoryChange[],
      history: FieldHistory | undefined,
    ) {
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
        now - activeHistoryGroup.startedAt <= TYPING_GROUP_MS &&
        current?.type === 'field' &&
        sameSelection(current.after, before);
      const groupedComposition =
        kind === 'composition' &&
        history?.group !== undefined &&
        activeHistoryGroup?.kind === 'composition' &&
        sameTarget &&
        activeHistoryGroup.group === history.group;

      if (current?.type === 'field' && (groupedTyping || groupedComposition)) {
        const compactTyping =
          groupedTyping &&
          current.forward.length === 1 &&
          current.inverse.length === 1 &&
          forward.length === 1 &&
          inverse.length === 1 &&
          equal(current.forward[0]?.path, forward[0]?.path) &&
          equal(current.inverse[0]?.path, inverse[0]?.path) &&
          equal(forward[0]?.path, inverse[0]?.path);
        const beforeChars = historyCharacters(current);
        if (compactTyping) {
          // The first inverse and latest forward are the only values needed to replay a
          // same-property typing group. Intermediate Markdown/text values can be large.
          current.forward[0] = forward[0] as HistoryChange;
        } else {
          current.forward.push(...forward);
          current.inverse.unshift(...inverse);
        }
        current.after = after;
        undoCharacters += historyCharacters(current) - beforeChars;
      } else {
        const transaction: HistoryTransaction = {
          type: 'field',
          address,
          after,
          before,
          forward,
          inverse,
          kind,
          locale,
        };
        undoStack.push(transaction);
        undoCharacters += historyCharacters(transaction);
      }
      redoStack.splice(0);
      trimHistory();
      logicalSelection = after;
      activeHistoryGroup =
        kind === 'typing' || (kind === 'composition' && history?.group !== undefined)
          ? {
              address,
              group: history?.group,
              kind,
              locale,
              startedAt:
                groupedTyping || groupedComposition ? (activeHistoryGroup?.startedAt ?? now) : now,
            }
          : undefined;
    },
    recordStructure(transaction: StructuralHistoryTransaction) {
      undoStack.push(transaction);
      redoStack.splice(0);
      trimHistory();
    },
    undo(): HistoryResult {
      return replayHistory(undoStack, redoStack, 'undo');
    },
    redo(): HistoryResult {
      return replayHistory(redoStack, undoStack, 'redo');
    },
    stats(): HistoryStats {
      const retainedFieldValues = [...undoStack, ...redoStack].reduce(
        (total, transaction) =>
          transaction.type === 'field'
            ? total + transaction.forward.length + transaction.inverse.length
            : total,
        0,
      );
      const retainedCharacters = [...undoStack, ...redoStack].reduce(
        (total, transaction) => total + historyCharacters(transaction),
        0,
      );
      return {
        redoTransactions: redoStack.length,
        retainedCharacters,
        retainedFieldValues,
        undoTransactions: undoStack.length,
      };
    },
  };
}
