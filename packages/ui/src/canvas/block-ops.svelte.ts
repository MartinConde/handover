import type { EntrySession } from '../editor/entry-session.svelte';
import { read, resolveStagedBlockIndex, type StagedBlockTarget } from './canvas-commands.svelte';
import type { CanvasActionMessage, CanvasSelection } from './canvas-protocol';

type BlockLocation = { address: string; index: number };

export type BlockOutcome =
  | { kind: 'redraw' }
  | { kind: 'render' }
  | { kind: 'select'; selected: CanvasSelection | undefined };

// Block list edits from Canvas: insert, replace, duplicate, delete, move, undo and redo.
export function createBlockOps({
  session,
  locale,
  entryDocument,
  blockLocation,
}: {
  session: () => EntrySession;
  locale: () => string;
  entryDocument: () => { collection: string; id: string };
  blockLocation: (selection: CanvasSelection) => BlockLocation | undefined;
}) {
  let actionRefusal = $state('');
  let deletedSelection: CanvasSelection | undefined;

  function applyBlock(
    editing: StagedBlockTarget & { address: string },
    value: Record<string, unknown>,
  ) {
    const inspected = session().inspectField(locale(), editing.address);
    if (!inspected.ok) return { result: inspected };
    if (inspected.target.field.type !== 'blocks')
      return { result: { ok: false as const, reason: 'schema' as const } };
    const held = read(session().snapshot(locale()), inspected.target.path);
    if (held !== undefined && !Array.isArray(held))
      return { result: { ok: false as const, reason: 'schema' as const } };
    const target = resolveStagedBlockIndex(editing, held ?? []);
    if (!target.ok) return { result: target };
    const result = session().listCommand(locale(), {
      address: editing.address,
      contentVersion: session().contentVersion(locale()),
      operation:
        editing.mode === 'replace'
          ? { type: 'replace', index: target.index, value }
          : { type: 'insert', index: target.index, value },
    });
    if (!result.ok) return { result };
    const id = typeof value._id === 'string' ? value._id : '';
    const selected: CanvasSelection | undefined = id
      ? {
          kind: 'block',
          target: {
            document: entryDocument(),
            locale: locale(),
            address: `${editing.address}[_id=${id}]`,
          },
        }
      : undefined;
    return { result, selected };
  }

  function listAction(
    message: Pick<CanvasActionMessage, 'action' | 'destination' | 'selection'>,
  ): BlockOutcome | undefined {
    const location = blockLocation(message.selection);
    if (!location) return;
    const destination =
      message.action === 'move' && message.destination
        ? blockLocation(message.destination)
        : undefined;
    if (message.action === 'move' && (!destination || destination.address !== location.address)) {
      actionRefusal = 'schema';
      // The page already shows the dragged order; redraw it from the session.
      return { kind: 'redraw' };
    }
    const operation =
      message.action === 'duplicate'
        ? ({ type: 'duplicate', index: location.index } as const)
        : message.action === 'delete'
          ? ({ type: 'remove', index: location.index } as const)
          : message.action === 'move-up'
            ? ({ type: 'move', from: location.index, to: location.index - 1 } as const)
            : message.action === 'move-down'
              ? ({ type: 'move', from: location.index, to: location.index + 1 } as const)
              : ({ type: 'move', from: location.index, to: destination?.index ?? -1 } as const);
    const result = session().listCommand(locale(), {
      address: location.address,
      contentVersion: session().contentVersion(locale()),
      operation,
    });
    if (!result.ok) {
      actionRefusal = result.reason;
      if (message.action === 'move') return { kind: 'redraw' };
      return;
    }
    actionRefusal = '';
    if (message.action === 'delete') {
      deletedSelection = message.selection;
      return { kind: 'select', selected: undefined };
    }
    if (message.action === 'duplicate') {
      const inspected = session().inspectField(locale(), location.address);
      const rows = inspected.ok
        ? read(session().snapshot(locale()), inspected.target.path)
        : undefined;
      const copy = Array.isArray(rows) ? rows[location.index + 1] : undefined;
      const id =
        typeof copy === 'object' && copy !== null && !Array.isArray(copy)
          ? (copy as Record<string, unknown>)._id
          : undefined;
      if (typeof id !== 'string') return { kind: 'render' };
      const occurrence = message.selection.target.occurrence;
      return {
        kind: 'select',
        selected: {
          kind: 'block',
          target: occurrence
            ? {
                ...message.selection.target,
                occurrence: { ...occurrence, address: `${location.address}[_id=${id}]` },
              }
            : {
                ...message.selection.target,
                address: `${location.address}[_id=${id}]`,
              },
        },
      };
    }
    return { kind: 'select', selected: message.selection };
  }

  function replay(direction: 'redo' | 'undo'): BlockOutcome | undefined {
    const missingDeletedTarget =
      direction === 'undo' && deletedSelection && blockLocation(deletedSelection) === undefined;
    const result = session()[direction]();
    if (!result.ok) {
      actionRefusal = result.reason;
      return;
    }
    actionRefusal = '';
    if (missingDeletedTarget && deletedSelection && blockLocation(deletedSelection)) {
      const restored = deletedSelection;
      deletedSelection = undefined;
      return { kind: 'select', selected: restored };
    }
    return { kind: 'render' };
  }

  return {
    get actionRefusal() {
      return actionRefusal;
    },
    set actionRefusal(next) {
      actionRefusal = next;
    },
    applyBlock,
    listAction,
    replay,
  };
}
