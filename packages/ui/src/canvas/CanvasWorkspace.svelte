<script lang="ts">
import { onMount, type Snippet, tick, untrack } from 'svelte';
import { cubicOut } from 'svelte/easing';
import { fly } from 'svelte/transition';
import { EMPTY_ENTRY_DIRECTORY, readEntryDirectory } from '../entry-directory';
import { messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { previewPath } from '../request';
import CanvasBlockEditor from './CanvasBlockEditor.svelte';
import CanvasIcon from './CanvasIcon.svelte';
import CanvasImagePopover from './CanvasImagePopover.svelte';
import CanvasInspector from './CanvasInspector.svelte';
import type {
  CanvasActionMessage,
  CanvasAnchor,
  CanvasBlockAction,
  CanvasEditingState,
  CanvasInteractionMode,
  CanvasNavigationMessage,
  CanvasSelection,
  CanvasStructureNode,
} from './canvas-bridge';
import {
  createCanvasCommands,
  read,
  resolveStagedBlockIndex,
  type StagedBlockTarget,
} from './canvas-commands.svelte';
import type {
  CanvasRendererState,
  CanvasRenderRequest,
  createCanvasRenderer,
} from './canvas-renderer';
import { buildStructureIndex, structuralName } from './canvas-structure';
import { sameCanvasSelection } from './canvas-target';
import {
  type CanvasNavigationDestination,
  classifyCanvasNavigation,
} from './runtime/canvas-navigation';
import StructureTree from './StructureTree.svelte';

type Renderer = ReturnType<typeof createCanvasRenderer>;
type Width = 'desktop' | 'tablet' | 'phone';
type ResizablePanel = 'structure' | 'inspector';

const PANEL_WIDTHS = {
  structure: { default: 250, min: 210, max: 420 },
  inspector: { default: 380, min: 320, max: 640 },
} as const;
const PANEL_WIDTH_STORAGE = 'handover.canvas.panel-widths';
const MIN_CANVAS_WIDTH = 360;
const treeDomId = $props.id();

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
let rendererState = $state.raw<CanvasRendererState>({ phase: 'idle' });
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
let imagePopover = $state.raw<{ selection: CanvasSelection; anchor: CanvasAnchor }>();
const canvasFrame = $derived.by(() => {
  loading;
  rendererState.phase;
  return renderer?.activeFrame();
});
$effect(() => {
  if (
    !active ||
    interactionMode !== 'edit' ||
    inspectorOpen ||
    (imagePopover &&
      (imagePopover.selection.target.locale !== locale ||
        !sameCanvasSelection(imagePopover.selection, selected)))
  )
    imagePopover = undefined;
});
// Split is for looking at the page: editing in it, and the panels that go with it, are Canvas's.
$effect(() => {
  const next = fullscreen ? 'edit' : 'interact';
  untrack(() => setInteractionMode(next));
});
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
const inspectorProblems = $derived({ ...incomplete, ...problems });
const issueTargets = $derived(
  issues.map(([path, message]) => {
    const address = session.addressForPath(locale, path);
    const inspected = address ? session.inspectField(locale, address) : undefined;
    return { path, message, address: inspected?.ok ? inspected.target.address : address };
  }),
);
let reviewingProblems = $state(false);
function reviewProblem(issue = issueTargets[0]) {
  // A Live-preview review has no second Inspector to open; hand off to Form instead.
  if (!fullscreen || !issue?.address) {
    onreviewproblems();
    return;
  }
  reviewingProblems = true;
  setInteractionMode('edit');
  const next: CanvasSelection = {
    kind: 'field',
    target: { document: entryDocument, locale, address: issue.address },
  };
  selectionChanged(next);
  inspectorOpen = true;
  blockEditor = undefined;
  // Empty fields may not be rendered; scroll to their nearest annotated owner.
  const node = structure
    .filter(
      (node) =>
        sameDocument(node.target) &&
        (node.target.address === issue.address ||
          issue.address?.startsWith(`${node.target.address}.`) ||
          issue.address?.startsWith(`${node.target.address}[`)),
    )
    .sort((a, b) => b.target.address.length - a.target.address.length)[0];
  void tick().then(() => {
    if (node) renderer?.select(node);
    const inspector = workspace?.querySelector('.canvas-inspector');
    const control =
      inspector?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      inspector?.querySelector<HTMLElement>('input, textarea, select, button');
    control?.focus({ preventScroll: true });
  });
}
let structure = $state.raw<CanvasStructureNode[]>([]);
let selected = $state<CanvasSelection>();
let loading = $state(true);
let rendererImportFailed = $state(false);
let importingRenderer = false;
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
$effect(() => {
  if (!inspectorOpen) mediaPickerRequest = 0;
});
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
    : rendererImportFailed
      ? m.canvas_update_failed({}, options)
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
  if (rendererImportFailed) return m.canvas_renderer_load_failed({}, options);
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
const structureIndex = $derived(buildStructureIndex(structure));
function treeLabel(node: CanvasStructureNode) {
  if (!node.parentId && node.kind === 'list' && structuralName(node) === 'blocks')
    return m.canvas_page({}, options);
  if (
    structuralName(structureIndex.parentOf(node) ?? node) === 'columns' &&
    node.label === m.canvas_selection_block_position({ position: node.position }, options)
  )
    return m.canvas_column({ number: node.position }, options);
  return node.label;
}
const actionNode = $derived.by(() => {
  let node = selectedNode;
  while (node && node.kind !== 'block') node = structureIndex.parentOf(node);
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
    if (
      !structureIndex.hiddenWrappers.has(node.id) &&
      treeLabel(node) !== m.canvas_page({}, options)
    )
      result.unshift(treeLabel(node));
    node = structureIndex.parentOf(node);
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
  if (node.container || (node.kind === 'list' && !node.empty)) return;
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

function selectionChanged(next: CanvasSelection | undefined) {
  if (interactionMode !== 'edit') return;
  // Selection updates the Inspector's content without changing its visibility.
  selected = next;
  void tick().then(() => {
    renderer?.textField(textField(next));
    if (next) renderer?.actions(next, blockActionsFor(next));
  });
}

const commands = createCanvasCommands({
  session: () => session,
  entryDocument: () => entryDocument,
  locale: () => locale,
  sourceLocale: () => sourceLocale,
  locked: () => locked,
  active: () => active,
  interactionMode: () => interactionMode,
  blocks: () => blocks,
});
const {
  sameDocument,
  blockLocation,
  blockInspectorFor,
  blockEditorFor,
  blockActionsFor,
  textField,
  canvasCommand,
} = commands;

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

function canvasAction(
  message: Pick<CanvasActionMessage, 'action' | 'destination' | 'selection' | 'anchor'>,
) {
  if (interactionMode !== 'edit') return;
  if (message.action === 'edit-media') {
    if (
      message.selection.kind !== 'field' ||
      !message.anchor ||
      !sameDocument(message.selection.target) ||
      message.selection.target.locale !== locale
    )
      return;
    const inspected = session.inspectField(locale, message.selection.target.address);
    if (!inspected.ok || inspected.target.field.type !== 'image') return;
    selected = message.selection;
    blockEditor = undefined;
    inspectorOpen = false;
    imagePopover = { selection: message.selection, anchor: message.anchor };
    return;
  }
  if (message.action === 'inspect') {
    const close = inspectorOpen && sameCanvasSelection(selected, message.selection);
    selected = message.selection;
    blockEditor = undefined;
    inspectorOpen = !close;
    return;
  }
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
    // The page already shows the dragged order; redraw it from the session.
    void submit('render', true);
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
    if (message.action === 'move') void submit('render', true);
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
    renderer?.textField(textField(selected));
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
  if (navigationBusy || !fullscreen) return;
  navigationBusy = true;
  navigationError = undefined;
  navigationAction = undefined;
  if (message.kind === 'form') {
    navigationError = message.method === 'post' ? 'form-post' : 'form-get';
    navigationBusy = false;
    return;
  }
  let index = EMPTY_ENTRY_DIRECTORY;
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

// Keyed on a string so an unrelated keystroke doesn't re-post the same problems.
const problemAddressesKey = $derived(
  issueTargets.flatMap((issue) => (issue.address ? [issue.address] : [])).join('\u0000'),
);
$effect(() => {
  const addresses = problemAddressesKey ? problemAddressesKey.split('\u0000') : [];
  loading;
  rendererState.phase;
  untrack(() => renderer?.problems(addresses));
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

const fitWorkspace = () => {
  if (!workspace || !active) return;
  const bounds = workspace.getBoundingClientRect();
  narrow = bounds.width < 1000;
  workspace.style.setProperty(
    '--canvas-height',
    `${Math.max(420, window.innerHeight - Math.max(0, bounds.top))}px`,
  );
};

function bootstrapRenderer() {
  if (importingRenderer || disposed) return;
  importingRenderer = true;
  loading = true;
  rendererImportFailed = false;
  rendererState = { phase: 'idle' };
  void import('./canvas-renderer')
    .then(({ createCanvasRenderer }) => {
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
          if (reason === 'stale-version')
            setTimeout(() => renderer?.textField(textField(selected)), 0);
        },
        onStateChange: (next) => (rendererState = next),
      });
      loading = false;
      if (active) void submit('render');
    })
    .catch((error: unknown) => {
      if (disposed) return;
      loading = false;
      rendererImportFailed = true;
      rendererState = {
        phase: 'failed',
        requestId: crypto.randomUUID(),
        contentVersion: currentVersion(),
        reason: 'bootstrap',
        ...(error instanceof Error ? { message: error.message } : {}),
      };
    })
    .finally(() => {
      importingRenderer = false;
    });
}

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
  const resize = new ResizeObserver(fitWorkspace);
  if (workspace) resize.observe(workspace);
  const header = workspace?.closest('.main-editor')?.querySelector('.entry-header');
  if (header) resize.observe(header);
  fitWorkspace();
  bootstrapRenderer();
  return () => {
    resize.disconnect();
    disposed = true;
    renderer?.dispose();
  };
});
</script>

{#snippet inspectorFields(floating = false)}
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
      {floating}
      onclose={() => { inspectorOpen = false; imagePopover = undefined; if (floating) canvasFrame?.focus({ preventScroll: true }); }}
    />
  {/if}
{/snippet}

<svelte:window onresize={fitWorkspace} onkeydown={historyShortcut} />

<section
  bind:this={workspace}
  class={[
    'canvas-workspace',
    {
      'is-fullscreen': fullscreen,
      'is-inactive': !active,
      'is-mobile-hidden': mobileHidden,
    },
  ]}
  aria-label={m.canvas_label({}, options)}
  aria-hidden={!active}
  inert={!active}
  data-selected-address={selected?.target.occurrence?.address ?? selected?.target.address}
>
  <div class="canvas-rail">
    {#if fullscreen}
      <button class="btn btn-ghost canvas-back" type="button" aria-label={m.canvas_back_to_form({}, options)} title={m.canvas_back_to_form({}, options)} onclick={onform}><CanvasIcon name="back" /></button>
      <div class="canvas-identity"><strong title={ownerLabel}>{ownerLabel}</strong><span>{m.canvas_label({}, options)}</span></div>
    {:else}
      <span class="canvas-address" title={url}>{url}</span>
    {/if}
    {#if fullscreen}
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
    {/if}
    <div class="canvas-view-tools">
      <div class="seg canvas-widths" role="group" aria-label={m.canvas_viewport({}, options)}>
        {#each widths as item (item.value)}
          <button type="button" aria-label={item.label} title={item.label} aria-pressed={width === item.value} onclick={() => (width = item.value)}><CanvasIcon name={item.value} /></button>
        {/each}
      </div>
      {#if fullscreen}
        <div class="seg" role="group" aria-label={m.canvas_interaction({}, options)}>
          <button type="button" aria-pressed={interactionMode === 'edit'} onclick={() => setInteractionMode('edit')}>{m.canvas_edit({}, options)}</button>
          <button type="button" aria-pressed={interactionMode === 'interact'} onclick={() => setInteractionMode('interact')}>{m.canvas_interact({}, options)}</button>
        </div>
      {/if}
    </div>
    <div class="canvas-entry-actions">
      {#if fullscreen}{@render entryActions?.()}{/if}
      <a class="btn btn-sm canvas-preview" href={previewPath(url || '/')} target="_blank" rel="noreferrer"
        onclick={(event) => { event.preventDefault(); void openCurrentPreview(); }}>{m.preview_title({}, options)} <CanvasIcon name="external" /></a>
      {#if fullscreen}{@render publishAction?.()}{/if}
    </div>
    <span class={['visually-hidden canvas-render-state', { 'is-busy': loading || rendererState.phase === 'rendering', 'is-failed': rendererState.phase === 'failed' }]} role="status">{status}</span>
  </div>
  {#if actionRefusal}<div class="canvas-action-refusal" role="alert">{actionRefusalText}</div>{/if}

  {#if issues.length}
    <div class={['canvas-validation', { 'is-incomplete': incompletePaths.length > 0 }]} role="status">
      <div>
        {#if incompletePaths.length}
          <span>{m.canvas_complete_required({}, options)}</span>
        {:else}
          <strong>{m.canvas_fields_need_attention({ count: issues.length }, options)}</strong>
          <span>{issues[0]?.[1]}{issues.length > 1 ? ` · ${m.canvas_more_issues({ count: issues.length - 1 }, options)}` : ''}. {m.canvas_review_to_update({}, options)}</span>
        {/if}
      </div>
      <button class="btn btn-sm" type="button" onclick={() => reviewProblem()}>{m.canvas_review_fields({}, options)}</button>
    </div>
  {/if}

  {#if reviewingProblems && issues.length}
    <div class="canvas-validation-issues" role="group" aria-label={m.canvas_review_fields({}, options)}>
      {#each issueTargets as issue (issue.path)}
        <button class="btn btn-sm" type="button" onclick={() => reviewProblem(issue)}>{issue.message}</button>
      {/each}
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

  {#if failure && (!incompletePaths.length || rendererImportFailed)}
    <div class="canvas-failure" role="alert">
      <div>
        <strong>{m.canvas_could_not_update({}, options)}</strong>
        <span>{failureText}</span>
        {#if failure.message}<small>{failure.message}</small>{/if}
      </div>
      <button class="btn btn-sm" type="button" onclick={onform}>{m.canvas_go_to_form({}, options)}</button>
      {#if !rendererImportFailed}
        <button class="btn btn-sm" type="button" onclick={retry}>{m.common_retry({}, options)}</button>
      {/if}
    </div>
  {/if}

  {#if imagePopover && selected}
    <CanvasImagePopover
      anchor={imagePopover.anchor}
      frame={canvasFrame}
      label={selectedNode?.label ?? m.canvas_type_image({}, options)}
      onclose={() => (imagePopover = undefined)}
    >
      {@render inspectorFields(true)}
    </CanvasImagePopover>
  {/if}

  <div
    class={[
      'canvas-workarea',
      { 'has-structure': structureVisible, 'has-inspector': inspectorOpen, 'is-resizing': !!resizing },
    ]}
    style={`--canvas-structure-width:${structureWidth}px;--canvas-inspector-width:${inspectorWidth}px`}
  >
    <div class={['canvas-panel-slot canvas-structure-slot', { 'is-open': structureVisible }]} aria-hidden={!structureVisible} inert={!structureVisible}>
      <aside class={['canvas-structure', { 'is-block-editor': !!blockEditor }]} id="canvas-structure" aria-labelledby="canvas-structure-title">
        <StructureTree
          {treeDomId}
          {structure}
          {selected}
          {selectedNode}
          index={structureIndex}
          {treeLabel}
          {session}
          {locale}
          {uiLocale}
          {interactionMode}
          {insertionNode}
          {blockLocation}
          {blockActionsFor}
          onselectnode={selectNode}
          onaction={canvasAction}
          oninsert={(action, node) => openBlockEditor(action, node)}
          onclose={() => (structureOpen = false)}
          bind:addBlockButton
        />
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
          class={['canvas-panel-resizer canvas-structure-resizer', { 'is-active': resizing?.panel === 'structure' }]}
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
    <div class={['canvas-panel-slot canvas-inspector-slot', { 'is-open': inspectorOpen }]} aria-hidden={!inspectorOpen} inert={!inspectorOpen}>
      {#if inspectorOpen}
        {#if !narrow}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- ARIA's adjustable separator pattern is keyboard interactive. -->
          <div
            class={['canvas-panel-resizer canvas-inspector-resizer', { 'is-active': resizing?.panel === 'inspector' }]}
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
            {@render inspectorFields()}
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
