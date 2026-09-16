<script lang="ts">
import { richtextErrors } from '@handover/core';
import { onMount, type Snippet, tick, untrack } from 'svelte';
import { cubicOut } from 'svelte/easing';
import { fly } from 'svelte/transition';
import { readEntryDirectory } from '../entry-directory';
import { messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { previewPath } from '../request';
import CanvasBlockEditor from './CanvasBlockEditor.svelte';
import CanvasIcon from './CanvasIcon.svelte';
import CanvasInspector from './CanvasInspector.svelte';
import { resolveStagedBlockIndex, type StagedBlockTarget } from './canvas-block-target';
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
import type {
  CanvasRendererState,
  CanvasRenderRequest,
  createCanvasRenderer,
} from './canvas-renderer';
import { canvasNodeKey, visibleCanvasNodes } from './canvas-structure';
import { sameCanvasSelection } from './canvas-target';
import {
  type CanvasInteractionMode,
  type CanvasNavigationDestination,
  type CanvasNavigationIndex,
  classifyCanvasNavigation,
} from './runtime/canvas-navigation';

type Renderer = ReturnType<typeof createCanvasRenderer>;
type Width = 'desktop' | 'tablet' | 'phone';
type ResizablePanel = 'structure' | 'inspector';

const PANEL_WIDTHS = {
  structure: { default: 250, min: 210, max: 420 },
  inspector: { default: 380, min: 320, max: 640 },
} as const;
const PANEL_WIDTH_STORAGE = 'handover.canvas.panel-widths';
const MIN_CANVAS_WIDTH = 360;

let {
  active,
  fullscreen = false,
  entryActions,
  publishAction,
  locale,
  uiLocale = 'en',
  url,
  request,
  currentVersion,
  entryDocument,
  ownerLabel,
  sourceLocale,
  session,
  blocks,
  blockLabels,
  problems = {},
  mediaBase = '',
  site,
  servedAt,
  locked = false,
  onform,
  onreviewproblems,
  onnavigateentry,
  mobileHidden = false,
}: {
  active: boolean;
  fullscreen?: boolean;
  entryActions?: Snippet;
  publishAction?: Snippet;
  locale: string;
  uiLocale?: UiLocale;
  url: string;
  request: () => CanvasRenderRequest;
  currentVersion: () => number;
  entryDocument: CanvasRenderRequest['snapshot']['entry'];
  ownerLabel: string;
  sourceLocale: string;
  session: import('../editor/entry-session.svelte').EntrySession;
  blocks: Record<string, import('@handover/core').Field[]>;
  blockLabels?: import('@handover/core').Form['blockLabels'];
  problems?: Record<string, string>;
  mediaBase?: string;
  site?: string;
  servedAt?: string;
  locked?: boolean;
  onform: () => void;
  onreviewproblems: () => void;
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
let structureOpen = $state(false);
let structureWidth = $state<number>(PANEL_WIDTHS.structure.default);
let initializedPanels = false;
$effect(() => {
  if (active && fullscreen && !initializedPanels) {
    initializedPanels = true;
    structureOpen = window.innerWidth >= 1000;
  }
});
let inspectorOpen = $state(false);
let inspectorWidth = $state<number>(PANEL_WIDTHS.inspector.default);
let resizing = $state<{
  panel: ResizablePanel;
  pointerId: number;
  startX: number;
  startWidth: number;
}>();
const incomplete = $derived(session.incompleteFields(locale, uiLocale));
const incompletePaths = $derived(Object.keys(incomplete));
const issues = $derived(Object.entries({ ...incomplete, ...problems }));
// Untouched required fields are an ordinary work-in-progress state. Review fields reveals
// their validation in Form; unrelated schema errors remain visible beside their controls.
const inspectorProblems = $derived(
  Object.fromEntries(
    Object.entries(problems).filter(
      ([path]) =>
        !incompletePaths.some((missing) => path === missing || path.startsWith(`${missing}.`)),
    ),
  ),
);
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
type NavigationError = 'form-get' | 'form-post' | 'navigation-save' | 'preview-save';
let navigationError = $state<NavigationError>();
let navigationBusy = false;
let mediaPickerRequest = $state(0);
let navigationAction = $state<{
  destination: CanvasNavigationDestination;
  download: boolean;
}>();
let deletedSelection: CanvasSelection | undefined;
type BlockEditorState = StagedBlockTarget & {
  address: string;
  types: readonly string[];
  currentType?: string;
};
let blockEditor = $state<BlockEditorState>();
const structureVisible = $derived(structureOpen && !(narrow && inspectorOpen));

const options = $derived(messageOptions(uiLocale));
const widths = $derived([
  { value: 'desktop' as const, label: m.preview_desktop({}, options) },
  { value: 'tablet' as const, label: m.preview_tablet({}, options) },
  { value: 'phone' as const, label: m.preview_phone({}, options) },
]);

const status = $derived(
  loading
    ? m.canvas_preparing({}, options)
    : incompletePaths.length
      ? m.canvas_complete_required_status({}, options)
      : rendererState.phase === 'rendering'
        ? m.canvas_updating({}, options)
        : rendererState.phase === 'ready'
          ? m.canvas_updated({}, options)
          : rendererState.phase === 'failed'
            ? m.canvas_update_failed({}, options)
            : m.canvas_ready({}, options),
);
const failure = $derived(rendererState.phase === 'failed' ? rendererState : undefined);
const failureText = $derived.by(() => {
  if (!failure) return '';
  if (failure.reason === 'timeout') return m.canvas_failure_timeout({}, options);
  if (failure.reason === 'stale') return m.canvas_failure_stale({}, options);
  if (failure.reason === 'render')
    return failure.status
      ? m.canvas_failure_render_status({ status: failure.status }, options)
      : m.canvas_failure_render({}, options);
  return m.canvas_failure_start({}, options);
});
const navigationErrorText = $derived.by(() => {
  switch (navigationError) {
    case 'preview-save':
      return m.canvas_preview_save_failed({}, options);
    case 'navigation-save':
      return m.canvas_navigation_save_failed({}, options);
    case 'form-post':
      return m.canvas_form_submit_blocked({}, options);
    case 'form-get':
      return m.canvas_form_navigation_blocked({}, options);
    default:
      return '';
  }
});
const actionRefusalText = $derived.by(() => {
  if (!actionRefusal) return '';
  if (actionRefusal === 'stale') return m.canvas_action_stale({}, options);
  if (actionRefusal === 'deleted') return m.canvas_action_deleted({}, options);
  if (actionRefusal === 'readonly' || actionRefusal === 'closed')
    return m.canvas_action_readonly({}, options);
  if (
    actionRefusal === 'ambiguous' ||
    actionRefusal === 'drift' ||
    actionRefusal === 'referenced' ||
    actionRefusal === 'schema' ||
    actionRefusal === 'structural'
  )
    return m.canvas_action_structure_changed({}, options);
  if (actionRefusal === 'empty' || actionRefusal === 'frozen')
    return m.canvas_action_history_unavailable({}, options);
  return m.canvas_action_refused({ reason: actionRefusal }, options);
});
const selectedNode = $derived(structure.find((node) => sameCanvasSelection(node, selected)));
let collapsed = $state<Record<string, boolean>>({});
const parentOf = (node: CanvasStructureNode) =>
  node.parentId ? structure.find((candidate) => candidate.id === node.parentId) : undefined;
const structuralName = (node: CanvasStructureNode) =>
  node.target.address.split('.').at(-1)?.replace(/\[.*$/, '').toLowerCase();
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
          (structuralName(node) === 'blocks' || structuralName(node) === 'columns'),
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
  if (!node.parentId && node.kind === 'list' && structuralName(node) === 'blocks')
    return m.canvas_page({}, options);
  if (
    structuralName(parentOf(node) ?? node) === 'columns' &&
    node.label === m.canvas_selection_block_position({ position: node.position }, options)
  )
    return m.canvas_column({ number: node.position }, options);
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
    if (!hiddenWrappers.has(node.id) && treeLabel(node) !== m.canvas_page({}, options))
      result.unshift(treeLabel(node));
    node = node.parentId
      ? structure.find((candidate) => candidate.id === node?.parentId)
      : undefined;
  }
  return [m.canvas_page({}, options), ...result].join(' / ');
});

async function submit(kind: 'render' | 'schedule', force = false) {
  if (!active || !renderer) return;
  if (untrack(() => incompletePaths.length)) {
    renderer.pause();
    return;
  }
  const nextLocale = locale;
  const version = untrack(currentVersion);
  if (!force && nextLocale === lastLocale && version === lastVersion) {
    if (kind === 'render') renderer.flushScheduled();
    return;
  }
  lastLocale = nextLocale;
  lastVersion = version;
  await tick();
  if (!active || disposed) return;
  if (untrack(() => incompletePaths.length)) {
    renderer.pause();
    return;
  }
  try {
    await (kind === 'schedule'
      ? renderer.schedule(() => untrack(request))
      : renderer.render(untrack(request)));
  } catch (error) {
    rendererState = {
      phase: 'failed',
      requestId: crypto.randomUUID(),
      contentVersion: version,
      reason: 'bootstrap',
      ...(error instanceof Error ? { message: error.message } : {}),
    };
  }
}

export function schedule(policy: 'continuous' | 'discrete' = 'discrete') {
  return submit(policy === 'continuous' ? 'schedule' : 'render');
}

function retry() {
  void submit('render', true);
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
  inspectorOpen = !inspectorOpen;
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

function panelMaximum(panel: ResizablePanel) {
  const available = workspace?.clientWidth ?? window.innerWidth;
  const other =
    panel === 'structure'
      ? inspectorOpen
        ? inspectorWidth
        : 0
      : structureVisible
        ? structureWidth
        : 0;
  return Math.max(
    PANEL_WIDTHS[panel].min,
    Math.min(PANEL_WIDTHS[panel].max, available - other - MIN_CANVAS_WIDTH),
  );
}

function setPanelWidth(panel: ResizablePanel, value: number) {
  const width = Math.round(clamp(value, PANEL_WIDTHS[panel].min, panelMaximum(panel)));
  if (panel === 'structure') structureWidth = width;
  else inspectorWidth = width;
}

function storePanelWidths() {
  try {
    localStorage.setItem(
      PANEL_WIDTH_STORAGE,
      JSON.stringify({ structure: structureWidth, inspector: inspectorWidth }),
    );
  } catch {
    // Private browsing can disable storage; resizing still works for the current session.
  }
}

function beginPanelResize(panel: ResizablePanel, event: PointerEvent) {
  if (narrow || event.button !== 0) return;
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture(event.pointerId);
  resizing = {
    panel,
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: panel === 'structure' ? structureWidth : inspectorWidth,
  };
}

function continuePanelResize(event: PointerEvent) {
  const activeResize = resizing;
  if (!activeResize || activeResize.pointerId !== event.pointerId) return;
  const movement = event.clientX - activeResize.startX;
  setPanelWidth(
    activeResize.panel,
    activeResize.startWidth + (activeResize.panel === 'structure' ? movement : -movement),
  );
}

function finishPanelResize(event: PointerEvent) {
  if (!resizing || resizing.pointerId !== event.pointerId) return;
  const handle = event.currentTarget as HTMLElement;
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  resizing = undefined;
  storePanelWidths();
}

function resizePanelWithKeyboard(panel: ResizablePanel, event: KeyboardEvent) {
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    setPanelWidth(panel, event.key === 'Home' ? PANEL_WIDTHS[panel].min : panelMaximum(panel));
    storePanelWidths();
    return;
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const movement = event.key === 'ArrowRight' ? 16 : -16;
  const current = panel === 'structure' ? structureWidth : inspectorWidth;
  setPanelWidth(panel, current + (panel === 'structure' ? movement : -movement));
  storePanelWidths();
}

function resetPanelWidth(panel: ResizablePanel) {
  setPanelWidth(panel, PANEL_WIDTHS[panel].default);
  storePanelWidths();
}

// A saved wide-screen preference must not squeeze the Canvas out when a smaller desktop opens
// both panels. Reduce the Inspector first, then Structure, while keeping both usable.
$effect(() => {
  if (narrow || !workspace || !structureVisible || !inspectorOpen) return;
  const available = workspace.clientWidth - MIN_CANVAS_WIDTH;
  if (structureWidth + inspectorWidth <= available) return;
  inspectorWidth = Math.max(
    PANEL_WIDTHS.inspector.min,
    Math.min(inspectorWidth, available - structureWidth),
  );
  structureWidth = Math.max(
    PANEL_WIDTHS.structure.min,
    Math.min(structureWidth, available - inspectorWidth),
  );
});

function selectionChanged(next: CanvasSelection | undefined, reason?: 'restore') {
  if (interactionMode !== 'edit') return;
  selected = next;
  void tick().then(() => {
    renderer?.textField(textField(next));
    if (next) renderer?.actions(next, blockActionsFor(next));
  });
  if (!next) return;
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
    id: match[2] as string,
    index,
    rows: value,
    types: inspected.target.field.types,
    ...(currentType ? { currentType } : {}),
  };
}

function blockInspectorFor(selection: CanvasSelection | undefined) {
  if (
    selection?.kind !== 'block' ||
    !sameDocument(selection.target) ||
    selection.target.locale !== locale
  )
    return;
  const match = /^(.*)\[_id=([^\]]+)\]$/.exec(selection.target.address);
  if (!match) return;
  const address = match[1] ?? '';
  const inspected = session.inspectField(locale, address);
  if (!inspected.ok || inspected.target.field.type !== 'blocks') return;
  const rows = read(session.snapshot(locale), inspected.target.path);
  if (!Array.isArray(rows)) return;
  const index = rows.findIndex(
    (row) =>
      typeof row === 'object' &&
      row !== null &&
      !Array.isArray(row) &&
      (row as Record<string, unknown>)._id === match[2],
  );
  if (index < 0) return;
  const row = rows[index];
  const type =
    typeof row === 'object' && row !== null && !Array.isArray(row)
      ? String((row as Record<string, unknown>)._type ?? '')
      : '';
  const fields = blocks[type];
  if (!type || !fields) return;
  return { fields, path: [...inspected.target.path, String(index)], type };
}

const blockActionsFor = (selection: CanvasSelection): CanvasBlockAction[] => {
  if (interactionMode !== 'edit') return [];
  const history: CanvasBlockAction[] = [
    ...(session.canUndo() ? (['undo'] as const) : []),
    ...(session.canRedo() ? (['redo'] as const) : []),
  ];
  if (selection.kind === 'field') {
    const resolved =
      sameDocument(selection.target) && selection.target.locale === locale
        ? session.inspectField(locale, selection.target.address)
        : undefined;
    const canReplaceImage =
      resolved?.ok &&
      resolved.target.field.type === 'image' &&
      locale === sourceLocale &&
      !locked &&
      !session.localeMutationBlocked(locale);
    return [...(canReplaceImage ? (['replace-media'] as const) : []), ...history];
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
            original: structuredClone($state.snapshot(location.rows[location.index])),
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
  const inspected = session.inspectField(locale, address);
  if (!inspected.ok || inspected.target.field.type !== 'blocks') return;
  const value = read(session.snapshot(locale), inspected.target.path);
  if (value !== undefined && (!Array.isArray(value) || value.length > 0)) return;
  return {
    mode: 'insert' as const,
    placement: 'empty' as const,
    address,
    types: inspected.target.field.types,
  };
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
function closeBlockEditor(reason?: 'applied') {
  blockEditor = undefined;
  if (reason === 'applied') return;
  const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280;
  window.setTimeout(() => addBlockButton?.focus(), delay);
}

function applyBlock(value: Record<string, unknown>) {
  const editing = blockEditor;
  if (!editing) return { ok: false as const, reason: 'stale' as const };
  const inspected = session.inspectField(locale, editing.address);
  if (!inspected.ok) return inspected;
  if (inspected.target.field.type !== 'blocks')
    return { ok: false as const, reason: 'schema' as const };
  const held = read(session.snapshot(locale), inspected.target.path);
  if (held !== undefined && !Array.isArray(held))
    return { ok: false as const, reason: 'schema' as const };
  const target = resolveStagedBlockIndex(editing, held ?? []);
  if (!target.ok) return target;
  const result = session.listCommand(locale, {
    address: editing.address,
    contentVersion: session.contentVersion(locale),
    operation:
      editing.mode === 'replace'
        ? { type: 'replace', index: target.index, value }
        : { type: 'insert', index: target.index, value },
  });
  if (!result.ok) return result;
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
  if (editing.mode === 'insert') {
    inspectorOpen = true;
    mediaPickerRequest = 0;
  }
  void submit('render');
  return result;
}

function canvasAction(message: Pick<CanvasActionMessage, 'action' | 'destination' | 'selection'>) {
  if (interactionMode !== 'edit') return;
  if (message.action === 'replace-media') {
    selected = message.selection;
    blockEditor = undefined;
    inspectorOpen = true;
    mediaPickerRequest += 1;
    return;
  }
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
  void submit('render');
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
  if (missingDeletedTarget && deletedSelection && blockLocation(deletedSelection)) {
    selected = deletedSelection;
    deletedSelection = undefined;
  }
  void submit('render');
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
    !['text', 'richtext', 'link'].includes(resolved.target.field.type) ||
    resolved.target.address !== value.target.address ||
    (locale !== sourceLocale && resolved.target.mode !== true)
  )
    return;
  const current = read(session.snapshot(locale), resolved.target.path);
  if (resolved.target.field.type === 'link') {
    if (
      current !== undefined &&
      (typeof current !== 'object' || current === null || Array.isArray(current))
    )
      return;
    const link = (current as Record<string, unknown> | undefined) ?? {};
    const label = link.label;
    if (label !== undefined && typeof label !== 'string') return;
    if (locale === sourceLocale)
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
  selection?: import('../editor/entry-session.svelte').LogicalSelection,
) => {
  const resolved = session.resolveField(target.locale, target.address);
  if (!resolved.ok || !['text', 'richtext', 'link'].includes(resolved.target.field.type)) return;
  const value = read(session.snapshot(target.locale), resolved.target.path);
  const text =
    resolved.target.field.type === 'link'
      ? typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).label
        : undefined
      : value;
  if (text !== undefined && typeof text !== 'string') return;
  const matches =
    selection?.document === session.documentIdentity() &&
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
  if (interactionMode !== 'edit') return { ok: false, reason: 'readonly' };
  const target = message.target;
  const editable = textField({ kind: 'field', target });
  if (!editable) return { ok: false, reason: 'readonly' };
  if (message.command.type === 'history') {
    const result = session[message.command.direction]();
    if (!result.ok) return result;
    return {
      ok: true,
      contentVersion: session.contentVersion(locale),
      update: updateFor(target, result.selection),
    };
  }
  const history = message.command.history;
  const resolved = session.inspectField(target.locale, target.address);
  const changes =
    resolved.ok && resolved.target.field.type === 'link' && editable.kind === 'text'
      ? message.command.changes.map((change) => ({
          ...change,
          path: ['label', ...(change.path ?? [])],
        }))
      : message.command.changes;
  const result = session.fieldCommand(target.locale, {
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
  if (!result.ok) return result;
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
  navigationError = undefined;
  if (!(await session.flush())) {
    navigationError = 'preview-save';
    return;
  }
  window.open(previewPath(url || '/'), '_blank', 'noopener,noreferrer');
}

async function canvasNavigate(message: CanvasNavigationMessage) {
  if (navigationBusy) return;
  navigationBusy = true;
  navigationError = undefined;
  navigationAction = undefined;
  if (message.kind === 'form') {
    navigationError = message.method === 'post' ? 'form-post' : 'form-get';
    navigationBusy = false;
    return;
  }
  let index: CanvasNavigationIndex = { entries: [] };
  try {
    index = await readEntryDirectory();
  } catch {
    // An unavailable route index simply makes a same-site destination an explicit preview.
  }
  const destination = classifyCanvasNavigation(message.href, index, location.origin);
  if (!(await session.flush())) {
    navigationError = 'navigation-save';
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
  const next = uiLocale;
  untrack(() => renderer?.uiLocale(next));
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
  try {
    const stored = JSON.parse(localStorage.getItem(PANEL_WIDTH_STORAGE) ?? '{}') as Record<
      string,
      unknown
    >;
    if (typeof stored.structure === 'number') setPanelWidth('structure', stored.structure);
    if (typeof stored.inspector === 'number') setPanelWidth('inspector', stored.inspector);
  } catch {
    // Ignore malformed or unavailable local storage and keep the considered defaults.
  }
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
      uiLocale: () => uiLocale,
      currentSelection: () => selected,
      onCommand: canvasCommand,
      commandRecovery: (message) => {
        const field = textField({ kind: 'field', target: message.target });
        return field
          ? { value: field.kind === 'link' ? field.value.label : field.value }
          : undefined;
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

<section
  bind:this={workspace}
  class="canvas-workspace"
  class:is-fullscreen={fullscreen}
  class:is-inactive={!active}
  class:is-mobile-hidden={mobileHidden}
  aria-label={m.canvas_label({}, options)}
  aria-hidden={!active}
  inert={!active}
  data-selected-address={selected?.target.occurrence?.address ?? selected?.target.address}
>
  <div class="canvas-rail">
    {#if fullscreen}
      <button class="btn btn-ghost canvas-back" type="button" aria-label={m.canvas_back_to_form({}, options)} title={m.canvas_back_to_form({}, options)} onclick={onform}><CanvasIcon name="back" /></button>
      <div class="canvas-identity"><strong title={ownerLabel}>{ownerLabel}</strong><span>{m.canvas_label({}, options)}</span></div>
    {/if}
    <div class="canvas-tools">
      <div class="canvas-panel-tools" role="group" aria-label={m.canvas_editor_panels({}, options)}>
        <button class="btn btn-ghost canvas-panel-toggle" type="button" title={m.canvas_toggle_structure({}, options)}
          disabled={interactionMode !== 'edit'} aria-expanded={structureVisible} aria-controls="canvas-structure" onclick={toggleStructure}><CanvasIcon name="structure" /><span>{m.canvas_structure({}, options)}</span></button>
        <button class="btn btn-ghost canvas-panel-toggle" type="button" title={m.canvas_toggle_inspector({}, options)}
          disabled={interactionMode !== 'edit'} aria-expanded={inspectorOpen} aria-controls="canvas-inspector" onclick={toggleInspector}><CanvasIcon name="inspector" /><span>{m.canvas_inspector({}, options)}</span></button>
      </div>
      <span class="canvas-tool-divider"></span>
      <button class="btn btn-ghost canvas-icon-button" type="button" aria-label={m.canvas_undo({}, options)} title={m.canvas_undo_shortcut({}, options)} disabled={interactionMode !== 'edit' || !session.canUndo()}
        aria-keyshortcuts="Control+Z Meta+Z" onclick={() => replay('undo')}><CanvasIcon name="undo" /></button>
      <button class="btn btn-ghost canvas-icon-button" type="button" aria-label={m.canvas_redo({}, options)} title={m.canvas_redo_shortcut({}, options)} disabled={interactionMode !== 'edit' || !session.canRedo()}
        aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" onclick={() => replay('redo')}><CanvasIcon name="redo" /></button>
    </div>
    <div class="canvas-view-tools">
      <div class="seg canvas-widths" role="group" aria-label={m.canvas_viewport({}, options)}>
        {#each widths as item (item.value)}
          <button type="button" aria-label={item.label} title={item.label} aria-pressed={width === item.value} onclick={() => (width = item.value)}><CanvasIcon name={item.value} /></button>
        {/each}
      </div>
      <div class="seg" role="group" aria-label={m.canvas_interaction({}, options)}>
        <button type="button" aria-pressed={interactionMode === 'edit'} onclick={() => setInteractionMode('edit')}>{m.canvas_edit({}, options)}</button>
        <button type="button" aria-pressed={interactionMode === 'interact'} onclick={() => setInteractionMode('interact')}>{m.canvas_interact({}, options)}</button>
      </div>
    </div>
    <div class="canvas-entry-actions">
      {#if fullscreen}{@render entryActions?.()}{/if}
      <a class="btn btn-sm canvas-preview" href={previewPath(url || '/')} target="_blank" rel="noreferrer"
        onclick={(event) => { event.preventDefault(); void openCurrentPreview(); }}>{m.preview_title({}, options)} <CanvasIcon name="external" /></a>
      {#if fullscreen}{@render publishAction?.()}{/if}
    </div>
    <span class="visually-hidden canvas-render-state" class:is-busy={loading || rendererState.phase === 'rendering'} class:is-failed={rendererState.phase === 'failed'} role="status">{status}</span>
  </div>
  {#if actionRefusal}<div class="canvas-action-refusal" role="alert">{actionRefusalText}</div>{/if}

  {#if issues.length}
    <div class="canvas-validation" class:is-incomplete={incompletePaths.length > 0} role="status">
      <div>
        {#if incompletePaths.length}
          <span>{m.canvas_complete_required({}, options)}</span>
        {:else}
          <strong>{m.canvas_fields_need_attention({ count: issues.length }, options)}</strong>
          <span>{issues[0]?.[1]}{issues.length > 1 ? ` · ${m.canvas_more_issues({ count: issues.length - 1 }, options)}` : ''}. {m.canvas_review_to_update({}, options)}</span>
        {/if}
      </div>
      <button class="btn btn-sm" type="button" onclick={onreviewproblems}>{m.canvas_review_fields({}, options)}</button>
    </div>
  {/if}

  {#if navigationError}
    <div class="canvas-navigation-notice" role="alert">
      <span>{navigationErrorText}</span>
      <button class="btn btn-sm" type="button" onclick={() => (navigationError = undefined)}>{m.canvas_dismiss({}, options)}</button>
    </div>
  {:else if navigationAction}
    <div class="canvas-navigation-notice" role="status">
      <span>
        {navigationAction.download
          ? m.canvas_download_outside({}, options)
          : navigationAction.destination.kind === 'external'
            ? m.canvas_link_leaves_site({}, options)
            : m.canvas_page_opens_preview({}, options)}
      </span>
      <button class="btn btn-sm" type="button" onclick={() => (navigationAction = undefined)}>{m.common_cancel({}, options)}</button>
      <button class="btn btn-sm btn-primary" type="button" onclick={followNavigationAction}>
        {navigationAction.download ? m.canvas_open_download({}, options) : navigationAction.destination.kind === 'external' ? m.canvas_open_link({}, options) : m.canvas_open_preview({}, options)} ↗
      </button>
    </div>
  {/if}

  {#if failure && !incompletePaths.length}
    <div class="canvas-failure" role="alert">
      <div>
        <strong>{m.canvas_could_not_update({}, options)}</strong>
        <span>{failureText}</span>
        {#if failure.message}<small>{failure.message}</small>{/if}
      </div>
      <button class="btn btn-sm" type="button" onclick={onform}>{m.canvas_go_to_form({}, options)}</button>
      <button class="btn btn-sm" type="button" onclick={retry}>{m.common_retry({}, options)}</button>
    </div>
  {/if}

  <div
    class:has-structure={structureVisible}
    class:has-inspector={inspectorOpen}
    class:is-resizing={!!resizing}
    class="canvas-workarea"
    style={`--canvas-structure-width:${structureWidth}px;--canvas-inspector-width:${inspectorWidth}px`}
  >
    <div class="canvas-panel-slot canvas-structure-slot" class:is-open={structureVisible} aria-hidden={!structureVisible} inert={!structureVisible}>
      <aside class="canvas-structure" class:is-block-editor={!!blockEditor} id="canvas-structure" aria-labelledby="canvas-structure-title">
        <div class="canvas-structure-home">
          <header>
            <div>
              <h2 id="canvas-structure-title">{m.canvas_structure({}, options)}</h2>
              <span>{m.canvas_editable_items({ count: structure.length }, options)}</span>
            </div>
            <button class="btn btn-ghost btn-sm" type="button" aria-label={m.canvas_close_structure({}, options)} onclick={() => (structureOpen = false)}><CanvasIcon name="collapse-left" /></button>
          </header>
          {#if structure.length}
            <div class="canvas-structure-tree" aria-label={m.canvas_page_structure({}, options)} role="tree">
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
                  aria-selected={sameCanvasSelection(node, selected)}
                  aria-expanded={branch ? !shut : undefined}
                  aria-current={sameCanvasSelection(node, selected) ? 'true' : undefined}
                  data-target-address={node.target.occurrence?.address ?? node.target.address}
                  style={`--canvas-indent:${7 + (treeDepth(node) - 1) * 12}px`}
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
                  {#if node.empty}<small>{m.canvas_empty({}, options)}</small>{/if}
                  {#if node.occurrences > 1}<small>{node.occurrences}×</small>{/if}
                </button>
              {/each}
            </div>
          {:else}
            <p class="canvas-structure-empty">{m.canvas_no_annotations({}, options)}</p>
          {/if}
          <footer>
            <button bind:this={addBlockButton} class="btn btn-sm" type="button" disabled={!insertionNode || interactionMode !== 'edit'}
              onclick={() => { if (insertionNode) openBlockEditor(insertionNode.kind === 'list' ? 'insert-empty' : 'insert-after', insertionNode); }}><CanvasIcon name="plus" /> {m.canvas_add_block({}, options)}</button>
          </footer>
        </div>
        {#if blockEditor}
          <div class="canvas-structure-forward" transition:fly={{ x: 40, duration: 220, easing: cubicOut }}>
            <CanvasBlockEditor
              mode={blockEditor.mode}
              types={blockEditor.types}
              currentType={blockEditor.currentType}
              {blocks}
              {blockLabels}
              {mediaBase}
              {locale}
              {uiLocale}
              {site}
              {servedAt}
              {locked}
              onapply={applyBlock}
              onclose={closeBlockEditor}
            />
          </div>
        {/if}
      </aside>
      {#if structureVisible && !narrow}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- ARIA's adjustable separator pattern is keyboard interactive. -->
        <div
          class="canvas-panel-resizer canvas-structure-resizer"
          class:is-active={resizing?.panel === 'structure'}
          role="separator"
          aria-label={m.canvas_resize_structure({}, options)}
          aria-orientation="vertical"
          aria-valuemin={PANEL_WIDTHS.structure.min}
          aria-valuemax={panelMaximum('structure')}
          aria-valuenow={structureWidth}
          aria-valuetext={m.canvas_pixels({ count: structureWidth }, options)}
          tabindex="0"
          title={m.canvas_resize_hint({}, options)}
          onpointerdown={(event) => beginPanelResize('structure', event)}
          onpointermove={continuePanelResize}
          onpointerup={finishPanelResize}
          onpointercancel={finishPanelResize}
          onkeydown={(event) => resizePanelWithKeyboard('structure', event)}
          ondblclick={() => resetPanelWidth('structure')}
        ></div>
      {/if}
    </div>
    <div class="canvas-stage-shell">
      <div class="canvas-stage is-{width}" bind:this={stage} aria-label={m.canvas_editable_page({}, options)}></div>
    </div>
    <div class="canvas-panel-slot canvas-inspector-slot" class:is-open={inspectorOpen} aria-hidden={!inspectorOpen} inert={!inspectorOpen}>
      {#if inspectorOpen}
        {#if !narrow}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- ARIA's adjustable separator pattern is keyboard interactive. -->
          <div
            class="canvas-panel-resizer canvas-inspector-resizer"
            class:is-active={resizing?.panel === 'inspector'}
            role="separator"
            aria-label={m.canvas_resize_inspector({}, options)}
            aria-orientation="vertical"
            aria-valuemin={PANEL_WIDTHS.inspector.min}
            aria-valuemax={panelMaximum('inspector')}
            aria-valuenow={inspectorWidth}
            aria-valuetext={m.canvas_pixels({ count: inspectorWidth }, options)}
            tabindex="0"
            title={m.canvas_resize_hint({}, options)}
            onpointerdown={(event) => beginPanelResize('inspector', event)}
            onpointermove={continuePanelResize}
            onpointerup={finishPanelResize}
            onpointercancel={finishPanelResize}
            onkeydown={(event) => resizePanelWithKeyboard('inspector', event)}
            ondblclick={() => resetPanelWidth('inspector')}
          ></div>
        {/if}
        <div class="canvas-inspector-motion" transition:fly={{ x: 20, duration: 200, easing: cubicOut }}>
          {#if selected}
            <CanvasInspector
              selection={selected}
              selectionLabel={selectedNode?.label}
              context={breadcrumb}
              {mediaPickerRequest}
              blockInspection={blockInspectorFor(selected)}
              {entryDocument}
              {ownerLabel}
              {locale}
              {uiLocale}
              {sourceLocale}
              {session}
              {blocks}
              {blockLabels}
              problems={inspectorProblems}
              {mediaBase}
              {site}
              {servedAt}
              {locked}
              onschedule={(policy) => void schedule(policy)}
              onclose={() => (inspectorOpen = false)}
            />
          {:else}
            <aside class="canvas-inspector canvas-inspector-empty" id="canvas-inspector" aria-labelledby="canvas-inspector-heading">
              <header>
                <div class="canvas-inspector-title">
                  <span class="canvas-selection-icon"><CanvasIcon name="inspector" /></span>
                  <div>
                    <span class="canvas-inspector-kicker">{m.canvas_inspector({}, options)}</span>
                    <h2 id="canvas-inspector-heading">{m.canvas_nothing_selected({}, options)}</h2>
                  </div>
                </div>
                <button class="btn btn-ghost btn-sm" type="button" aria-label={m.canvas_close_inspector({}, options)} onclick={() => (inspectorOpen = false)}><CanvasIcon name="collapse-right" /></button>
              </header>
              <div class="canvas-inspector-empty-state">
                <span class="canvas-inspector-empty-mark" aria-hidden="true"><CanvasIcon name="block" /></span>
                <strong>{m.canvas_select_element({}, options)}</strong>
                <p>{m.canvas_select_element_hint({}, options)}</p>
              </div>
            </aside>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</section>
