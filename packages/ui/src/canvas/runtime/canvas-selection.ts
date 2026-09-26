import { messageOptions, type UiLocale } from '../../i18n';
import * as m from '../../paraglide/messages.js';
import type {
  CanvasBlockAction,
  CanvasSelection,
  CanvasStructureNode,
  CanvasTarget,
} from '../canvas-bridge';
import {
  canvasSelectionKey,
  editableTarget,
  historyDirection,
  sameCanvasDocument,
  sameCanvasSelection,
} from '../canvas-target';
import { createCanvasDragController, type DragAnnouncement } from './canvas-drag';
import {
  humanize,
  type InternalNode,
  MARKERS,
  publicNode,
  readStructure,
  SELECTOR,
} from './canvas-scan';
import type { CanvasUiLocaleState } from './canvas-ui-locale';

type Announcement = { kind: 'selected' | 'empty' | 'focus' } | DragAnnouncement;

export interface CanvasSelectionRuntimeOptions {
  entryDocument?: CanvasTarget['document'];
  adminBase?: string;
  root?: Document;
  owner?: Window;
  onSelection?: (selection: CanvasSelection) => void;
  onStructure?: (nodes: CanvasStructureNode[]) => void;
  /** The inline editor returns true only for a selected, schema-approved text field. */
  onActivate?: (
    selection: CanvasSelection,
    element: Element,
    intent?: { trigger?: Element; caret?: number; point?: { x: number; y: number } },
  ) => boolean;
  onAction?: (
    action: CanvasBlockAction,
    selection: CanvasSelection,
    destination?: CanvasSelection,
  ) => void;
  onInteraction?: (selection: CanvasSelection, state: { dragging: boolean }) => void;
  isEditing?: () => boolean;
  uiLocale?: CanvasUiLocaleState;
}

/** Read where the click landed from the layout the reader saw: `contenteditable` re-wraps the text. */
const caretOffsetAt = (root: Document, element: Element, x: number, y: number) => {
  const position = root.caretPositionFromPoint?.(x, y);
  const fallback = position ? undefined : root.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? fallback?.startContainer;
  const offset = position?.offset ?? fallback?.startOffset;
  if (!node || offset === undefined || !element.contains(node)) return undefined;
  const measure = root.createRange();
  measure.selectNodeContents(element);
  try {
    measure.setEnd(node, offset);
  } catch {
    return undefined;
  }
  return measure.toString().length;
};

// `slice` can cut an emoji's surrogate pair in half.
const trimUnits = (value: string, limit: number) => {
  if (value.length <= limit) return value;
  const clipped = value.slice(0, limit);
  const last = clipped.charCodeAt(limit - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
};

const ICONS = {
  add: 'M12 5v14M5 12h14',
  grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  'move-up': 'M12 19V5M5 12l7-7 7 7',
  'move-down': 'M12 5v14M5 12l7 7 7-7',
  duplicate:
    'M10 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2ZM16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3',
  delete: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  inspect: 'M4 5h16v14H4zM15 5v14M7 9h4M7 13h4',
};
function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

export function createCanvasSelectionRuntime(options: CanvasSelectionRuntimeOptions = {}) {
  const root = options.root ?? document;
  const owner = options.owner ?? window;
  let nodes: InternalNode[] = [];
  let selected: CanvasSelection | undefined;
  let selectedElement: Element | undefined;
  let cursor: InternalNode | undefined;
  let hoveredElement: Element | undefined;
  let allowedActions: CanvasBlockAction[] = [];
  let disposed = false;
  let enabled = true;
  let sharedOpen = false;
  let geometryFrame = 0;
  let rebuildFrame = 0;
  let problemAddresses: string[] = [];
  let nodeByKey = new Map<string, InternalNode>();
  let nodeById = new Map<string, InternalNode>();
  let nodesByElement = new WeakMap<Element, InternalNode[]>();
  let childrenByParent = new Map<string | undefined, InternalNode[]>();
  let lastAnnouncement: { node: InternalNode; state: Announcement } | undefined;
  let unsubscribeLocale: (() => void) | undefined;
  const visible = new WeakMap<Element, boolean>();
  const locale = (): UiLocale => options.uiLocale?.current() ?? 'en';
  const message = () => messageOptions(locale());

  const dragStyles = root.createElement('style');
  // Authored margins otherwise offset dnd-kit's fixed-position feedback from the pointer.
  dragStyles.textContent =
    ':root [data-handover-block][data-dnd-dragging]{margin:0!important;box-shadow:0 12px 36px rgb(23 32 21/.2)}';
  const host = root.createElement('div');
  host.dataset.handoverCanvasOverlay = '';
  host.lang = locale();
  host.style.cssText =
    'all:initial;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial}.layer{position:fixed;inset:0;pointer-events:none;font:12px/1.35 system-ui,sans-serif;color:#172015}
    .box{position:fixed;box-sizing:border-box;border:2px solid #c1ee67;border-radius:3px;pointer-events:none;box-shadow:0 0 0 1px rgb(17 24 9/.2),inset 0 0 0 1px rgb(17 24 9/.2)}
    .box.invalid{border-color:#d92d20;background:rgb(217 45 32/.06);box-shadow:0 0 0 1px #fff8}
    .box.hover{border-width:1px;background:rgb(193 238 103/.13);box-shadow:0 0 0 1px rgb(17 24 9/.18)}
    .path{position:fixed;display:flex;align-items:center;box-sizing:border-box;height:28px;pointer-events:auto;max-width:min(520px,calc(100vw - 8px));padding:0 6px;border:0;border-radius:4px 4px 0 0;background:#c1ee67;color:#23320f;font-weight:600;box-shadow:0 0 0 1px rgb(17 24 9/.2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .path:focus{outline:none}.path[hidden]{display:none}.path button{all:unset;box-sizing:border-box;display:block;min-width:28px;height:28px;padding:0 6px;cursor:pointer;flex-shrink:0;color:inherit;font:inherit}.path button:hover{background:rgb(17 24 9/.12)}.path button:focus-visible{outline:none;text-decoration:underline;text-underline-offset:3px}.path-current{padding:0 2px;overflow:hidden;text-overflow:ellipsis}.path-separator{padding:0 2px;opacity:.65;flex-shrink:0}
    .actions button{all:initial;position:fixed;box-sizing:border-box;min-width:28px;min-height:28px;padding:4px 8px;border:1px solid #e5e8e5;border-radius:5px;background:#fff;color:#202420;box-shadow:0 2px 6px rgb(23 26 33/.1);font:600 12px/1.35 system-ui,sans-serif;text-align:center;cursor:pointer;pointer-events:auto;touch-action:none}
    .actions button:hover{background:#eef5e4}.actions button:disabled{cursor:default;opacity:.45}.actions button:focus-visible{outline:2px solid #537e2c;outline-offset:2px}.actions .insert{border-radius:999px;padding:3px 8px}.actions .danger{color:#b42318}.actions .danger:hover{background:#fde8e8}.actions .drag{cursor:grab}.actions .drag.is-dragging{cursor:grabbing;background:#eef5e4}
    .action-row{position:fixed;display:flex;gap:3px;height:28px;pointer-events:auto}.actions .action-row button{position:static;width:28px;height:28px;min-width:28px;padding:5px;border:0;border-radius:5px;background:transparent;box-shadow:none;color:#465043;transition:background-color 120ms ease,color 120ms ease}.actions .action-row button:hover{background:rgb(55 75 35/.09);color:#172015}.actions .action-row .danger:hover{background:rgb(180 35 24/.08);color:#b42318}.actions .action-row .field-action{width:auto;padding-inline:8px;white-space:nowrap}
    .actions svg{display:block;width:16px;height:16px;margin:auto;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.actions .drag svg{stroke-width:2.6}
    .drop-preview{position:fixed;box-sizing:border-box;border:3px dashed #719c31;border-radius:8px;background:rgb(193 238 103/.18);box-shadow:inset 0 0 0 1px rgb(255 255 255/.6);pointer-events:none}.drop-preview[hidden]{display:none}
    .box.shared{border-style:dashed}.path.shared{background:#d9ccff;color:#261442}
    .shared-panel{position:fixed;box-sizing:border-box;width:min(340px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;padding:16px;border:1px solid #76628f;border-radius:10px;background:#fff;color:#202420;box-shadow:0 8px 28px #0003;pointer-events:auto;font:14px/1.5 system-ui,sans-serif}
    .shared-panel[hidden]{display:none}.shared-panel h2{margin:0 28px 8px 0;font-size:16px}.shared-panel p{margin:0 0 12px}.shared-panel a{display:inline-block;padding:8px 12px;border-radius:6px;background:#e8dfff;color:#261442;font-weight:600;text-decoration:none}.shared-panel button{position:absolute;right:8px;top:8px;border:0;background:transparent;font:20px system-ui;cursor:pointer}.shared-panel :is(a,button):focus-visible{outline:2px solid #261442;outline-offset:2px}
    .live{position:fixed;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
  </style><div class="layer"><div class="boxes"></div><div class="drop-preview" data-canvas-drop-preview hidden></div><div class="actions"></div><div class="path" hidden></div><div class="path hover-path" hidden></div><div class="shared-panel" role="dialog" hidden><button type="button">×</button><h2></h2><p></p><a target="_blank" rel="noopener noreferrer"></a></div><div class="live" role="status" aria-live="polite"></div></div>`;
  const boxes = shadow.querySelector<HTMLElement>('.boxes');
  const dropPreview = shadow.querySelector<HTMLElement>('.drop-preview');
  if (!dropPreview) throw new Error('Canvas drop preview could not be created.');
  const actions = shadow.querySelector<HTMLElement>('.actions');
  const path = shadow.querySelector<HTMLElement>('.path');
  const hoverPath = shadow.querySelector<HTMLElement>('.hover-path');
  const sharedPanel = shadow.querySelector<HTMLElement>('.shared-panel');
  if (!hoverPath || !sharedPanel) throw new Error('Canvas labels could not be created.');
  const sharedClose = sharedPanel.querySelector('button');
  const sharedHeading = sharedPanel.querySelector('h2');
  const sharedExplanation = sharedPanel.querySelector('p');
  const sharedLink = sharedPanel.querySelector('a');
  if (!sharedClose || !sharedHeading || !sharedExplanation || !sharedLink)
    throw new Error('Canvas shared panel could not be created.');
  sharedPanel.remove();
  const foreign = (node: CanvasSelection) =>
    Boolean(
      options.entryDocument && !sameCanvasDocument(node.target.document, options.entryDocument),
    );
  const closeShared = () => {
    sharedOpen = false;
    sharedPanel.hidden = true;
    sharedPanel.remove();
  };
  sharedClose.addEventListener('click', closeShared);
  const refreshShared = (node: InternalNode) => {
    const shared = node.target.document.collection === 'globals';
    const heading = shared
      ? m.canvas_type_shared({}, message())
      : m.canvas_type_entry({}, message());
    sharedPanel.setAttribute('aria-label', heading);
    sharedHeading.textContent = `${heading} · ${node.target.document.id}`;
    sharedExplanation.textContent = m.canvas_shared_explanation({}, message());
    sharedClose.setAttribute('aria-label', m.canvas_shared_close({}, message()));
    const link = sharedLink;
    link.textContent = m.canvas_shared_open({}, message());
    const doc = node.target.document;
    const route = shared
      ? `/site/${encodeURIComponent(doc.id)}`
      : `/c/${encodeURIComponent(doc.collection)}/${encodeURIComponent(doc.id)}`;
    link.href = `${options.adminBase ?? '/admin'}${route}?${new URLSearchParams({ field: node.target.address, locale: node.target.locale })}`;
  };
  const live = shadow.querySelector<HTMLElement>('.live');
  if (!boxes || !actions || !path || !live) throw new Error('Canvas overlay could not be created.');

  const selectable = (node: InternalNode) =>
    !node.container && (node.kind !== 'list' || node.empty === true);
  const nodeForSelection = (value: CanvasSelection | undefined) => {
    const node = value && nodeByKey.get(canvasSelectionKey(value));
    return node && selectable(node) ? node : undefined;
  };
  const selectableParent = (node: InternalNode): InternalNode | undefined => {
    const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
    return parent && !selectable(parent) ? selectableParent(parent) : parent;
  };
  const selectableChildren = (parentId?: string): InternalNode[] =>
    (childrenByParent.get(parentId) ?? []).flatMap((node) =>
      selectable(node) ? [node] : selectableChildren(node.id),
    );
  const nodeForElement = (element: Element | undefined) => {
    if (!element) return undefined;
    const candidates = (nodesByElement.get(element) ?? []).filter(selectable);
    return (
      candidates.find((node) => node.kind === 'field') ??
      candidates.find((node) => node.kind === 'list' && node.empty) ??
      candidates.find((node) => node.kind === 'block')
    );
  };
  const closestMarker = (value: EventTarget | null) =>
    value instanceof Element ? (value.closest(SELECTOR) ?? undefined) : undefined;
  const markerAtPointer = (event: MouseEvent) => {
    const direct = closestMarker(event.target);
    if (nodeForElement(direct)?.kind === 'field') return direct;

    // A full-bleed image is often stacked behind its block's copy and gradient. In that case the
    // browser targets the wrapper even though the annotated image is what the editor sees. Prefer
    // a field whose painted rectangle contains the pointer before falling back to that wrapper.
    const scope = direct ?? (event.target instanceof Element ? event.target : root.documentElement);
    const fields = Array.from(scope.querySelectorAll<HTMLElement>('[data-handover-field]'));
    return (
      fields.findLast((field) => {
        const bounds = field.getBoundingClientRect();
        return (
          bounds.width > 0 &&
          bounds.height > 0 &&
          event.clientX >= bounds.left &&
          event.clientX <= bounds.right &&
          event.clientY >= bounds.top &&
          event.clientY <= bounds.bottom
        );
      }) ?? direct
    );
  };
  const parents = (node: InternalNode) => {
    const result: InternalNode[] = [];
    let next: InternalNode | undefined = node;
    while (next) {
      result.unshift(next);
      next = next.parentId ? nodeById.get(next.parentId) : undefined;
    }
    return result;
  };
  const renderAnnouncement = (node: InternalNode, state: Announcement) => {
    const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
    const values = {
      label: node.label,
      position: node.position,
      count: node.setSize,
      parent: parent?.label ?? m.canvas_page({}, message()),
    };
    switch (state.kind) {
      case 'selected':
        return m.canvas_selection_announcement_selected(values, message());
      case 'empty':
        return m.canvas_selection_announcement_empty(values, message());
      case 'focus':
        return m.canvas_selection_announcement_focus(values, message());
      case 'dragging':
        return m.canvas_selection_announcement_dragging(values, message());
      case 'unchanged':
        return m.canvas_selection_announcement_unchanged(values, message());
      case 'canceled':
        return m.canvas_selection_announcement_canceled(values, message());
      case 'preview':
        return m.canvas_selection_announcement_preview({ ...values, ...state }, message());
      case 'moved':
        return m.canvas_selection_announcement_moved({ ...values, ...state }, message());
    }
  };
  const announce = (node: InternalNode, state: Announcement) => {
    lastAnnouncement = { node, state };
    live.textContent = renderAnnouncement(node, state);
  };
  const drag = createCanvasDragController({
    owner,
    canStart: () => enabled && !options.isEditing?.() && allowedActions.includes('move'),
    isEditing: () => !!options.isEditing?.(),
    onInteraction: options.onInteraction,
    onAction: options.onAction,
    announce,
    redraw: () => scheduleDraw(),
  });
  const draw = () => {
    geometryFrame = 0;
    if (disposed) return;
    const step = drag.step();
    if (step === 'restoring') {
      dropPreview.hidden = true;
      scheduleDraw();
      return;
    }
    if (step === 'finished') rebuild();
    else if (step) {
      dropPreview.hidden = !step.placeholder;
      if (step.placeholder) {
        const bounds = step.placeholder.getBoundingClientRect();
        Object.assign(dropPreview.style, {
          left: `${bounds.left}px`,
          top: `${bounds.top}px`,
          width: `${bounds.width}px`,
          height: `${bounds.height}px`,
        });
      }
      boxes.replaceChildren();
      path.hidden = true;
      hoverPath.hidden = true;
      actions.style.opacity = '0';
      scheduleDraw();
      return;
    }
    actions.style.opacity = '';
    dropPreview.hidden = true;
    const focused = shadow.activeElement instanceof HTMLElement ? shadow.activeElement : undefined;
    const focusedAncestor = focused?.dataset.canvasAncestor;
    const focusedLabel = focused?.closest('.path');
    const focusedAction = focused?.dataset.canvasAction;
    const restoreActionFocus = () => {
      const replacement = focusedAction
        ? actions.querySelector<HTMLElement>(`[data-canvas-action="${focusedAction}"]`)
        : undefined;
      replacement?.focus({ preventScroll: true });
      if (focusedAncestor && focusedLabel instanceof HTMLElement && !focusedLabel.hidden) {
        const ancestorButton = Array.from(
          focusedLabel.querySelectorAll<HTMLElement>('[data-canvas-ancestor]'),
        ).find((button) => button.dataset.canvasAncestor === focusedAncestor);
        (ancestorButton ?? focusedLabel).focus({ preventScroll: true });
      }
    };
    boxes.replaceChildren();
    actions.replaceChildren();
    hoverPath.hidden = true;
    sharedPanel.hidden = !sharedOpen || !enabled;
    if (!enabled) {
      drag.clear();
      path.hidden = true;
      restoreActionFocus();
      return;
    }
    const measured = new Map<Element, DOMRect>();
    const boundsOf = (element: Element) => {
      const found = measured.get(element);
      if (found) return found;
      const bounds = element.getBoundingClientRect();
      measured.set(element, bounds);
      return bounds;
    };
    path.style.maxWidth = '';
    const selectedNode = nodeForSelection(selected);
    const hoveredNode = nodeForElement(hoveredElement);
    const wantsSortables =
      selectedNode?.kind === 'block' && allowedActions.includes('move') && !options.isEditing?.();
    if (!wantsSortables) drag.clear();
    const makeBox = (element: Element, state: 'selected' | 'hover' | 'invalid') => {
      if (visible.get(element) === false) return;
      const bounds = boundsOf(element);
      if (
        bounds.width <= 0 ||
        bounds.height <= 0 ||
        bounds.bottom < 0 ||
        bounds.right < 0 ||
        bounds.top > owner.innerHeight ||
        bounds.left > owner.innerWidth
      )
        return;
      const box = root.createElement('div');
      const node = state === 'selected' ? selectedNode : hoveredNode;
      box.className = `box ${state}${node && foreign(node) ? ' shared' : ''}`;
      box.style.left = `${bounds.left}px`;
      box.style.top = `${bounds.top}px`;
      box.style.width = `${bounds.width}px`;
      box.style.height = `${bounds.height}px`;
      boxes.append(box);
    };
    if (selectedNode) for (const element of selectedNode.elements) makeBox(element, 'selected');
    // Highlight the closest rendered owner when an empty field has no annotation.
    const invalidNodes = new Set<InternalNode>();
    for (const address of problemAddresses) {
      const candidates = nodes.filter(
        (node) =>
          !foreign(node) &&
          (address === node.target.address ||
            address.startsWith(`${node.target.address}.`) ||
            address.startsWith(`${node.target.address}[`)),
      );
      candidates.sort((a, b) => b.target.address.length - a.target.address.length);
      if (candidates[0]) invalidNodes.add(candidates[0]);
    }
    for (const node of invalidNodes)
      for (const element of node.elements) makeBox(element, 'invalid');

    const breadcrumb = (label: HTMLElement, node: InternalNode, element: Element, details = '') => {
      label.replaceChildren();
      label.tabIndex = -1;
      const ancestors = parents(node).filter(
        (parent) => parent !== node && parent.kind === 'block' && selectable(parent),
      );
      for (const ancestor of ancestors) {
        const button = root.createElement('button');
        button.type = 'button';
        button.dataset.canvasAncestor = ancestor.id;
        button.textContent = ancestor.label;
        button.setAttribute(
          'aria-label',
          m.canvas_select_block({ label: ancestor.label }, message()),
        );
        button.title = m.canvas_select_block({ label: ancestor.label }, message());
        const selectAncestor = (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          const occurrence =
            ancestor.elements.find((candidate) => candidate.contains(element)) ??
            ancestor.elements[0];
          choose(ancestor, occurrence);
          label.focus({ preventScroll: true });
        };
        // Select before a blur-triggered redraw can replace the pressed button.
        button.addEventListener('pointerdown', selectAncestor);
        button.addEventListener('click', (event) => {
          if (event.detail === 0) selectAncestor(event);
        });
        const separator = root.createElement('span');
        separator.className = 'path-separator';
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = ' › ';
        label.append(button, separator);
      }
      const current = root.createElement('button');
      current.type = 'button';
      current.className = 'path-current';
      current.dataset.canvasAncestor = node.id;
      current.setAttribute('aria-label', m.canvas_select_target({ label: node.label }, message()));
      current.setAttribute('aria-pressed', String(sameCanvasSelection(node, selected)));
      const selectCurrent = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        choose(node, element);
        if (!foreign(node)) label.focus({ preventScroll: true });
      };
      current.addEventListener('pointerdown', selectCurrent);
      current.addEventListener('click', (event) => {
        if (event.detail === 0) selectCurrent(event);
      });
      current.textContent = `${foreign(node) ? `${m.canvas_type_shared({}, message())} · ` : ''}${node.label}${details}`;
      label.append(current);
    };
    const labelFor = (label: HTMLElement, node: InternalNode, element: Element) => {
      const bounds = boundsOf(element);
      label.hidden = bounds.bottom < 0 || bounds.top > owner.innerHeight;
      label.classList.toggle('shared', foreign(node));
      breadcrumb(label, node, element);
      label.style.left = `${Math.max(4, Math.min(bounds.left, owner.innerWidth - label.offsetWidth - 4))}px`;
      label.style.top = `${Math.max(4, bounds.top - 28)}px`;
    };
    if (hoveredNode && (!selectedNode || !sameCanvasSelection(hoveredNode, selectedNode))) {
      const element = hoveredElement ?? hoveredNode.elements[0];
      if (element) {
        makeBox(element, 'hover');
        // Without a selection the breadcrumb is hidden; skip building and measuring it.
        if (selectedNode) labelFor(hoverPath, hoveredNode, element);
      }
    }
    const labelled = selectedNode ?? hoveredNode;
    const anchor = selectedElement ?? hoveredElement ?? labelled?.elements[0];
    if (!labelled || !anchor) {
      path.hidden = true;
      restoreActionFocus();
      return;
    }
    const bounds = boundsOf(anchor);
    path.hidden = bounds.bottom < 0 || bounds.top > owner.innerHeight;
    path.classList.toggle('shared', foreign(labelled));
    if (!selectedNode) hoverPath.hidden = true;
    const occurrence =
      labelled.occurrences > 1
        ? m.canvas_selection_occurrences({ count: labelled.occurrences }, message())
        : '';
    const pathDetails = [
      labelled.empty ? m.canvas_selection_empty_list({}, message()) : '',
      occurrence,
    ].filter(Boolean);
    path.title = `${m.canvas_selection_path(
      {
        path: parents(labelled)
          .map((node) => node.label)
          .join(' / '),
      },
      message(),
    )}${pathDetails.length ? ` · ${pathDetails.join(' · ')}` : ''}`;
    const labelDetails = [labelled.empty ? m.canvas_empty({}, message()) : '', occurrence].filter(
      Boolean,
    );
    breadcrumb(path, labelled, anchor, labelDetails.length ? ` · ${labelDetails.join(' · ')}` : '');
    path.style.left = `${Math.max(4, Math.min(bounds.left, owner.innerWidth - path.offsetWidth - 4))}px`;
    path.style.top = `${Math.max(4, bounds.top - 28)}px`;
    if (!hoverPath.hidden && !path.hidden) {
      const selectedLabel = path.getBoundingClientRect();
      const hoverLabel = hoverPath.getBoundingClientRect();
      if (
        hoverLabel.left < selectedLabel.right &&
        hoverLabel.right > selectedLabel.left &&
        hoverLabel.top < selectedLabel.bottom &&
        hoverLabel.bottom > selectedLabel.top
      )
        hoverPath.style.top = `${selectedLabel.bottom + 2}px`;
    }
    if (!selectedNode || !selectedElement) {
      restoreActionFocus();
      return;
    }
    const selectedBounds = boundsOf(selectedElement);
    if (sharedOpen) {
      sharedPanel.style.left = `${Math.max(8, Math.min(selectedBounds.left, owner.innerWidth - sharedPanel.offsetWidth - 8))}px`;
      sharedPanel.style.top = `${Math.max(8, Math.min(selectedBounds.bottom + 8, owner.innerHeight - sharedPanel.offsetHeight - 8))}px`;
    }
    if (selectedBounds.bottom < 0 || selectedBounds.top > owner.innerHeight) {
      restoreActionFocus();
      return;
    }
    const addAction = (
      action: CanvasBlockAction,
      label: string,
      left: number,
      top: number,
      className = '',
      text?: string,
    ) => {
      const button = root.createElement('button');
      button.type = 'button';
      button.className = className;
      button.dataset.canvasAction = action;
      button.setAttribute('aria-label', label);
      button.title = label;
      const glyph = action.startsWith('insert')
        ? ICONS.add
        : action === 'move'
          ? ICONS.grip
          : action in ICONS
            ? ICONS[action as keyof typeof ICONS]
            : '';
      if (text === undefined && glyph) button.append(icon(glyph));
      else button.textContent = text ?? label;
      button.style.left = `${Math.max(4, left)}px`;
      button.style.top = `${Math.max(4, top)}px`;
      const fire = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        closeShared();
        options.onAction?.(action, { kind: selectedNode.kind, target: selectedNode.target });
        scheduleDraw();
      };
      if (action === 'inspect') {
        // Pressing this blurs the editable, and the redraw that follows replaces the button before
        // the click lands. Commit on pointerdown; `detail === 0` is the keyboard's own activation.
        button.addEventListener('pointerdown', fire);
        button.addEventListener('click', (event) => {
          if (event.detail === 0) fire(event);
        });
      } else if (action !== 'move') button.addEventListener('click', fire);
      actions.append(button);
      return button;
    };
    let actionRow: HTMLDivElement | undefined;
    const addRowAction = (
      action: CanvasBlockAction,
      label: string,
      className = '',
      text?: string,
    ) => {
      if (!actionRow) {
        actionRow = root.createElement('div');
        actionRow.className = 'action-row';
        actions.append(actionRow);
      }
      const button = addAction(action, label, 0, 0, className, text);
      actionRow.append(button);
      return button;
    };
    const placeActionRow = () => {
      if (!actionRow) return;
      const right = Math.min(selectedBounds.right, owner.innerWidth - 4);
      const left = Math.max(4, right - actionRow.offsetWidth);
      let top = Math.max(4, selectedBounds.top - 28);
      const labelLeft = Number.parseFloat(path.style.left);
      const available = left - labelLeft - 8;
      if (available >= 80) path.style.maxWidth = `${Math.min(520, available)}px`;
      else {
        path.style.top = `${Math.max(4, top - 28)}px`;
        top = Math.max(top, Number.parseFloat(path.style.top) + 28);
      }
      actionRow.style.left = `${left}px`;
      actionRow.style.top = `${top}px`;
    };
    if (selectedNode.kind === 'field' && allowedActions.includes('inspect'))
      addRowAction(
        'inspect',
        m.canvas_selection_inspect({ label: selectedNode.label }, message()),
        'inspect',
      );
    if (options.isEditing?.()) {
      placeActionRow();
      restoreActionFocus();
      return;
    }
    if (selectedNode.kind === 'block') {
      if (allowedActions.includes('insert-before'))
        addAction(
          'insert-before',
          m.canvas_selection_insert_before({ label: selectedNode.label }, message()),
          selectedBounds.left + selectedBounds.width / 2 - 14,
          selectedBounds.top - 14,
          'insert',
        );
      if (allowedActions.includes('insert-after'))
        addAction(
          'insert-after',
          m.canvas_selection_insert_after({ label: selectedNode.label }, message()),
          selectedBounds.left + selectedBounds.width / 2 - 14,
          selectedBounds.bottom - 14,
          'insert',
        );
      const candidates: Array<{
        action: CanvasBlockAction;
        label: string;
        className?: string;
      }> = [
        {
          action: 'move',
          label: m.canvas_selection_drag({ label: selectedNode.label }, message()),
          className: 'drag',
        },
        {
          action: 'move-up',
          label: m.canvas_selection_move_up({ label: selectedNode.label }, message()),
        },
        {
          action: 'move-down',
          label: m.canvas_selection_move_down({ label: selectedNode.label }, message()),
        },
        {
          action: 'duplicate',
          label: m.canvas_selection_duplicate({ label: selectedNode.label }, message()),
        },
        {
          action: 'delete',
          label: m.canvas_selection_delete({ label: selectedNode.label }, message()),
          className: 'danger',
        },
      ];
      for (const { action, label, className } of candidates) {
        if (!allowedActions.includes(action)) continue;
        const button = addRowAction(action, label, className);
        if (action === 'move')
          drag.sync(
            selectedNode,
            (childrenByParent.get(selectedNode.parentId) ?? []).filter(
              (candidate) => candidate.kind === 'block',
            ),
            button,
          );
      }
    } else if (selectedNode.kind === 'field' && allowedActions.includes('replace-media')) {
      addRowAction(
        'replace-media',
        m.canvas_selection_replace({ label: selectedNode.label }, message()),
        'field-action',
        m.canvas_selection_replace_image({}, message()),
      );
    } else if (
      selectedNode.kind === 'list' &&
      selectedNode.empty &&
      allowedActions.includes('insert-empty')
    ) {
      addAction(
        'insert-empty',
        m.canvas_selection_add_block_to({ label: selectedNode.label }, message()),
        selectedBounds.left + selectedBounds.width / 2 - 14,
        selectedBounds.top + selectedBounds.height / 2 - 14,
        'insert',
      );
    }
    placeActionRow();
    restoreActionFocus();
  };
  const scheduleDraw = () => {
    if (!geometryFrame) geometryFrame = owner.requestAnimationFrame(draw);
  };
  const publishStructure = () => options.onStructure?.(nodes.map(publicNode));
  const labelNodes = () => {
    for (const node of nodes) {
      const label =
        node.kind === 'block'
          ? node.named || m.canvas_selection_block_position({ position: node.position }, message())
          : humanize(node.target.address) ||
            (node.kind === 'list'
              ? m.canvas_type_array({}, message())
              : m.canvas_selection_field({}, message()));
      node.label = trimUnits(label, 200);
    }
  };
  const observerRealm = owner as unknown as typeof globalThis;
  const resizeObserver = new observerRealm.ResizeObserver(scheduleDraw);
  const intersectionObserver = new observerRealm.IntersectionObserver((entries) => {
    for (const entry of entries) visible.set(entry.target, entry.isIntersecting);
    scheduleDraw();
  });
  const indexNodes = () => {
    nodeByKey = new Map(nodes.map((node) => [canvasSelectionKey(node), node]));
    nodeById = new Map(nodes.map((node) => [node.id, node]));
    nodesByElement = new WeakMap();
    childrenByParent = new Map();
    resizeObserver.disconnect();
    intersectionObserver.disconnect();
    resizeObserver.observe(root.documentElement);
    for (const node of nodes) {
      const siblings = childrenByParent.get(node.parentId) ?? [];
      siblings.push(node);
      childrenByParent.set(node.parentId, siblings);
      for (const element of node.elements) {
        const candidates = nodesByElement.get(element) ?? [];
        candidates.push(node);
        nodesByElement.set(element, candidates);
        resizeObserver.observe(element);
        intersectionObserver.observe(element);
      }
    }
  };
  const rebuild = () => {
    rebuildFrame = 0;
    if (disposed || !drag.idle()) return;
    nodes = readStructure(root);
    indexNodes();
    if (lastAnnouncement) {
      const currentAnnouncementNode = nodeForSelection(lastAnnouncement.node);
      if (currentAnnouncementNode) lastAnnouncement.node = currentAnnouncementNode;
    }
    cursor = nodeForSelection(cursor);
    const chosen = nodeForSelection(selected);
    if (selected && !chosen) {
      closeShared();
      selected = undefined;
      selectedElement = undefined;
    } else if (chosen) {
      selected = { kind: chosen.kind, target: chosen.target };
      selectedElement = chosen.elements[0];
    }
    labelNodes();
    publishStructure();
    scheduleDraw();
  };
  const scheduleRebuild = () => {
    if (drag.active() || !drag.idle()) return;
    if (!rebuildFrame) rebuildFrame = owner.requestAnimationFrame(rebuild);
  };
  const choose = (
    value: CanvasSelection,
    element?: Element,
    settings: { publish?: boolean; scroll?: boolean } = {},
  ) => {
    const node = nodeForSelection(value);
    if (!node) return false;
    if (!sameCanvasSelection(selected, value)) {
      allowedActions = [];
    }
    sharedOpen = foreign(node);
    sharedPanel.hidden = !sharedOpen;
    if (sharedOpen) {
      shadow.append(sharedPanel);
      refreshShared(node);
      sharedLink.focus({ preventScroll: true });
    }
    selected = { kind: node.kind, target: node.target };
    selectedElement = element && node.elements.includes(element) ? element : node.elements[0];
    cursor = node;
    if (settings.scroll) selectedElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (settings.publish !== false) options.onSelection?.(selected);
    announce(node, { kind: node.empty ? 'empty' : 'selected' });
    scheduleDraw();
    return true;
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!enabled || event.composedPath().includes(host)) return;
    if (drag.active()) return;
    const element = markerAtPointer(event);
    if (element === hoveredElement) return;
    hoveredElement = element;
    cursor = nodeForElement(element);
    scheduleDraw();
  };
  const onPointerOut = (event: PointerEvent) => {
    if (!enabled) return;
    if (drag.active()) return;
    if (event.relatedTarget) return;
    hoveredElement = undefined;
    cursor = undefined;
    scheduleDraw();
  };
  const onClick = (event: MouseEvent) => {
    if (!enabled || drag.active() || event.composedPath().includes(host)) return;
    if (
      options.isEditing?.() &&
      event.target instanceof Node &&
      selectedElement?.contains(event.target)
    ) {
      if (event.target instanceof Element && event.target.closest('a, button'))
        event.preventDefault();
      return;
    }
    const element = markerAtPointer(event);
    const node = nodeForElement(element);
    if (!node || !element) {
      closeShared();
      scheduleDraw();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const caret =
      node.kind === 'field'
        ? caretOffsetAt(root, element, event.clientX, event.clientY)
        : undefined;
    choose(node, element);
    if (foreign(node) || node.kind !== 'field') return;
    const control = event.target instanceof Element ? event.target.closest('a, button') : undefined;
    options.onActivate?.({ kind: node.kind, target: node.target }, element, {
      ...(control && element.contains(control) ? { trigger: control } : {}),
      ...(caret === undefined ? {} : { caret }),
      point: { x: event.clientX, y: event.clientY },
    });
  };
  const onDoubleClick = (event: MouseEvent) => {
    // Once the first click has opened the editor, a double click is the reader's word select.
    if (!enabled || options.isEditing?.()) return;
    const element = closestMarker(event.target);
    const node = nodeForElement(element);
    if (!node || !element || node.kind !== 'field' || foreign(node)) return;
    const caret = caretOffsetAt(root, element, event.clientX, event.clientY);
    if (!sameCanvasSelection(node, selected)) choose(node, element);
    if (
      !options.onActivate?.({ kind: node.kind, target: node.target }, element, {
        ...(caret === undefined ? {} : { caret }),
        point: { x: event.clientX, y: event.clientY },
      })
    )
      return;
    event.preventDefault();
    event.stopPropagation();
  };
  const moveCursor = (event: KeyboardEvent) => {
    if (!enabled) return;
    if (event.key === 'Escape' && sharedOpen) {
      event.preventDefault();
      closeShared();
      return;
    }
    if (
      event.composedPath().includes(sharedPanel) ||
      event
        .composedPath()
        .some((node) => node instanceof HTMLElement && node.hasAttribute('data-canvas-ancestor'))
    )
      return;
    if (editableTarget(event.target)) return;
    const action = historyDirection(event);
    if (action && selected && allowedActions.includes(action)) {
      event.preventDefault();
      options.onAction?.(action, selected);
      return;
    }
    if (event.key === 'Escape' && drag.active()) {
      event.preventDefault();
      drag.cancel();
      return;
    }
    if (drag.active()) return;
    if (
      event.altKey &&
      selected?.kind === 'block' &&
      !options.isEditing?.() &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      const action = event.key === 'ArrowUp' ? 'move-up' : 'move-down';
      if (!allowedActions.includes(action)) return;
      event.preventDefault();
      options.onAction?.(action, selected);
      return;
    }
    if (
      event.key === 'Enter' &&
      (event.ctrlKey || event.metaKey) &&
      selected?.kind === 'block' &&
      allowedActions.includes('insert-after') &&
      !options.isEditing?.()
    ) {
      event.preventDefault();
      options.onAction?.('insert-after', selected);
      return;
    }
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    if (!vertical && !horizontal) {
      if (event.key === 'Enter' && cursor) {
        event.preventDefault();
        const activationElement = selectedElement ?? cursor.elements[0];
        if (
          !foreign(cursor) &&
          cursor.kind === 'field' &&
          sameCanvasSelection(cursor, selected) &&
          activationElement &&
          options.onActivate?.({ kind: cursor.kind, target: cursor.target }, activationElement)
        )
          return;
        choose(cursor, cursor.elements[0], { scroll: true });
      }
      return;
    }
    const current = cursor ?? nodeForSelection(selected) ?? nodes.find(selectable);
    if (!current) return;
    let next: InternalNode | undefined;
    const backwards = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (event.shiftKey) {
      next = backwards ? selectableParent(current) : selectableChildren(current.id)[0];
    } else {
      const siblings = selectableChildren(selectableParent(current)?.id);
      const index = siblings.indexOf(current);
      next = siblings[Math.max(0, Math.min(siblings.length - 1, index + (backwards ? -1 : 1)))];
    }
    if (!next) return;
    event.preventDefault();
    cursor = next;
    hoveredElement = next.elements[0];
    hoveredElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    announce(next, { kind: 'focus' });
    scheduleDraw();
  };

  const observer = new MutationObserver(scheduleRebuild);
  return {
    start() {
      if (disposed || host.isConnected) return;
      root.documentElement.append(dragStyles, host);
      rebuild();
      root.addEventListener('pointermove', onPointerMove, true);
      root.addEventListener('pointerout', onPointerOut, true);
      root.addEventListener('click', onClick, true);
      root.addEventListener('dblclick', onDoubleClick, true);
      root.addEventListener('keydown', moveCursor, true);
      root.addEventListener('scroll', scheduleDraw, true);
      owner.addEventListener('resize', scheduleDraw);
      observer.observe(root.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [...MARKERS.map(([attribute]) => attribute), 'data-handover-container'],
      });
      let observedLocale = locale();
      unsubscribeLocale = options.uiLocale?.subscribe((nextLocale) => {
        if (disposed) return;
        host.lang = nextLocale;
        if (nextLocale === observedLocale) return;
        observedLocale = nextLocale;
        labelNodes();
        const sharedNode = nodeForSelection(selected);
        if (sharedOpen && sharedNode) refreshShared(sharedNode);
        publishStructure();
        if (lastAnnouncement)
          live.textContent = renderAnnouncement(lastAnnouncement.node, lastAnnouncement.state);
        scheduleDraw();
      });
    },
    select(value: CanvasSelection, settings: { scroll?: boolean } = {}) {
      return choose(value, undefined, { publish: false, scroll: settings.scroll });
    },
    actions(value: CanvasSelection, values: CanvasBlockAction[]) {
      if (!sameCanvasSelection(selected, value)) return false;
      allowedActions = [...values];
      scheduleDraw();
      return true;
    },
    problems(addresses: string[]) {
      problemAddresses = [...addresses];
      scheduleDraw();
    },
    setEnabled(next: boolean) {
      if (enabled === next) return;
      if (!next && drag.active()) drag.cancel();
      if (!next) closeShared();
      enabled = next;
      hoveredElement = undefined;
      cursor = next ? nodeForSelection(selected) : undefined;
      scheduleDraw();
    },
    structure: () => nodes.map(publicNode),
    selection: () => selected,
    dispose() {
      if (disposed) return;
      drag.dispose();
      disposed = true;
      observer.disconnect();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      unsubscribeLocale?.();
      root.removeEventListener('pointermove', onPointerMove, true);
      root.removeEventListener('pointerout', onPointerOut, true);
      root.removeEventListener('click', onClick, true);
      root.removeEventListener('dblclick', onDoubleClick, true);
      root.removeEventListener('keydown', moveCursor, true);
      root.removeEventListener('scroll', scheduleDraw, true);
      owner.removeEventListener('resize', scheduleDraw);
      if (geometryFrame) owner.cancelAnimationFrame(geometryFrame);
      if (rebuildFrame) owner.cancelAnimationFrame(rebuildFrame);
      host.remove();
      dragStyles.remove();
    },
  };
}
