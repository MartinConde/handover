import {
  type CanvasAnnotationKind,
  type CanvasBlockAction,
  type CanvasSelection,
  type CanvasStructureNode,
  type CanvasTarget,
  isCanvasTarget,
} from '../canvas-bridge';
import {
  canvasSelectionKey,
  sameCanvasDocument,
  sameCanvasSelection,
} from '../canvas-target';

const MARKERS = [
  ['data-handover-field', 'field'],
  ['data-handover-list', 'list'],
  ['data-handover-block', 'block'],
] as const satisfies readonly (readonly [string, CanvasAnnotationKind])[];
const SELECTOR = MARKERS.map(([attribute]) => `[${attribute}]`).join(',');

interface StructuralLocation {
  document: { collection: string; id: string };
  locale: string;
  address: string;
}

interface InternalNode extends CanvasStructureNode {
  elements: Element[];
  structural: StructuralLocation;
  /** The block's own name from the template, before position is used as a fallback. */
  named: string;
}

export interface CanvasSelectionRuntimeOptions {
  root?: Document;
  owner?: Window;
  onSelection?: (selection: CanvasSelection) => void;
  onStructure?: (nodes: CanvasStructureNode[]) => void;
  /** The inline editor returns true only for a selected, schema-approved text field. */
  onActivate?: (selection: CanvasSelection, element: Element, trigger?: Element) => boolean;
  onAction?: (
    action: CanvasBlockAction,
    selection: CanvasSelection,
    destination?: CanvasSelection,
  ) => void;
  onInteraction?: (selection: CanvasSelection, state: { dragging: boolean }) => void;
  isEditing?: () => boolean;
}

const structuralLocation = (target: CanvasTarget): StructuralLocation => {
  const rendered = target.occurrence;
  return {
    document: rendered?.document ?? target.document,
    locale: rendered?.locale ?? target.locale,
    address:
      rendered && target.address
        ? `${rendered.address}.${target.address}`
        : (rendered?.address ?? target.address),
  };
};

const isAncestor = (parent: StructuralLocation, child: StructuralLocation) => {
  if (
    !sameCanvasDocument(parent.document, child.document) ||
    parent.locale !== child.locale ||
    !parent.address ||
    child.address.length <= parent.address.length ||
    !child.address.startsWith(parent.address)
  )
    return false;
  const boundary = child.address[parent.address.length];
  return boundary === '.' || boundary === '[';
};

const humanize = (value: string) => {
  const clean = value
    .replace(/\[_id=[^\]]+\]/g, '')
    .split('.')
    .at(-1)
    ?.replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : '';
};

const publicNode = ({
  elements: _elements,
  structural: _structural,
  named: _named,
  ...node
}: InternalNode) => node;

const parseMarker = (element: Element, attribute: string): CanvasTarget | undefined => {
  try {
    const value = JSON.parse(element.getAttribute(attribute) ?? '') as unknown;
    return isCanvasTarget(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

function readStructure(root: Document): InternalNode[] {
  const grouped = new Map<string, InternalNode>();
  for (const element of Array.from(root.querySelectorAll(SELECTOR))) {
    for (const [attribute, kind] of MARKERS) {
      if (!element.hasAttribute(attribute)) continue;
      const target = parseMarker(element, attribute);
      if (!target) continue;
      const key = canvasSelectionKey({ kind, target });
      const prior = grouped.get(key);
      if (prior) {
        prior.elements.push(element);
        prior.occurrences += 1;
        continue;
      }
      grouped.set(key, {
        id: `target-${grouped.size + 1}`,
        kind,
        target,
        label: '',
        depth: 1,
        position: 1,
        setSize: 1,
        occurrences: 1,
        elements: [element],
        structural: structuralLocation(target),
        named: element.getAttribute('data-handover-name')?.trim() || '',
      });
    }
  }
  const nodes = [...grouped.values()];
  for (const node of nodes) {
    let parent: InternalNode | undefined;
    for (const candidate of nodes) {
      if (
        candidate !== node &&
        isAncestor(candidate.structural, node.structural) &&
        (!parent || candidate.structural.address.length > parent.structural.address.length)
      )
        parent = candidate;
    }
    if (parent) node.parentId = parent.id;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = (node: InternalNode, seen = new Set<string>()): number => {
    if (!node.parentId || seen.has(node.id)) return 1;
    const parent = byId.get(node.parentId);
    if (!parent) return 1;
    seen.add(node.id);
    return Math.min(100, depth(parent, seen) + 1);
  };
  for (const node of nodes) node.depth = depth(node);
  for (const node of nodes) {
    const siblings = nodes.filter((candidate) => candidate.parentId === node.parentId);
    node.position = siblings.indexOf(node) + 1;
    node.setSize = siblings.length;
    node.label =
      node.kind === 'block'
        ? node.named || `Block ${node.position}`
        : humanize(node.target.address) || (node.kind === 'list' ? 'List' : 'Field');
    if (node.kind === 'list') {
      const hasBlock = nodes.some(
        (candidate) =>
          candidate.kind === 'block' && isAncestor(node.structural, candidate.structural),
      );
      if (!hasBlock) node.empty = true;
    }
  }
  // Depth-first: one element may carry both a block and the list inside it, and the list is
  // discovered first, so marker order would put a child above its own parent.
  const children = new Map<string | undefined, InternalNode[]>();
  for (const node of nodes) {
    const group = children.get(node.parentId) ?? [];
    group.push(node);
    children.set(node.parentId, group);
  }
  const ordered: InternalNode[] = [];
  const walk = (parentId: string | undefined) => {
    for (const node of children.get(parentId) ?? []) {
      ordered.push(node);
      walk(node.id);
    }
  };
  walk(undefined);
  return ordered;
}

const eligibleKey = (event: KeyboardEvent) => {
  const target = event.target;
  return !(
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
};

export function createCanvasSelectionRuntime(options: CanvasSelectionRuntimeOptions = {}) {
  const root = options.root ?? document;
  const owner = options.owner ?? window;
  let nodes: InternalNode[] = [];
  let selected: CanvasSelection | undefined;
  let selectedElement: Element | undefined;
  let cursor: InternalNode | undefined;
  let hoveredElement: Element | undefined;
  let allowedActions: CanvasBlockAction[] = [];
  let dragging:
    | {
        node: InternalNode;
        siblings: InternalNode[];
        from: number;
        to: number;
        pointerId: number;
      }
    | undefined;
  let disposed = false;
  let enabled = true;
  let actionsOpen = false;
  let geometryFrame = 0;
  let rebuildFrame = 0;
  let dragPoint: number | undefined;
  let nodeByKey = new Map<string, InternalNode>();
  let nodeById = new Map<string, InternalNode>();
  let nodesByElement = new WeakMap<Element, InternalNode[]>();
  let childrenByParent = new Map<string | undefined, InternalNode[]>();
  const visible = new WeakMap<Element, boolean>();

  const host = root.createElement('div');
  host.dataset.handoverCanvasOverlay = '';
  host.style.cssText =
    'all:initial;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial}.layer{position:fixed;inset:0;pointer-events:none;font:12px/1.35 system-ui,sans-serif;color:#172015}
    .box{position:fixed;box-sizing:border-box;border:1px solid #537e2c;border-radius:0;pointer-events:none}
    .box.hover{border-width:1px;border-color:#89938b}.box.selected{border-style:solid}
    .path{position:fixed;max-width:min(520px,calc(100vw - 8px));padding:3px 7px;border:1px solid #537e2c;border-radius:4px 4px 0 0;background:#537e2c;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .actions button{all:initial;position:fixed;box-sizing:border-box;min-width:28px;min-height:28px;padding:4px 8px;border:1px solid #e5e8e5;border-radius:5px;background:#fff;color:#202420;box-shadow:0 2px 6px rgb(23 26 33/.1);font:600 12px/1.35 system-ui,sans-serif;text-align:center;cursor:pointer;pointer-events:auto;touch-action:none}
    .actions button:hover{background:#eef5e4}.actions button:disabled{cursor:default;opacity:.45}.actions button:focus-visible{outline:2px solid #537e2c;outline-offset:2px}.actions .insert{border-radius:999px;padding:3px 8px}.actions .danger{color:#b42318}.actions .danger:hover{background:#fde8e8}.actions .drag{cursor:grab}.actions .drag.is-dragging{cursor:grabbing;background:#eef5e4}
    .actions .menu-item{width:156px;text-align:left;border-radius:0;box-shadow:none;border-block-width:0;padding:7px 12px;min-height:32px}.actions .menu-item:first-of-type{border-radius:6px 6px 0 0}.actions .menu-item:last-child{border-bottom-width:1px;border-radius:0 0 6px 6px}
    .drop-slot{position:fixed;height:4px;border-radius:999px;background:#537e2c;box-shadow:0 0 0 2px #fff;pointer-events:none}
    .live{position:fixed;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
  </style><div class="layer"><div class="boxes"></div><div class="actions"></div><div class="drop-slot" hidden></div><div class="path" hidden></div><div class="live" role="status" aria-live="polite"></div></div>`;
  const boxes = shadow.querySelector<HTMLElement>('.boxes');
  const actions = shadow.querySelector<HTMLElement>('.actions');
  const path = shadow.querySelector<HTMLElement>('.path');
  const dropSlot = shadow.querySelector<HTMLElement>('.drop-slot');
  const live = shadow.querySelector<HTMLElement>('.live');
  if (!boxes || !actions || !path || !dropSlot || !live)
    throw new Error('Canvas overlay could not be created.');

  const nodeForSelection = (value: CanvasSelection | undefined) =>
    value && nodeByKey.get(canvasSelectionKey(value));
  const nodeForElement = (element: Element | undefined) => {
    if (!element) return undefined;
    const candidates = nodesByElement.get(element) ?? [];
    return (
      candidates.find((node) => node.kind === 'field') ??
      candidates.find((node) => node.kind === 'list' && node.empty) ??
      candidates.find((node) => node.kind === 'block') ??
      candidates.find((node) => node.kind === 'list')
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
  const announce = (node: InternalNode, suffix = '') => {
    const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
    live.textContent = `${node.label}, ${node.position} of ${node.setSize} in ${parent?.label ?? 'Page'}${suffix}`;
  };
  const finishDrag = (commit: boolean) => {
    const held = dragging;
    if (!held) return;
    dragging = undefined;
    const selection = { kind: held.node.kind, target: held.node.target } as CanvasSelection;
    options.onInteraction?.(selection, { dragging: false });
    if (commit && held.to !== held.from) {
      const destination = held.siblings[held.to];
      if (destination)
        options.onAction?.('move', selection, {
          kind: destination.kind,
          target: destination.target,
        });
      announce(held.node, `. Moved to position ${held.to + 1} of ${held.siblings.length}.`);
    } else {
      announce(held.node, commit ? '. Position unchanged.' : '. Move canceled.');
    }
    scheduleDraw();
  };
  function startDrag(event: Event) {
    const pointer = event as PointerEvent;
    const node = nodeForSelection(selected);
    if (
      node?.kind !== 'block' ||
      !allowedActions.includes('move') ||
      options.isEditing?.() ||
      (pointer.button !== undefined && pointer.button !== 0)
    )
      return;
    const siblings = (childrenByParent.get(node.parentId) ?? []).filter(
      (candidate) => candidate.kind === 'block',
    );
    const from = siblings.indexOf(node);
    if (from < 0 || siblings.length < 2) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = {
      node,
      siblings,
      from,
      to: from,
      pointerId: pointer.pointerId ?? 0,
    };
    dragPoint = undefined;
    options.onInteraction?.({ kind: node.kind, target: node.target }, { dragging: true });
    announce(node, '. Dragging within this list; release to move or press Escape to cancel.');
    scheduleDraw();
  }
  const projectDrag = (event: PointerEvent) => {
    if (!dragging || (event.pointerId ?? 0) !== dragging.pointerId) return false;
    event.preventDefault();
    dragPoint = event.clientY;
    scheduleDraw();
    return true;
  };
  const projectDragAt = (point: number, boundsOf: (element: Element) => DOMRect) => {
    if (!dragging) return;
    let nearest = dragging.to;
    let distance = Number.POSITIVE_INFINITY;
    dragging.siblings.forEach((node, index) => {
      const element = node.elements[0];
      if (!element) return;
      const bounds = boundsOf(element);
      const nextDistance = Math.abs(point - (bounds.top + bounds.height / 2));
      if (nextDistance < distance) {
        distance = nextDistance;
        nearest = index;
      }
    });
    if (nearest !== dragging.to) {
      dragging.to = nearest;
      announce(
        dragging.node,
        `. Move preview: position ${nearest + 1} of ${dragging.siblings.length}.`,
      );
    }
  };
  const draw = () => {
    geometryFrame = 0;
    if (disposed) return;
    boxes.replaceChildren();
    actions.replaceChildren();
    dropSlot.hidden = true;
    if (!enabled) {
      path.hidden = true;
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
    if (dragging && dragPoint !== undefined) {
      projectDragAt(dragPoint, boundsOf);
      dragPoint = undefined;
    }
    const selectedNode = nodeForSelection(selected);
    const hoveredNode = nodeForElement(hoveredElement);
    const makeBox = (element: Element, state: 'selected' | 'hover') => {
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
      box.className = `box ${state}`;
      box.style.left = `${bounds.left}px`;
      box.style.top = `${bounds.top}px`;
      box.style.width = `${bounds.width}px`;
      box.style.height = `${bounds.height}px`;
      boxes.append(box);
    };
    if (selectedNode) for (const element of selectedNode.elements) makeBox(element, 'selected');
    const editing = options.isEditing?.() ?? false;
    if (
      !editing &&
      hoveredNode &&
      (!selectedNode || !sameCanvasSelection(hoveredNode, selectedNode)) &&
      !hoveredElement?.contains(selectedElement ?? null)
    ) {
      const element = hoveredElement ?? hoveredNode.elements[0];
      if (element) makeBox(element, 'hover');
    }
    const labelled = selectedNode ?? hoveredNode;
    const anchor = selectedElement ?? hoveredElement ?? labelled?.elements[0];
    if (!labelled || !anchor) {
      path.hidden = true;
      return;
    }
    const bounds = boundsOf(anchor);
    path.hidden = editing || bounds.bottom < 0 || bounds.top > owner.innerHeight;
    path.title = `Page / ${parents(labelled)
      .map((node) => node.label)
      .join(
        ' / ',
      )}${labelled.empty ? ' · Empty list' : ''}${labelled.occurrences > 1 ? ` · ${labelled.occurrences} occurrences` : ''}`;
    path.textContent = `${labelled.label}${labelled.empty ? ' · Empty' : ''}${labelled.occurrences > 1 ? ` · ${labelled.occurrences} occurrences` : ''}`;
    path.style.left = `${Math.max(4, Math.min(bounds.left, owner.innerWidth - path.offsetWidth - 4))}px`;
    path.style.top = `${Math.max(4, bounds.top - 28)}px`;
    if (!selectedNode || !selectedElement || options.isEditing?.()) return;
    const selectedBounds = boundsOf(selectedElement);
    if (selectedBounds.bottom < 0 || selectedBounds.top > owner.innerHeight) return;
    const addAction = (
      action: CanvasBlockAction,
      label: string,
      left: number,
      top: number,
      className = '',
      text = action.startsWith('insert') ? '+' : label,
    ) => {
      const button = root.createElement('button');
      button.type = 'button';
      button.className = className;
      button.setAttribute('aria-label', label);
      button.textContent = text;
      button.style.left = `${Math.max(4, left)}px`;
      button.style.top = `${Math.max(4, top)}px`;
      if (action === 'move') button.addEventListener('pointerdown', startDrag);
      else
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          actionsOpen = false;
          options.onAction?.(action, { kind: selectedNode.kind, target: selectedNode.target });
          scheduleDraw();
        });
      actions.append(button);
      return button;
    };
    if (selectedNode.kind === 'block') {
      if (allowedActions.includes('insert-before'))
        addAction(
          'insert-before',
          `Insert before ${selectedNode.label}`,
          selectedBounds.left + selectedBounds.width / 2 - 14,
          selectedBounds.top - 14,
          'insert',
        );
      if (allowedActions.includes('insert-after'))
        addAction(
          'insert-after',
          `Insert after ${selectedNode.label}`,
          selectedBounds.left + selectedBounds.width / 2 - 14,
          selectedBounds.bottom - 14,
          'insert',
        );
      const candidates: Array<{
        action: CanvasBlockAction;
        label: string;
        text: string;
        className?: string;
      }> = [
        { action: 'replace', label: `Replace ${selectedNode.label}`, text: 'Replace block' },
        { action: 'move-up', label: `Move ${selectedNode.label} up`, text: '↑' },
        { action: 'move-down', label: `Move ${selectedNode.label} down`, text: '↓' },
        { action: 'duplicate', label: `Duplicate ${selectedNode.label}`, text: '⧉' },
        {
          action: 'delete',
          label: `Delete ${selectedNode.label}`,
          text: '×',
          className: 'danger',
        },
      ];
      const compact = candidates.filter(({ action }) => allowedActions.includes(action));
      const corner = Math.max(4, Math.min(selectedBounds.right - 34, owner.innerWidth - 38));
      const top = Math.max(4, selectedBounds.top + 8);
      if (allowedActions.includes('move')) {
        const drag = addAction('move', `Drag ${selectedNode.label}`, corner - 34, top, 'drag', '↕');
        if (dragging) drag.classList.add('is-dragging');
      }
      if (compact.length) {
        const toggle = root.createElement('button');
        toggle.type = 'button';
        toggle.textContent = '⋯';
        toggle.setAttribute('aria-label', `Actions for ${selectedNode.label}`);
        toggle.setAttribute('aria-expanded', String(actionsOpen));
        toggle.style.left = `${corner}px`;
        toggle.style.top = `${top}px`;
        toggle.addEventListener('pointerdown', (event) => event.preventDefault());
        toggle.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          actionsOpen = !actionsOpen;
          draw();
          (
            actions.querySelector<HTMLElement>('.menu-item') ??
            actions.querySelector<HTMLElement>('[aria-expanded]')
          )?.focus({ preventScroll: true });
        });
        actions.append(toggle);
      }
      if (actionsOpen) {
        const menuTop = Math.max(
          4,
          Math.min(top + 34, owner.innerHeight - compact.length * 32 - 8),
        );
        compact.forEach(({ action, label, className }, index) => {
          addAction(
            action,
            label,
            Math.max(4, corner - 128),
            menuTop + index * 32,
            `menu-item ${className ?? ''}`,
            action === 'replace'
              ? 'Replace block'
              : action === 'duplicate'
                ? 'Duplicate'
                : action === 'delete'
                  ? 'Delete block'
                  : action === 'move-up'
                    ? 'Move up'
                    : 'Move down',
          );
        });
      }
    } else if (selectedNode.kind === 'field' && allowedActions.includes('replace-media')) {
      addAction(
        'replace-media',
        `Replace ${selectedNode.label}`,
        Math.min(selectedBounds.right - 112, owner.innerWidth - 116),
        selectedBounds.top + 8,
        'field-action',
        'Replace image',
      );
    } else if (
      selectedNode.kind === 'list' &&
      selectedNode.empty &&
      allowedActions.includes('insert-empty')
    ) {
      addAction(
        'insert-empty',
        `Add block to ${selectedNode.label}`,
        selectedBounds.left + selectedBounds.width / 2 - 14,
        selectedBounds.top + selectedBounds.height / 2 - 14,
        'insert',
      );
    }
    if (dragging) {
      const destination = dragging.siblings[dragging.to];
      const element = destination?.elements[0];
      if (element) {
        const destinationBounds = boundsOf(element);
        const after = dragging.to > dragging.from;
        dropSlot.hidden = false;
        dropSlot.style.left = `${Math.max(4, destinationBounds.left)}px`;
        dropSlot.style.top = `${Math.max(4, after ? destinationBounds.bottom - 2 : destinationBounds.top - 2)}px`;
        dropSlot.style.width = `${Math.max(24, destinationBounds.width)}px`;
      }
    }
  };
  const scheduleDraw = () => {
    if (!geometryFrame) geometryFrame = owner.requestAnimationFrame(draw);
  };
  const publishStructure = () => options.onStructure?.(nodes.map(publicNode));
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
    if (disposed) return;
    nodes = readStructure(root);
    indexNodes();
    cursor = nodeForSelection(cursor);
    const chosen = nodeForSelection(selected);
    if (selected && !chosen) {
      selected = undefined;
      selectedElement = undefined;
    } else if (chosen) {
      selected = { kind: chosen.kind, target: chosen.target };
      selectedElement = chosen.elements[0];
    }
    publishStructure();
    scheduleDraw();
  };
  const scheduleRebuild = () => {
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
      actionsOpen = false;
    }
    selected = { kind: node.kind, target: node.target };
    selectedElement = element && node.elements.includes(element) ? element : node.elements[0];
    cursor = node;
    if (settings.scroll) selectedElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (settings.publish !== false) options.onSelection?.(selected);
    announce(node, node.empty ? ', empty list.' : ', selected.');
    scheduleDraw();
    return true;
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!enabled || actionsOpen || event.composedPath().includes(host)) return;
    if (projectDrag(event)) return;
    const element = markerAtPointer(event);
    if (element === hoveredElement) return;
    hoveredElement = element;
    cursor = nodeForElement(element);
    scheduleDraw();
  };
  const onPointerOut = (event: PointerEvent) => {
    if (!enabled) return;
    if (dragging) return;
    if (event.relatedTarget) return;
    hoveredElement = undefined;
    cursor = undefined;
    scheduleDraw();
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!enabled) return;
    if (!dragging || (event.pointerId ?? 0) !== dragging.pointerId) return;
    projectDragAt(event.clientY, (element) => element.getBoundingClientRect());
    finishDrag(true);
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (!enabled) return;
    if (!dragging || (event.pointerId ?? 0) !== dragging.pointerId) return;
    finishDrag(false);
  };
  const onClick = (event: MouseEvent) => {
    if (!enabled || event.composedPath().includes(host)) return;
    if (
      options.isEditing?.() &&
      event.target instanceof Node &&
      selectedElement?.contains(event.target)
    ) {
      if (event.target instanceof Element && event.target.closest('a, button'))
        event.preventDefault();
      return;
    }
    actionsOpen = false;
    const element = markerAtPointer(event);
    const node = nodeForElement(element);
    if (!node || !element) {
      scheduleDraw();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    choose(node, element);
    const control = event.target instanceof Element ? event.target.closest('a, button') : undefined;
    if (
      node.kind === 'field' &&
      control &&
      element.contains(control) &&
      options.onActivate?.({ kind: node.kind, target: node.target }, element, control)
    )
      event.stopImmediatePropagation();
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (!enabled) return;
    const element = closestMarker(event.target);
    const node = nodeForElement(element);
    if (!node || !element || node.kind !== 'field') return;
    if (!sameCanvasSelection(node, selected)) choose(node, element);
    if (!options.onActivate?.({ kind: node.kind, target: node.target }, element)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const moveCursor = (event: KeyboardEvent) => {
    if (!enabled) return;
    if (event.key === 'Escape' && actionsOpen) {
      event.preventDefault();
      actionsOpen = false;
      draw();
      actions.querySelector<HTMLElement>('[aria-expanded]')?.focus({ preventScroll: true });
      return;
    }
    if (!eligibleKey(event)) return;
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      const action =
        key === 'z' && event.shiftKey
          ? 'redo'
          : key === 'z'
            ? 'undo'
            : key === 'y'
              ? 'redo'
              : undefined;
      if (action && selected && allowedActions.includes(action)) {
        event.preventDefault();
        options.onAction?.(action, selected);
        return;
      }
    }
    if (event.key === 'Escape' && dragging) {
      event.preventDefault();
      finishDrag(false);
      return;
    }
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
    const current = cursor ?? nodeForSelection(selected) ?? nodes[0];
    if (!current) return;
    let next: InternalNode | undefined;
    const backwards = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (event.shiftKey) {
      next = backwards
        ? current.parentId
          ? nodeById.get(current.parentId)
          : undefined
        : childrenByParent.get(current.id)?.[0];
    } else {
      const siblings = childrenByParent.get(current.parentId) ?? [];
      const index = siblings.indexOf(current);
      next = siblings[Math.max(0, Math.min(siblings.length - 1, index + (backwards ? -1 : 1)))];
    }
    if (!next) return;
    event.preventDefault();
    cursor = next;
    hoveredElement = next.elements[0];
    hoveredElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    announce(next, '. Press Enter to select.');
    scheduleDraw();
  };

  const observer = new MutationObserver(scheduleRebuild);
  return {
    start() {
      if (disposed || host.isConnected) return;
      root.documentElement.append(host);
      rebuild();
      root.addEventListener('pointermove', onPointerMove, true);
      root.addEventListener('pointerup', onPointerUp, true);
      root.addEventListener('pointercancel', onPointerCancel, true);
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
        attributeFilter: MARKERS.map(([attribute]) => attribute),
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
    setEnabled(next: boolean) {
      if (enabled === next) return;
      if (!next && dragging) finishDrag(false);
      enabled = next;
      actionsOpen = false;
      hoveredElement = undefined;
      cursor = next ? nodeForSelection(selected) : undefined;
      scheduleDraw();
    },
    structure: () => nodes.map(publicNode),
    selection: () => selected,
    dispose() {
      if (disposed) return;
      if (dragging) finishDrag(false);
      disposed = true;
      observer.disconnect();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      root.removeEventListener('pointermove', onPointerMove, true);
      root.removeEventListener('pointerup', onPointerUp, true);
      root.removeEventListener('pointercancel', onPointerCancel, true);
      root.removeEventListener('pointerout', onPointerOut, true);
      root.removeEventListener('click', onClick, true);
      root.removeEventListener('dblclick', onDoubleClick, true);
      root.removeEventListener('keydown', moveCursor, true);
      root.removeEventListener('scroll', scheduleDraw, true);
      owner.removeEventListener('resize', scheduleDraw);
      if (geometryFrame) owner.cancelAnimationFrame(geometryFrame);
      if (rebuildFrame) owner.cancelAnimationFrame(rebuildFrame);
      host.remove();
    },
  };
}
