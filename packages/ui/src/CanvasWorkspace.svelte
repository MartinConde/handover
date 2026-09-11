<script lang="ts">
import { richtextErrors } from '@handover/core';
import { onMount, type Snippet, tick, untrack } from 'svelte';
import { cubicOut } from 'svelte/easing';
import { fly } from 'svelte/transition';
import CanvasBlockEditor from './CanvasBlockEditor.svelte';
import CanvasIcon from './CanvasIcon.svelte';
import CanvasInspector from './CanvasInspector.svelte';
import type {
  CanvasActionMessage,
  CanvasBlockAction,
  CanvasCommandMessage,
  CanvasCommandResult,
  CanvasEditingState,
  CanvasNavigationMessage,
  CanvasSelection,
  CanvasStructureNode,
  CanvasTarget,
  CanvasTextField,
  CanvasTextSelection,
} from './canvas-bridge';
import {
  type CanvasInteractionMode,
  type CanvasNavigationDestination,
  type CanvasNavigationIndex,
  classifyCanvasNavigation,
} from './canvas-navigation';
import type {
  CanvasRendererState,
  CanvasRenderRequest,
  createCanvasRenderer,
} from './canvas-renderer';
import { canvasNodeKey, visibleCanvasNodes } from './canvas-structure';
import { request as fetch, previewPath } from './request';

type Renderer = ReturnType<typeof createCanvasRenderer>;
type Width = 'desktop' | 'tablet' | 'phone';

let {
  active,
  fullscreen = false,
  entryActions,
  publishAction,
  locale,
  url,
  request,
  currentVersion,
  entryDocument,
  ownerLabel,
  sourceLocale,
  session,
  blocks,
  problems = {},
  mediaBase = '',
  site,
  servedAt,
  locked = false,
  onform,
  onformtarget,
  onreviewproblems,
  onnavigateentry,
  mobileHidden = false,
}: {
  active: boolean;
  fullscreen?: boolean;
  entryActions?: Snippet;
  publishAction?: Snippet;
  locale: string;
  url: string;
  request: () => CanvasRenderRequest;
  currentVersion: () => number;
  entryDocument: CanvasRenderRequest['snapshot']['entry'];
  ownerLabel: string;
  sourceLocale: string;
  session: import('./entry-session.svelte').EntrySession;
  blocks: Record<string, import('@handover/core').Field[]>;
  problems?: Record<string, string>;
  mediaBase?: string;
  site?: string;
  servedAt?: string;
  locked?: boolean;
  onform: () => void;
  onreviewproblems: () => void;
  onformtarget: (target: NonNullable<CanvasSelection>['target']) => void;
  onnavigateentry: (target: {
    collection: string;
    id: string;
    locale: string;
    href: string;
  }) => void;
  mobileHidden?: boolean;
} = $props();

let workspace = $state<HTMLElement>();
let stage = $state<HTMLElement>();
let narrow = $state(false);
let renderer: Renderer | undefined;
let rendererState = $state<CanvasRendererState>({ phase: 'idle' });
let width = $state<Width>('desktop');
let sizing = $state('fit');
let structureOpen = $state(false);
let initializedPanels = false;
$effect(() => {
  if (active && fullscreen && !initializedPanels) {
    initializedPanels = true;
    structureOpen = window.innerWidth >= 1000;
  }
});
let inspectorOpen = $state(false);
const issues = $derived(Object.entries(problems));
let structure = $state<CanvasStructureNode[]>([]);
let selected = $state<CanvasSelection>();
let loading = $state(true);
let lastLocale = '';
let lastVersion = -1;
let wasActive = false;
let disposed = false;
let inlineEditing = false;
let interactionMode = $state<CanvasInteractionMode>('edit');
let actionRefusal = $state('');
let navigationError = $state('');
let navigationBusy = false;
let navigationAction = $state<{
  destination: CanvasNavigationDestination;
  download: boolean;
}>();
let deletedSelection: CanvasSelection | undefined;
type BlockEditorState = {
  mode: 'insert' | 'replace';
  address: string;
  index: number;
  types: readonly string[];
  currentType?: string;
};
let blockEditor = $state<BlockEditorState>();
const structureVisible = $derived(structureOpen && !(narrow && inspectorOpen));

const WIDTHS: { value: Width; label: string }[] = [
  { value: 'desktop', label: 'Desktop' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'phone', label: 'Phone' },
];

const status = $derived(
  loading
    ? 'Preparing Canvas…'
    : rendererState.phase === 'rendering'
      ? 'Updating Canvas…'
      : rendererState.phase === 'ready'
        ? 'Canvas updated'
        : rendererState.phase === 'failed'
          ? 'Canvas update failed'
          : 'Canvas ready',
);
const failure = $derived(rendererState.phase === 'failed' ? rendererState : undefined);
const sameSelection = (node: CanvasSelection, value: CanvasSelection | undefined) =>
  !!value &&
  node.kind === value.kind &&
  JSON.stringify(node.target) === JSON.stringify(value.target);
const selectedNode = $derived(structure.find((node) => sameSelection(node, selected)));
let collapsed = $state<Record<string, boolean>>({});
const parentOf = (node: CanvasStructureNode) =>
  node.parentId ? structure.find((candidate) => candidate.id === node.parentId) : undefined;
const branches = $derived(new Set(structure.map((node) => node.parentId).filter(Boolean)));
// Hide only generic, nonempty wrapper lists; retain empty lists as insertion targets.
const hiddenWrappers = $derived(
  new Set(
    structure
      .filter(
        (node) =>
          node.kind === 'list' &&
          node.parentId &&
          !node.empty &&
          /^(Blocks|Columns)$/i.test(node.label),
      )
      .map((node) => node.id),
  ),
);
const visibleStructure = $derived(
  visibleCanvasNodes(structure, collapsed).filter((node) => !hiddenWrappers.has(node.id)),
);
function treeDepth(node: CanvasStructureNode) {
  let depth = node.depth;
  for (let parent = parentOf(node); parent; parent = parentOf(parent))
    if (hiddenWrappers.has(parent.id)) depth -= 1;
  return depth;
}
function treeLabel(node: CanvasStructureNode) {
  if (!node.parentId && node.kind === 'list' && node.label === 'Blocks') return 'Page';
  if (parentOf(node)?.label === 'Columns' && /^Block \d+$/.test(node.label))
    return node.label.replace('Block', 'Column');
  return node.label;
}
function nodeIcon(node: CanvasStructureNode) {
  if (node.target.occurrence) return 'external';
  if (node.kind !== 'field') return node.kind === 'list' ? 'structure' : 'block';
  const field = session.inspectField(locale, node.target.address);
  return field.ok && ['image', 'file'].includes(field.target.field.type) ? 'image' : 'text';
}

function toggleBranch(node: CanvasStructureNode) {
  const key = canvasNodeKey(node);
  collapsed = { ...collapsed, [key]: !collapsed[key] };
}

// A target picked in the page must not land inside a branch the editor left collapsed. Only a
// change of selection opens the chain, so collapsing the branch you are working in still holds.
let openedFor = '';
$effect(() => {
  const node = selectedNode;
  if (!node) return;
  const key = canvasNodeKey(node);
  if (key === openedFor) return;
  openedFor = key;
  untrack(() => {
    const opened = { ...collapsed };
    let changed = false;
    for (let parent = parentOf(node); parent; parent = parentOf(parent)) {
      if (!opened[canvasNodeKey(parent)]) continue;
      opened[canvasNodeKey(parent)] = false;
      changed = true;
    }
    if (changed) collapsed = opened;
  });
});
const actionNode = $derived.by(() => {
  let node = selectedNode;
  while (node && node.kind !== 'block') node = parentOf(node);
  return node;
});
const insertionNode = $derived.by(() => {
  if (selectedNode?.kind === 'list' && blockActionsFor(selectedNode).includes('insert-empty'))
    return selectedNode;
  if (actionNode && blockActionsFor(actionNode).includes('insert-after')) return actionNode;
  const root = structure.find((node) => !node.parentId && node.kind === 'list');
  if (root && blockActionsFor(root).includes('insert-empty')) return root;
  return structure
    .filter(
      (node) =>
        node.kind === 'block' &&
        (!root || node.parentId === root.id) &&
        blockActionsFor(node).includes('insert-after'),
    )
    .at(-1);
});
const breadcrumb = $derived.by(() => {
  if (!selectedNode) return '';
  const result: string[] = [];
  let node: CanvasStructureNode | undefined = selectedNode;
  while (node) {
    if (!hiddenWrappers.has(node.id) && treeLabel(node) !== 'Page') result.unshift(treeLabel(node));
    node = node.parentId
      ? structure.find((candidate) => candidate.id === node?.parentId)
      : undefined;
  }
  return ['Page', ...result].join(' / ');
});

async function submit(kind: 'render' | 'schedule', force = false) {
  if (!active || !renderer) return;
  const next = untrack(request);
  const version = next.snapshot.contentVersion;
  if (!force && next.snapshot.locale === lastLocale && version === lastVersion) return;
  lastLocale = next.snapshot.locale;
  lastVersion = version;
  await tick();
  if (!active || disposed) return;
  try {
    await renderer[kind](next);
  } catch (error) {
    rendererState = {
      phase: 'failed',
      requestId: crypto.randomUUID(),
      contentVersion: version,
      reason: 'bootstrap',
      message: error instanceof Error ? error.message : 'Canvas could not start.',
    };
  }
}

export function schedule() {
  return submit('schedule');
}

function retry() {
  if (!renderer) return;
  void renderer.retry();
}

function selectNode(node: CanvasStructureNode) {
  const next = { kind: node.kind, target: node.target };
  selectionChanged(next);
  renderer?.select(next);
}

function toggleStructure() {
  if (narrow && (inspectorOpen || blockEditor)) {
    inspectorOpen = false;
    blockEditor = undefined;
    structureOpen = true;
  } else structureOpen = !structureOpen;
}

function toggleInspector() {
  if (!selected) return;
  inspectorOpen = !inspectorOpen;
}

function selectionChanged(next: CanvasSelection | undefined, reason?: 'restore') {
  if (interactionMode !== 'edit') return;
  selected = next;
  void tick().then(() => {
    renderer?.textField(textField(next));
    if (next) renderer?.actions(next, blockActionsFor(next));
  });
  if (!next) {
    inspectorOpen = false;
    return;
  }
  // A background render restores selection without overriding panels the editor closed.
  if (reason === 'restore') return;
  const owner = next.target.document;
  const foreign = owner.collection !== entryDocument.collection || owner.id !== entryDocument.id;
  const resolved =
    !foreign && next.kind === 'field'
      ? session.inspectField(next.target.locale, next.target.address)
      : undefined;
  const current = resolved?.ok
    ? read(session.snapshot(next.target.locale), resolved.target.path)
    : undefined;
  const unsupportedRichtext =
    resolved?.ok &&
    resolved.target.field.type === 'richtext' &&
    typeof current === 'string' &&
    richtextErrors('default', current, resolved.target.field.tier).length > 0;
  if (
    (!narrow && fullscreen) ||
    foreign ||
    unsupportedRichtext ||
    (resolved?.ok && !['text', 'richtext'].includes(resolved.target.field.type))
  ) {
    inspectorOpen = true;
  }
}

function blockLocation(selection: CanvasSelection) {
  if (selection.kind !== 'block') return;
  const target = selection.target.occurrence ?? selection.target;
  if (
    target.document.collection !== entryDocument.collection ||
    target.document.id !== entryDocument.id ||
    target.locale !== locale ||
    locale !== sourceLocale ||
    locked ||
    session.structureMutationBlocked()
  )
    return;
  const match = /^(.*)\[_id=([^\]]+)\]$/.exec(target.address);
  if (!match) return;
  const address = match[1] ?? '';
  const inspected = session.inspectField(locale, address);
  if (!inspected.ok || inspected.target.field.type !== 'blocks') return;
  const value = read(session.snapshot(locale), inspected.target.path);
  if (!Array.isArray(value)) return;
  const index = value.findIndex(
    (row) =>
      typeof row === 'object' &&
      row !== null &&
      !Array.isArray(row) &&
      (row as Record<string, unknown>)._id === match[2],
  );
  if (index < 0) return;
  const row = value[index];
  const currentType =
    typeof row === 'object' && row !== null && !Array.isArray(row)
      ? String((row as Record<string, unknown>)._type ?? '')
      : undefined;
  return {
    address,
    index,
    rows: value,
    types: inspected.target.field.types,
    ...(currentType ? { currentType } : {}),
  };
}

const blockActionsFor = (selection: CanvasSelection): CanvasBlockAction[] => {
  if (interactionMode !== 'edit') return [];
  const history: CanvasBlockAction[] = [
    ...(session.canUndo() ? (['undo'] as const) : []),
    ...(session.canRedo() ? (['redo'] as const) : []),
  ];
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

function blockEditorFor(action: CanvasBlockAction, selection: CanvasSelection) {
  const target = selection.target.occurrence ?? selection.target;
  if (
    target.document.collection !== entryDocument.collection ||
    target.document.id !== entryDocument.id ||
    target.locale !== locale ||
    locale !== sourceLocale ||
    locked ||
    session.structureMutationBlocked()
  )
    return;
  let address = target.address;
  let index = 0;
  let currentType: string | undefined;
  if (selection.kind === 'block') {
    const location = blockLocation(selection);
    if (!location) return;
    ({ address, index, currentType } = location);
    if (action === 'insert-after') index += 1;
    return {
      mode: action === 'replace' ? ('replace' as const) : ('insert' as const),
      address,
      index,
      types: location.types,
      ...(currentType ? { currentType } : {}),
    };
  }
  if (selection.kind !== 'list' || action !== 'insert-empty') return;
  const inspected = session.inspectField(locale, address);
  if (!inspected.ok || inspected.target.field.type !== 'blocks') return;
  const value = read(session.snapshot(locale), inspected.target.path);
  if (value !== undefined && (!Array.isArray(value) || value.length > 0)) return;
  return { mode: 'insert' as const, address, index: 0, types: inspected.target.field.types };
}

function openBlockEditor(
  action: CanvasBlockAction,
  selection: CanvasSelection | undefined = selected,
) {
  if (!selection) return;
  const next = blockEditorFor(action, selection);
  if (!next) return;
  selected = selection;
  blockEditor = next;
  inspectorOpen = false;
  structureOpen = true;
}

let addBlockButton = $state<HTMLButtonElement>();
function closeBlockEditor() {
  blockEditor = undefined;
  const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280;
  window.setTimeout(() => addBlockButton?.focus(), delay);
}

function applyBlock(value: Record<string, unknown>) {
  const editing = blockEditor;
  if (!editing) return { ok: false as const, reason: 'stale' as const };
  const result = session.listCommand(locale, {
    address: editing.address,
    contentVersion: session.contentVersion(locale),
    operation:
      editing.mode === 'replace'
        ? { type: 'replace', index: editing.index, value }
        : { type: 'insert', index: editing.index, value },
  });
  if (!result.ok) return result;
  session.change(locale);
  const id = typeof value._id === 'string' ? value._id : '';
  if (id) {
    selected = {
      kind: 'block',
      target: {
        document: entryDocument,
        locale,
        address: `${editing.address}[_id=${id}]`,
      },
    };
  }
  void submit('schedule');
  return result;
}

function canvasAction(message: Pick<CanvasActionMessage, 'action' | 'destination' | 'selection'>) {
  if (interactionMode !== 'edit') return;
  if (message.action === 'undo' || message.action === 'redo') {
    replay(message.action);
    return;
  }
  if (
    message.action === 'insert-before' ||
    message.action === 'insert-after' ||
    message.action === 'insert-empty' ||
    message.action === 'replace'
  ) {
    openBlockEditor(message.action, message.selection);
    return;
  }
  const location = blockLocation(message.selection);
  if (!location) return;
  const destination =
    message.action === 'move' && message.destination
      ? blockLocation(message.destination)
      : undefined;
  if (message.action === 'move' && (!destination || destination.address !== location.address)) {
    actionRefusal = 'schema';
    return;
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
  const result = session.listCommand(locale, {
    address: location.address,
    contentVersion: session.contentVersion(locale),
    operation,
  });
  if (!result.ok) {
    actionRefusal = result.reason;
    return;
  }
  actionRefusal = '';
  session.change(locale);
  if (message.action === 'delete') {
    deletedSelection = message.selection;
    selected = undefined;
  } else if (message.action === 'duplicate') {
    const inspected = session.inspectField(locale, location.address);
    const rows = inspected.ok ? read(session.snapshot(locale), inspected.target.path) : undefined;
    const copy = Array.isArray(rows) ? rows[location.index + 1] : undefined;
    const id =
      typeof copy === 'object' && copy !== null && !Array.isArray(copy)
        ? (copy as Record<string, unknown>)._id
        : undefined;
    if (typeof id === 'string') {
      const occurrence = message.selection.target.occurrence;
      selected = {
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
      };
    }
  } else {
    selected = message.selection;
  }
  void submit('schedule');
}

function replay(direction: 'redo' | 'undo') {
  const missingDeletedTarget =
    direction === 'undo' && deletedSelection && blockLocation(deletedSelection) === undefined;
  const result = session[direction]();
  if (!result.ok) {
    actionRefusal = result.reason;
    return;
  }
  actionRefusal = '';
  for (const changedLocale of Object.keys(session.snapshots)) session.change(changedLocale);
  if (missingDeletedTarget && deletedSelection && blockLocation(deletedSelection)) {
    selected = deletedSelection;
    deletedSelection = undefined;
  }
  void submit('schedule');
}

function historyShortcut(event: KeyboardEvent) {
  if (!active || event.defaultPrevented || (!event.ctrlKey && !event.metaKey)) return;
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
    return;
  const key = event.key.toLowerCase();
  const direction =
    key === 'z' && event.shiftKey
      ? 'redo'
      : key === 'z'
        ? 'undo'
        : key === 'y'
          ? 'redo'
          : undefined;
  if (!direction || (direction === 'undo' ? !session.canUndo() : !session.canRedo())) return;
  event.preventDefault();
  replay(direction);
}

const sameDocument = (target: CanvasTarget) =>
  target.document.collection === entryDocument.collection &&
  target.document.id === entryDocument.id;

const read = (root: Record<string, unknown>, path: readonly string[]) =>
  path.reduce<unknown>((node, key) => {
    if (Array.isArray(node)) return node[Number(key)];
    return typeof node === 'object' && node !== null
      ? (node as Record<string, unknown>)[key]
      : undefined;
  }, root);

function textField(value: CanvasSelection | undefined = selected): CanvasTextField | undefined {
  if (
    !active ||
    locked ||
    value?.kind !== 'field' ||
    !sameDocument(value.target) ||
    value.target.locale !== locale ||
    session.localeMutationBlocked(locale)
  )
    return;
  const resolved = session.inspectField(locale, value.target.address);
  if (
    !resolved.ok ||
    !['text', 'richtext'].includes(resolved.target.field.type) ||
    resolved.target.address !== value.target.address ||
    (locale !== sourceLocale && resolved.target.mode !== true)
  )
    return;
  const current = read(session.snapshot(locale), resolved.target.path);
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
        document: session.documentIdentity(),
        locale: target.locale,
        address: target.address,
        kind: value.kind ?? ('text' as const),
        anchor: value.anchor,
        head: value.head,
      }
    : undefined;

const updateFor = (
  target: CanvasTarget,
  selection?: import('./entry-session.svelte').LogicalSelection,
) => {
  const resolved = session.resolveField(target.locale, target.address);
  if (
    !resolved.ok ||
    (resolved.target.field.type !== 'text' && resolved.target.field.type !== 'richtext')
  )
    return;
  const value = read(session.snapshot(target.locale), resolved.target.path);
  if (value !== undefined && typeof value !== 'string') return;
  const matches =
    selection?.document === session.documentIdentity() &&
    selection.locale === target.locale &&
    selection.address === target.address &&
    (selection.kind === 'text' || selection.kind === 'node');
  return {
    value: value ?? '',
    ...(matches && selection.anchor !== undefined && selection.head !== undefined
      ? { selection: { kind: selection.kind, anchor: selection.anchor, head: selection.head } }
      : {}),
  };
};

function canvasCommand(message: CanvasCommandMessage): CanvasCommandResult {
  if (interactionMode !== 'edit') return { ok: false, reason: 'readonly' };
  const target = message.target;
  const editable = textField({ kind: 'field', target });
  if (!editable) return { ok: false, reason: 'readonly' };
  if (message.command.type === 'history') {
    const result = session[message.command.direction]();
    if (!result.ok) return result;
    for (const of of Object.keys(session.snapshots)) session.change(of);
    return {
      ok: true,
      contentVersion: session.contentVersion(locale),
      update: updateFor(target, result.selection),
    };
  }
  const history = message.command.history;
  const result = session.fieldCommand(target.locale, {
    address: target.address,
    contentVersion: message.contentVersion,
    changes: message.command.changes,
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
  if (!result.ok) return result;
  session.change(target.locale);
  return result;
}

function interactionChanged(state: CanvasEditingState) {
  const completed = inlineEditing && !state.inlineEditing;
  inlineEditing = state.inlineEditing;
  if (!completed) return;
  session.historyBoundary();
  void submit('schedule');
}

function setInteractionMode(next: CanvasInteractionMode) {
  if (interactionMode === next) return;
  interactionMode = next;
  actionRefusal = '';
  if (next === 'interact') {
    structureOpen = false;
    inspectorOpen = false;
    blockEditor = undefined;
  }
  renderer?.mode(next);
  if (next === 'edit') {
    renderer?.textField(textField());
    if (selected) renderer?.actions(selected, blockActionsFor(selected));
  }
}

const previewHref = (href: string) => {
  const target = new URL(href, location.href);
  return previewPath(`${target.pathname}${target.search}${target.hash}`);
};

async function openCurrentPreview() {
  navigationError = '';
  if (!(await session.flush())) {
    navigationError = 'Preview was not opened because your changes could not be saved.';
    return;
  }
  window.open(previewPath(url || '/'), '_blank', 'noopener,noreferrer');
}

async function canvasNavigate(message: CanvasNavigationMessage) {
  if (navigationBusy) return;
  navigationBusy = true;
  navigationError = '';
  navigationAction = undefined;
  if (message.kind === 'form') {
    navigationError =
      message.method === 'post'
        ? 'This form cannot submit from Canvas. Open the preview to test its side effects.'
        : 'This form cannot navigate inside Canvas. Open the preview to test it.';
    navigationBusy = false;
    return;
  }
  let index: CanvasNavigationIndex = { entries: [] };
  try {
    const response = await fetch('/admin/api/entries');
    if (response.ok) index = (await response.json()) as CanvasNavigationIndex;
  } catch {
    // An unavailable route index simply makes a same-site destination an explicit preview.
  }
  const destination = classifyCanvasNavigation(message.href, index, location.origin);
  if (!(await session.flush())) {
    navigationError = 'Navigation stopped because your changes could not be saved.';
    navigationBusy = false;
    return;
  }
  if (message.download || message.newTab || destination.kind !== 'entry') {
    navigationAction = { destination, download: message.download };
    navigationBusy = false;
    return;
  }
  onnavigateentry(destination);
  navigationBusy = false;
}

function followNavigationAction() {
  const action = navigationAction;
  if (!action) return;
  const { destination } = action;
  const href =
    destination.kind === 'external' || action.download
      ? destination.href
      : previewHref(destination.href);
  window.open(href, '_blank', 'noopener,noreferrer');
  navigationAction = undefined;
}

$effect(() => {
  const shown = active;
  const shownLocale = locale;
  if (shown && (!wasActive || shownLocale !== lastLocale)) void submit('render');
  wasActive = shown;
});

$effect(() => {
  const selection = selected;
  const shown = active;
  const version = session.contentVersion(locale);
  const phase = rendererState.phase;
  const disabled = locked || session.localeMutationBlocked(locale);
  untrack(() => {
    if (!renderer || phase !== 'ready') return;
    renderer.mode(interactionMode);
    renderer.textField(
      shown && !disabled && interactionMode === 'edit' ? textField(selection) : undefined,
    );
    if (shown && selection && interactionMode === 'edit')
      renderer.actions(selection, blockActionsFor(selection));
  });
  void version;
});

onMount(() => {
  const fitWorkspace = () => {
    if (!workspace || !active) return;
    const bounds = workspace.getBoundingClientRect();
    narrow = bounds.width < 1000;
    workspace.style.setProperty(
      '--canvas-height',
      `${Math.max(420, window.innerHeight - Math.max(0, bounds.top))}px`,
    );
  };
  const resize = new ResizeObserver(fitWorkspace);
  if (workspace) resize.observe(workspace);
  const header = workspace?.closest('.main-editor')?.querySelector('.entry-header');
  if (header) resize.observe(header);
  window.addEventListener('resize', fitWorkspace);
  fitWorkspace();
  addEventListener('keydown', historyShortcut);
  void import('./canvas-renderer').then(({ createCanvasRenderer }) => {
    if (disposed || !stage) return;
    renderer = createCanvasRenderer({
      stage,
      contentVersion: currentVersion,
      currentTarget: () => selected?.target,
      currentSelection: () => selected,
      onCommand: canvasCommand,
      commandRecovery: (message) => {
        const field = textField({ kind: 'field', target: message.target });
        return field ? { value: field.value } : undefined;
      },
      onSelectionChange: selectionChanged,
      onStructureChange: (next) => (structure = next),
      onAction: canvasAction,
      onNavigate: canvasNavigate,
      onInteractionChange: interactionChanged,
      onBridgeRejected: (reason) => {
        if (reason === 'stale-version') setTimeout(() => renderer?.textField(textField()), 0);
      },
      onStateChange: (next) => (rendererState = next),
    });
    loading = false;
    if (active) void submit('render');
  });
  return () => {
    resize.disconnect();
    window.removeEventListener('resize', fitWorkspace);
    removeEventListener('keydown', historyShortcut);
    disposed = true;
    renderer?.dispose();
  };
});
</script>

{#snippet inspectorBlockActions()}
  {#if actionNode && blockActionsFor(actionNode).length}
    <section class="canvas-block-actions" aria-label="Block actions">
      <h3>Block actions <span>{actionNode.label}</span></h3>
      {#each [{ action: 'duplicate', label: 'Duplicate', icon: 'duplicate' }, { action: 'move-up', label: 'Move up', icon: 'up' }, { action: 'move-down', label: 'Move down', icon: 'down' }] as item}
        {#if blockActionsFor(actionNode).includes(item.action as CanvasBlockAction)}
          <button class="btn btn-sm" type="button" onclick={() => { if (actionNode) canvasAction({ action: item.action as CanvasBlockAction, selection: actionNode }); }}><CanvasIcon name={item.icon} />{item.label}</button>
        {/if}
      {/each}
      <details class="canvas-more-actions">
        <summary>More actions <span aria-hidden="true">⋯</span></summary>
        {#each [{ action: 'insert-before', label: 'Insert before' }, { action: 'insert-after', label: 'Insert after' }, { action: 'replace', label: 'Replace block' }] as item}
          {#if blockActionsFor(actionNode).includes(item.action as CanvasBlockAction)}
            <button class="btn btn-sm" type="button" onclick={() => { if (actionNode) openBlockEditor(item.action as 'insert-before' | 'insert-after' | 'replace', actionNode); }}>{item.label}</button>
          {/if}
        {/each}
        {#if blockActionsFor(actionNode).includes('delete')}
          <button class="btn btn-ghost btn-sm canvas-delete" type="button" onclick={() => { if (actionNode) canvasAction({ action: 'delete', selection: actionNode }); }}>Delete block</button>
        {/if}
      </details>
    </section>
  {/if}
{/snippet}

<section
  bind:this={workspace}
  class="canvas-workspace"
  class:is-fullscreen={fullscreen}
  class:is-inactive={!active}
  class:is-mobile-hidden={mobileHidden}
  aria-label="Canvas"
  aria-hidden={!active}
  inert={!active}
  data-selected-address={selected?.target.occurrence?.address ?? selected?.target.address}
>
  <div class="canvas-rail">
    {#if fullscreen}
      <button class="btn btn-ghost canvas-back" type="button" aria-label="Back to form" title="Back to form" onclick={onform}><CanvasIcon name="back" /></button>
      <div class="canvas-identity"><strong title={ownerLabel}>{ownerLabel}</strong><span>Canvas</span></div>
    {/if}
    <div class="canvas-tools">
      <button class="btn btn-ghost canvas-icon-button" type="button" aria-label="Structure" title="Toggle Structure"
        disabled={interactionMode !== 'edit'} aria-expanded={structureVisible} aria-controls="canvas-structure" onclick={toggleStructure}><CanvasIcon name="structure" /></button>
      <button class="btn btn-ghost canvas-icon-button" type="button" aria-label="Inspector" title={selected ? 'Toggle Inspector' : 'Select content to inspect it'}
        disabled={!selected || interactionMode !== 'edit'} aria-expanded={inspectorOpen} aria-controls="canvas-inspector" onclick={toggleInspector}><CanvasIcon name="inspector" /></button>
      <span class="canvas-tool-divider"></span>
      <button class="btn btn-ghost canvas-icon-button" type="button" aria-label="Undo" title="Undo (⌘Z / Ctrl+Z)" disabled={interactionMode !== 'edit' || !session.canUndo()}
        aria-keyshortcuts="Control+Z Meta+Z" onclick={() => replay('undo')}><CanvasIcon name="undo" /></button>
      <button class="btn btn-ghost canvas-icon-button" type="button" aria-label="Redo" title="Redo (⌘⇧Z / Ctrl+Shift+Z)" disabled={interactionMode !== 'edit' || !session.canRedo()}
        aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" onclick={() => replay('redo')}><CanvasIcon name="redo" /></button>
    </div>
    <div class="canvas-view-tools">
      <div class="seg canvas-widths" role="group" aria-label="Canvas viewport">
        {#each WIDTHS as item (item.value)}
          <button type="button" aria-label={item.label} title={item.label} aria-pressed={width === item.value} onclick={() => (width = item.value)}><CanvasIcon name={item.value} /></button>
        {/each}
      </div>
      <select class="canvas-sizing" aria-label="Canvas size" bind:value={sizing} disabled={width !== 'desktop'}>
        <option value="fit">Fit width</option><option value="actual">1280 px</option>
      </select>
      <div class="seg" role="group" aria-label="Canvas interaction">
        <button type="button" aria-pressed={interactionMode === 'edit'} onclick={() => setInteractionMode('edit')}>Edit</button>
        <button type="button" aria-pressed={interactionMode === 'interact'} onclick={() => setInteractionMode('interact')}>Interact</button>
      </div>
    </div>
    <div class="canvas-entry-actions">
      {#if fullscreen}{@render entryActions?.()}{/if}
      <a class="btn btn-sm canvas-preview" href={previewPath(url || '/')} target="_blank" rel="noreferrer"
        onclick={(event) => { event.preventDefault(); void openCurrentPreview(); }}>Preview <CanvasIcon name="external" /></a>
      {#if fullscreen}{@render publishAction?.()}{/if}
    </div>
  </div>
  {#if actionRefusal}<div class="canvas-action-refusal" role="alert">Action refused ({actionRefusal})</div>{/if}

  {#if issues.length}
    <div class="canvas-validation" role="status">
      <div>
        <strong>{issues.length} {issues.length === 1 ? 'field needs' : 'fields need'} attention</strong>
        <span>{issues[0]?.[1]}{issues.length > 1 ? ` · and ${issues.length - 1} more` : ''}. Review the fields to keep Canvas up to date.</span>
      </div>
      <button class="btn btn-sm" type="button" onclick={onreviewproblems}>Review fields</button>
    </div>
  {/if}

  {#if navigationError}
    <div class="canvas-navigation-notice" role="alert">
      <span>{navigationError}</span>
      <button class="btn btn-sm" type="button" onclick={() => (navigationError = '')}>Dismiss</button>
    </div>
  {:else if navigationAction}
    <div class="canvas-navigation-notice" role="status">
      <span>
        {navigationAction.download
          ? 'This download opens outside Canvas.'
          : navigationAction.destination.kind === 'external'
            ? 'This link leaves the site.'
            : 'This page opens as a normal preview.'}
      </span>
      <button class="btn btn-sm" type="button" onclick={() => (navigationAction = undefined)}>Cancel</button>
      <button class="btn btn-sm btn-primary" type="button" onclick={followNavigationAction}>
        {navigationAction.download ? 'Open download' : navigationAction.destination.kind === 'external' ? 'Open link' : 'Open preview'} ↗
      </button>
    </div>
  {/if}

  {#if failure}
    <div class="canvas-failure" role="alert">
      <div>
        <strong>Canvas could not update</strong>
        <span>{failure.message ?? 'Your changes remain in the editor. The last working page is still available.'}</span>
      </div>
      <button class="btn btn-sm" type="button" onclick={onform}>Go to Form</button>
      <button class="btn btn-sm" type="button" onclick={retry}>Retry</button>
    </div>
  {/if}

  <div class:has-structure={structureVisible} class:has-inspector={inspectorOpen && !!selected} class="canvas-workarea">
    <div class="canvas-panel-slot canvas-structure-slot" class:is-open={structureVisible} aria-hidden={!structureVisible} inert={!structureVisible}>
      <aside class="canvas-structure" class:is-block-editor={!!blockEditor} id="canvas-structure" aria-labelledby="canvas-structure-title">
        <div class="canvas-structure-home">
          <header>
            <h2 id="canvas-structure-title">Structure</h2>
            <button class="btn btn-ghost btn-sm" type="button" aria-label="Close Structure" onclick={() => (structureOpen = false)}><CanvasIcon name="collapse-left" /></button>
          </header>
          {#if structure.length}
            <div class="canvas-structure-tree" aria-label="Page structure" role="tree">
              {#each visibleStructure as node (canvasNodeKey(node))}
                {@const branch = branches.has(node.id)}
                {@const shut = branch && collapsed[canvasNodeKey(node)] === true}
                <button
                  type="button"
                  role="treeitem"
                  class:is-branch={branch}
                  aria-level={treeDepth(node)}
                  aria-posinset={node.position}
                  aria-setsize={node.setSize}
                  aria-selected={sameSelection(node, selected)}
                  aria-expanded={branch ? !shut : undefined}
                  aria-current={sameSelection(node, selected) ? 'true' : undefined}
                  data-target-address={node.target.occurrence?.address ?? node.target.address}
                  style={`--canvas-indent:${8 + (treeDepth(node) - 1) * 14}px`}
                  onclick={(event) => {
                    if (branch && (event.target as Element).closest('.canvas-structure-twisty')) toggleBranch(node);
                    else selectNode(node);
                  }}
                  onkeydown={(event) => {
                    if (!branch || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
                    if (shut === (event.key === 'ArrowLeft')) return;
                    event.preventDefault();
                    toggleBranch(node);
                  }}
                >
                  {#if branch}
                    <span class="canvas-structure-twisty" aria-hidden="true">{shut ? '▸' : '▾'}</span>
                  {:else}
                    <span class="canvas-structure-twisty is-leaf" aria-hidden="true"></span>
                  {/if}
                  <span class="canvas-structure-kind" aria-hidden="true"><CanvasIcon name={nodeIcon(node)} /></span>
                  <span class="canvas-structure-name">{treeLabel(node)}</span>
                  {#if node.empty}<small>Empty</small>{/if}
                  {#if node.occurrences > 1}<small>{node.occurrences}×</small>{/if}
                </button>
              {/each}
            </div>
          {:else}
            <p class="canvas-structure-empty">This template has no editable annotations.</p>
          {/if}
          <footer>
            <button bind:this={addBlockButton} class="btn btn-sm" type="button" disabled={!insertionNode || interactionMode !== 'edit'}
              onclick={() => { if (insertionNode) openBlockEditor(insertionNode.kind === 'list' ? 'insert-empty' : 'insert-after', insertionNode); }}><CanvasIcon name="plus" /> Add block</button>
          </footer>
        </div>
        {#if blockEditor}
          <div class="canvas-structure-forward" transition:fly={{ x: 40, duration: 220, easing: cubicOut }}>
            <CanvasBlockEditor
              mode={blockEditor.mode}
              types={blockEditor.types}
              currentType={blockEditor.currentType}
              {blocks}
              {mediaBase}
              {locale}
              {site}
              {servedAt}
              {locked}
              onapply={applyBlock}
              onclose={closeBlockEditor}
            />
          </div>
        {/if}
      </aside>
    </div>
    <div class="canvas-stage-shell">
      <div class="canvas-stage is-{width}" class:is-actual={sizing === 'actual'} bind:this={stage} aria-label="Editable page Canvas"></div>
    </div>
    <div class="canvas-panel-slot canvas-inspector-slot" class:is-open={inspectorOpen && !!selected} aria-hidden={!(inspectorOpen && selected)} inert={!(inspectorOpen && selected)}>
      {#if inspectorOpen && selected}
        <div class="canvas-inspector-motion" transition:fly={{ x: 20, duration: 200, easing: cubicOut }}>
          <CanvasInspector
            selection={selected}
            inlineRichtext={textField(selected)?.kind === 'richtext'}
            selectionLabel={selectedNode?.label}
            context={breadcrumb}
            blockActions={inspectorBlockActions}
            {entryDocument}
            {ownerLabel}
            {locale}
            {sourceLocale}
            {session}
            {blocks}
            {problems}
            {mediaBase}
            {site}
            {servedAt}
            {locked}
            onschedule={() => void submit('schedule')}
            onclose={() => (inspectorOpen = false)}
            onform={onformtarget}
          />
        </div>
      {/if}
    </div>
  </div>
  <footer class="canvas-statusbar">
    <span class="canvas-breadcrumb" title={breadcrumb}>{breadcrumb || 'Select content to edit · Double-click text to write'}</span>
    <span class="canvas-render-state" class:is-busy={loading || rendererState.phase === 'rendering'} class:is-failed={rendererState.phase === 'failed'} role="status">{status}</span>
  </footer>
</section>
