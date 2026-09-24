import { richtextErrors } from '@handover/core';
import type { EntrySession, LogicalSelection } from '../editor/entry-session.svelte';
import type {
  CanvasBlockAction,
  CanvasCommandMessage,
  CanvasCommandResult,
  CanvasSelection,
  CanvasTarget,
  CanvasTextField,
  CanvasTextSelection,
} from './canvas-bridge';
import type { CanvasInteractionMode } from './runtime/canvas-navigation';

export type CanvasCommandDeps = {
  session: () => EntrySession;
  entryDocument: () => { collection: string; id: string };
  locale: () => string;
  sourceLocale: () => string;
  locked: () => boolean;
  active: () => boolean;
  interactionMode: () => CanvasInteractionMode;
  blocks: () => Record<string, import('@handover/core').Field[]>;
};

export const read = (root: Record<string, unknown>, path: readonly string[]) =>
  path.reduce<unknown>((node, key) => {
    if (Array.isArray(node)) return node[Number(key)];
    return typeof node === 'object' && node !== null
      ? (node as Record<string, unknown>)[key]
      : undefined;
  }, root);

const blockIdPattern = /^(.*)\[_id=([^\]]+)\]$/;

function parseBlockAddress(address: string) {
  const match = blockIdPattern.exec(address);
  if (!match) return;
  return { address: match[1] ?? '', id: match[2] as string };
}

function findBlockRow(rows: unknown[], id: string) {
  const index = rows.findIndex(
    (row) =>
      typeof row === 'object' &&
      row !== null &&
      !Array.isArray(row) &&
      (row as Record<string, unknown>)._id === id,
  );
  if (index < 0) return;
  return { index, row: rows[index] };
}

const rowType = (row: unknown) =>
  typeof row === 'object' && row !== null && !Array.isArray(row)
    ? String((row as Record<string, unknown>)._type ?? '')
    : undefined;

export function createCanvasCommands(deps: CanvasCommandDeps) {
  const { session, entryDocument, locale, sourceLocale, locked, active, interactionMode, blocks } =
    deps;

  const sameDocument = (target: CanvasTarget) =>
    target.document.collection === entryDocument().collection &&
    target.document.id === entryDocument().id;

  function blockLocation(selection: CanvasSelection) {
    if (selection.kind !== 'block') return;
    const target = selection.target.occurrence ?? selection.target;
    if (
      target.document.collection !== entryDocument().collection ||
      target.document.id !== entryDocument().id ||
      target.locale !== locale() ||
      locale() !== sourceLocale() ||
      locked() ||
      session().structureMutationBlocked()
    )
      return;
    const parsed = parseBlockAddress(target.address);
    if (!parsed) return;
    const inspected = session().inspectField(locale(), parsed.address);
    if (!inspected.ok || inspected.target.field.type !== 'blocks') return;
    const value = read(session().snapshot(locale()), inspected.target.path);
    if (!Array.isArray(value)) return;
    const found = findBlockRow(value, parsed.id);
    if (!found) return;
    const currentType = rowType(found.row);
    return {
      address: parsed.address,
      id: parsed.id,
      index: found.index,
      rows: value,
      types: inspected.target.field.types,
      ...(currentType ? { currentType } : {}),
    };
  }

  function blockInspectorFor(selection: CanvasSelection | undefined) {
    if (
      selection?.kind !== 'block' ||
      !sameDocument(selection.target) ||
      selection.target.locale !== locale()
    )
      return;
    const parsed = parseBlockAddress(selection.target.address);
    if (!parsed) return;
    const inspected = session().inspectField(locale(), parsed.address);
    if (!inspected.ok || inspected.target.field.type !== 'blocks') return;
    const rows = read(session().snapshot(locale()), inspected.target.path);
    if (!Array.isArray(rows)) return;
    const found = findBlockRow(rows, parsed.id);
    if (!found) return;
    const type = rowType(found.row) ?? '';
    const fields = blocks()[type];
    if (!type || !fields) return;
    return { fields, path: [...inspected.target.path, String(found.index)], type };
  }

  function blockEditorFor(action: CanvasBlockAction, selection: CanvasSelection) {
    const target = selection.target.occurrence ?? selection.target;
    if (
      target.document.collection !== entryDocument().collection ||
      target.document.id !== entryDocument().id ||
      target.locale !== locale() ||
      locale() !== sourceLocale() ||
      locked() ||
      session().structureMutationBlocked()
    )
      return;
    let address = target.address;
    let currentType: string | undefined;
    if (selection.kind === 'block') {
      const location = blockLocation(selection);
      if (!location) return;
      ({ address, currentType } = location);
      return {
        ...(action === 'replace'
          ? {
              mode: 'replace' as const,
              targetId: location.id,
              // $state.snapshot already returns a plain clone.
              original: $state.snapshot(location.rows[location.index]),
            }
          : {
              mode: 'insert' as const,
              placement: action === 'insert-after' ? ('after' as const) : ('before' as const),
              anchorId: location.id,
            }),
        address,
        types: location.types,
        ...(currentType ? { currentType } : {}),
      };
    }
    if (selection.kind !== 'list' || action !== 'insert-empty') return;
    const inspected = session().inspectField(locale(), address);
    if (!inspected.ok || inspected.target.field.type !== 'blocks') return;
    const value = read(session().snapshot(locale()), inspected.target.path);
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) return;
    return {
      mode: 'insert' as const,
      placement: 'empty' as const,
      address,
      types: inspected.target.field.types,
    };
  }

  const blockActionsFor = (selection: CanvasSelection): CanvasBlockAction[] => {
    if (interactionMode() !== 'edit') return [];
    const history: CanvasBlockAction[] = [
      ...(session().canUndo() ? (['undo'] as const) : []),
      ...(session().canRedo() ? (['redo'] as const) : []),
    ];
    if (selection.kind === 'field') {
      const resolved =
        sameDocument(selection.target) && selection.target.locale === locale()
          ? session().inspectField(locale(), selection.target.address)
          : undefined;
      const canReplaceImage =
        resolved?.ok &&
        resolved.target.field.type === 'image' &&
        locale() === sourceLocale() &&
        !locked() &&
        !session().localeMutationBlocked(locale());
      return ['inspect', ...(canReplaceImage ? (['replace-media'] as const) : []), ...history];
    }
    if (selection.kind === 'list')
      return blockEditorFor('insert-empty', selection) ? ['insert-empty', ...history] : history;
    if (selection.kind !== 'block') return history;
    const location = blockLocation(selection);
    if (!location) return history;
    return [
      'insert-before',
      'insert-after',
      'replace',
      ...(location.rows.length > 1 ? (['move'] as const) : []),
      ...(location.index > 0 ? (['move-up'] as const) : []),
      ...(location.index < location.rows.length - 1 ? (['move-down'] as const) : []),
      'duplicate',
      'delete',
      ...history,
    ];
  };

  function textField(value: CanvasSelection | undefined): CanvasTextField | undefined {
    if (
      !active() ||
      locked() ||
      value?.kind !== 'field' ||
      !sameDocument(value.target) ||
      value.target.locale !== locale() ||
      session().localeMutationBlocked(locale())
    )
      return;
    const resolved = session().inspectField(locale(), value.target.address);
    if (
      !resolved.ok ||
      !['text', 'richtext', 'link'].includes(resolved.target.field.type) ||
      resolved.target.address !== value.target.address ||
      (locale() !== sourceLocale() && resolved.target.mode !== true)
    )
      return;
    const current = read(session().snapshot(locale()), resolved.target.path);
    if (resolved.target.field.type === 'link') {
      if (
        current !== undefined &&
        (typeof current !== 'object' || current === null || Array.isArray(current))
      )
        return;
      const link = (current as Record<string, unknown> | undefined) ?? {};
      const label = link.label;
      if (label !== undefined && typeof label !== 'string') return;
      if (locale() === sourceLocale())
        return {
          kind: 'link' as const,
          target: value.target,
          value: {
            type: link.type === 'url' ? ('url' as const) : ('entry' as const),
            ref: typeof link.ref === 'string' ? link.ref : '',
            href: typeof link.href === 'string' ? link.href : '',
            label: label ?? '',
            newTab: link.newTab === true,
          },
        };
      return { kind: 'text' as const, target: value.target, value: label ?? '' };
    }
    if (current !== undefined && typeof current !== 'string') return;
    const text = current ?? '';
    if (resolved.target.field.type === 'richtext') {
      if (richtextErrors('default', text, resolved.target.field.tier).length) return;
      return {
        kind: 'richtext' as const,
        target: value.target,
        value: text,
        tier: resolved.target.field.tier,
      };
    }
    return { kind: 'text' as const, target: value.target, value: text };
  }

  const historySelection = (target: CanvasTarget, value: CanvasTextSelection | undefined) =>
    value
      ? {
          document: session().documentIdentity(),
          locale: target.locale,
          address: target.address,
          kind: value.kind ?? ('text' as const),
          anchor: value.anchor,
          head: value.head,
        }
      : undefined;

  const updateFor = (target: CanvasTarget, selection?: LogicalSelection) => {
    const resolved = session().resolveField(target.locale, target.address);
    if (!resolved.ok || !['text', 'richtext', 'link'].includes(resolved.target.field.type)) return;
    const value = read(session().snapshot(target.locale), resolved.target.path);
    const text =
      resolved.target.field.type === 'link'
        ? typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>).label
          : undefined
        : value;
    if (text !== undefined && typeof text !== 'string') return;
    const matches =
      selection?.document === session().documentIdentity() &&
      selection.locale === target.locale &&
      selection.address === target.address &&
      (selection.kind === 'text' || selection.kind === 'node');
    return {
      value: text ?? '',
      ...(matches && selection.anchor !== undefined && selection.head !== undefined
        ? { selection: { kind: selection.kind, anchor: selection.anchor, head: selection.head } }
        : {}),
    };
  };

  function canvasCommand(message: CanvasCommandMessage): CanvasCommandResult {
    if (interactionMode() !== 'edit') return { ok: false, reason: 'readonly' };
    const target = message.target;
    const editable = textField({ kind: 'field', target });
    if (!editable) return { ok: false, reason: 'readonly' };
    if (message.command.type === 'history') {
      const result = session()[message.command.direction]();
      if (!result.ok) return result;
      return {
        ok: true,
        contentVersion: session().contentVersion(locale()),
        update: updateFor(target, result.selection),
      };
    }
    const history = message.command.history;
    const resolved = session().inspectField(target.locale, target.address);
    const changes =
      resolved.ok && resolved.target.field.type === 'link' && editable.kind === 'text'
        ? message.command.changes.map((change) => ({
            ...change,
            path: ['label', ...(change.path ?? [])],
          }))
        : message.command.changes;
    return session().fieldCommand(target.locale, {
      address: target.address,
      contentVersion: message.contentVersion,
      changes,
      ...(history
        ? {
            history: {
              kind: history.kind,
              ...(history.group ? { group: history.group } : {}),
              before: historySelection(target, history.before),
              after: historySelection(target, history.after),
            },
          }
        : {}),
    });
  }

  return {
    sameDocument,
    blockLocation,
    blockInspectorFor,
    blockEditorFor,
    blockActionsFor,
    textField,
    updateFor,
    historySelection,
    canvasCommand,
  };
}
