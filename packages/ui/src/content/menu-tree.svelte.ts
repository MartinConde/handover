import type { DragDropEventHandlers } from '@dnd-kit/svelte';
import type { MenuItem } from './Menus.svelte';

// The format is recursive; the cap is this editor's.
const MAX_DEPTH = 3;

// How many levels the item itself is, so indenting cannot push its children past the cap.
function heightOf(item: MenuItem): number {
  return 1 + Math.max(0, ...(item.children ?? []).map(heightOf));
}

type Handlers = Required<DragDropEventHandlers>;
type Manager = Parameters<Handlers['onDragOver']>[1];
// How far sideways a drag must travel to mean one level deeper: the branch indent.
const INDENT = 36;
interface Slot {
  kind: 'line' | 'into' | 'blocked';
  // Where the indicator is drawn: the list it sits in and the row it follows.
  list: MenuItem[];
  after?: MenuItem;
  deeper: boolean;
  // What a drop would do: into this parent (the root when absent), after this sibling.
  parent?: MenuItem;
  sib?: MenuItem;
}

interface Row {
  item: MenuItem;
  depth: number;
  parent?: Row;
}

export function createMenuTree(items: () => MenuItem[]) {
  // The list an item at this path is a row of.
  const listAt = (path: number[]): MenuItem[] =>
    path.reduce<MenuItem[]>((list, i) => list[i]?.children ?? [], items());
  function move(list: MenuItem[], from: number, to: number) {
    list.splice(to, 0, ...list.splice(from, 1));
  }
  function step(path: number[], by: -1 | 1) {
    const list = listAt(path.slice(0, -1));
    const i = path[path.length - 1] as number;
    if (i + by >= 0 && i + by < list.length) move(list, i, i + by);
  }
  // Refused where the row's own children would land past the cap, rather than flattening them.
  const canIndent = (item: MenuItem, path: number[]) =>
    (path[path.length - 1] as number) > 0 && path.length + heightOf(item) <= MAX_DEPTH;
  function indent(item: MenuItem, path: number[]) {
    if (!canIndent(item, path)) return;
    const list = listAt(path.slice(0, -1));
    const i = path[path.length - 1] as number;
    const parent = list[i - 1] as MenuItem;
    // Not `??=`: it hands on the bare array, and a push into that reaches no proxy.
    if (!parent.children) parent.children = [];
    parent.children.push(...list.splice(i, 1));
  }
  function outdent(path: number[]) {
    if (path.length < 2) return;
    const list = listAt(path.slice(0, -1));
    const up = listAt(path.slice(0, -2));
    const at = path[path.length - 2] as number;
    up.splice(at + 1, 0, ...list.splice(path[path.length - 1] as number, 1));
    prune(path.slice(0, -1));
  }
  // An empty `children` is a key in the file that says nothing and shows up in every diff.
  function prune(path: number[]) {
    if (!path.length) return;
    const parent = listAt(path.slice(0, -1))[path[path.length - 1] as number];
    if (parent?.children && !parent.children.length) delete parent.children;
  }
  // Where the item waiting to be confirmed away sits now — it can be moved from under a dialog.
  const pathOf = (item: MenuItem, list = items(), at: number[] = []): number[] => {
    for (const [i, row] of list.entries()) {
      if (row === item) return [...at, i];
      const found = row.children?.length ? pathOf(item, row.children, [...at, i]) : [];
      if (found.length) return found;
    }
    return [];
  };

  function find(list: MenuItem[], key: string): MenuItem | undefined {
    for (const item of list) {
      if (item._id === key) return item;
      const inner = item.children ? find(item.children, key) : undefined;
      if (inner) return inner;
    }
    return undefined;
  }

  function rowsOf(list: MenuItem[], skip?: MenuItem, depth = 1, parent?: Row): Row[] {
    const rows: Row[] = [];
    for (const item of list) {
      if (item === skip) continue;
      const row: Row = { item, depth, parent };
      rows.push(row, ...rowsOf(item.children ?? [], skip, depth + 1, row));
    }
    return rows;
  }

  return { listAt, step, canIndent, indent, outdent, prune, pathOf, find, rowsOf };
}

export type MenuTree = ReturnType<typeof createMenuTree>;

export function createMenuDrag(tree: MenuTree, root: () => MenuItem[]) {
  const { listAt, prune, pathOf, find, rowsOf } = tree;
  let mark = $state<Slot>();
  // Levels asked for with → and ← during a keyboard drag, on top of the pointer's travel.
  let shift = 0;

  // Nothing moves during a drag: the slot is drawn under the pointer and the drop is the one move.
  function place(manager: Manager, to?: { x: number; y: number }) {
    mark = undefined;
    const op = manager.dragOperation;
    const items = root();
    const src = op.source ? find(items, String(op.source.id)) : undefined;
    const at = op.target?.element ? find(items, String(op.target.id)) : undefined;
    if (!src || !at || at === src) return;
    const all = rowsOf(items);
    const srcRow = all.find((row) => row.item === src);
    const atRow = all.find((row) => row.item === at);
    if (!srcRow || !atRow) return;
    for (let up = atRow.parent; up; up = up.parent) if (up.item === src) return;
    const rect = op.target?.element?.getBoundingClientRect();
    if (!rect) return;
    // A dragmove is announced before its coordinates land, so the event's own point wins.
    const point = to ?? op.position.current;
    const after =
      op.activatorEvent instanceof KeyboardEvent
        ? all.indexOf(atRow) > all.indexOf(srcRow)
        : point.y >= rect.top + rect.height / 2;
    const flat = rowsOf(items, src);
    const gap = flat.findIndex((row) => row.item === at) + (after ? 1 : 0);
    const above = flat[gap - 1];
    const below = flat[gap];
    const most = above ? above.depth + 1 : 1;
    const least = below ? below.depth : 1;
    const dx = point.x - (op.position.current.x - op.position.delta.x);
    const wanted = srcRow.depth + Math.round(dx / INDENT) + shift;
    const depth = Math.min(Math.max(wanted, least), most);
    let sibRow: Row | undefined;
    let parentRow: Row | undefined;
    if (above && depth > above.depth) {
      parentRow = above;
    } else if (above) {
      sibRow = above;
      while (sibRow && sibRow.depth > depth) sibRow = sibRow.parent;
      parentRow = sibRow?.parent;
    }
    // Its own place is not a move.
    const path = pathOf(src);
    const own = listAt(path.slice(0, -1));
    const prev = own[(path[path.length - 1] as number) - 1];
    if (parentRow?.item === srcRow.parent?.item && sibRow?.item === prev) return;
    const kind =
      depth + heightOf(src) - 1 > MAX_DEPTH ? 'blocked' : depth === least ? 'line' : 'into';
    let list = items;
    let anchor: MenuItem | undefined;
    let deeper = false;
    if (above && parentRow === above) {
      const kids = (above.item.children ?? []).filter((child) => child !== src);
      if (kids.length && above.item.children) {
        list = above.item.children;
      } else {
        list = above.parent?.item.children ?? items;
        anchor = above.item;
        deeper = true;
      }
    } else if (sibRow) {
      list = sibRow.parent?.item.children ?? items;
      anchor = sibRow.item;
    }
    mark = { kind, list, after: anchor, deeper, parent: parentRow?.item, sib: sibRow?.item };
  }

  function begun() {
    shift = 0;
    mark = undefined;
  }
  function moved(event: Parameters<Handlers['onDragMove']>[0], manager: Manager) {
    if (event.by?.x && event.nativeEvent instanceof KeyboardEvent) {
      // → and ← on a keyboard drag ask for a level, not a sideways pixel move.
      event.preventDefault();
      shift += Math.sign(event.by.x);
      place(manager);
      return;
    }
    const { current } = manager.dragOperation.position;
    const to =
      event.to ?? (event.by ? { x: current.x + event.by.x, y: current.y + event.by.y } : undefined);
    place(manager, to);
  }
  // A canceled drag has nothing to put back, since the tree never moved.
  function ended(event: Parameters<Handlers['onDragEnd']>[0]) {
    const slot = mark;
    mark = undefined;
    shift = 0;
    const { source } = event.operation;
    if (event.canceled || !slot || slot.kind === 'blocked' || !source) return;
    const item = find(root(), String(source.id));
    if (!item) return;
    const path = pathOf(item);
    listAt(path.slice(0, -1)).splice(path[path.length - 1] as number, 1);
    prune(path.slice(0, -1));
    let into = root();
    if (slot.parent) {
      if (!slot.parent.children) slot.parent.children = [];
      into = slot.parent.children;
    }
    into.splice(slot.sib ? into.indexOf(slot.sib) + 1 : 0, 0, item);
  }

  return {
    get mark() {
      return mark;
    },
    place,
    begun,
    moved,
    ended,
  };
}
