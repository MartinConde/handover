import { defaultCollisionDetection } from '@dnd-kit/collision';
import { Accessibility, DragDropManager, type Draggable } from '@dnd-kit/dom';
import { isSortable, Sortable } from '@dnd-kit/dom/sortable';
import type { CanvasBlockAction, CanvasSelection } from '../canvas-bridge';
import type { InternalNode } from './canvas-scan';

export type DragAnnouncement =
  | { kind: 'dragging' | 'unchanged' | 'canceled' }
  | { kind: 'preview' | 'moved'; destinationPosition: number; destinationCount: number };

// Every sibling's collision detector asks in the same pass; look the animation up once per pass.
export function createReorderAnimationLookup(getSource: () => Draggable | null) {
  let cached: { source: Draggable | null; animation: Animation | undefined } | undefined;
  return () => {
    const source = getSource();
    if (cached && cached.source === source) return cached.animation;
    const animation =
      isSortable(source) &&
      source.sortable.element?.getAnimations().find((animation) => {
        const effect = animation.effect as KeyframeEffect | null;
        return (
          animation.playState === 'running' &&
          !('animationName' in animation) &&
          !('transitionProperty' in animation) &&
          effect?.getTiming().duration === source.sortable.transition?.duration &&
          effect?.getTiming().iterations === 1 &&
          effect?.getKeyframes?.().some((frame) => frame.translate !== undefined)
        );
      });
    cached = { source, animation: animation || undefined };
    queueMicrotask(() => {
      if (cached?.source === source) cached = undefined;
    });
    return cached.animation;
  };
}

// Keep the viewport and surrounding page fixed while the current block list zooms out.
function createCanvasDragOverview(owner: Window, element: HTMLElement) {
  const wrapper = element.parentElement;
  if (
    !wrapper ||
    wrapper === element.ownerDocument.body ||
    wrapper === element.ownerDocument.documentElement
  )
    return;
  const properties = ['scale', 'transform-origin'] as const;
  const original = properties.map((name) => ({
    name,
    value: wrapper.style.getPropertyValue(name),
    priority: wrapper.style.getPropertyPriority(name),
  }));
  const height = owner.innerHeight;
  const bounds = wrapper.getBoundingClientRect();
  const pageTop = bounds.top + owner.scrollY;
  const scroll = { x: owner.scrollX, y: owner.scrollY };
  const duration = owner.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240;
  let scale = 1;
  let animation = 0;
  let restoring = false;
  let restored = false;
  wrapper.style.setProperty('transform-origin', `50% ${Math.max(0, -bounds.top)}px`, 'important');

  const cleanup = () => {
    owner.cancelAnimationFrame(animation);
    for (const { name, value, priority } of original) {
      if (value) wrapper.style.setProperty(name, value, priority);
      else wrapper.style.removeProperty(name);
    }
    element.style.removeProperty('--dnd-scale');
    restored = true;
  };
  const animate = (to: number, scrollTo?: number) => {
    owner.cancelAnimationFrame(animation);
    const from = scale;
    const startScroll = owner.scrollY;
    let start: number | undefined;
    const tick = (time: number) => {
      if (start === undefined) {
        start = time;
        // Let the drag preview measure the full-size block before an instant overview scales it.
        if (!duration && !restoring) {
          animation = owner.requestAnimationFrame(tick);
          return;
        }
      }
      const progress = duration ? Math.min(1, (time - start) / duration) : 1;
      const eased = 1 - (1 - progress) ** 3;
      scale = from + (to - from) * eased;
      wrapper.style.setProperty('scale', String(scale), 'important');
      // dnd-kit's top-layer preview escapes its parent's scale; scale it about the grab point.
      if (element.hasAttribute('data-dnd-dragging'))
        element.style.setProperty('--dnd-scale', String(scale));
      if (scrollTo !== undefined)
        owner.scrollTo({
          left: scroll.x,
          top: startScroll + (scrollTo - startScroll) * eased,
          behavior: 'instant',
        });
      if (progress < 1) animation = owner.requestAnimationFrame(tick);
      else if (restoring) cleanup();
    };
    animation = owner.requestAnimationFrame(tick);
  };
  animate(0.65);
  return {
    get restored() {
      return restored;
    },
    restore(canceled: boolean) {
      if (restoring || restored) return;
      restoring = true;
      const bounds = element.getBoundingClientRect();
      const top = Math.max(16, Math.min(bounds.top, height - 80));
      const unscaledTop = pageTop + (bounds.top - wrapper.getBoundingClientRect().top) / scale;
      animate(1, canceled ? scroll.y : Math.max(0, unscaledTop - top));
    },
    dispose() {
      cleanup();
      owner.scrollTo({ left: scroll.x, top: scroll.y, behavior: 'instant' });
    },
  };
}

interface CanvasDragOptions {
  owner: Window;
  canStart: () => boolean;
  isEditing: () => boolean;
  onInteraction?: (selection: CanvasSelection, state: { dragging: boolean }) => void;
  onAction?: (
    action: CanvasBlockAction,
    selection: CanvasSelection,
    destination?: CanvasSelection,
  ) => void;
  announce: (node: InternalNode, state: DragAnnouncement) => void;
  redraw: () => void;
}

/** Reorders sibling blocks with dnd-kit; the selection overlay only draws what this reports. */
export function createCanvasDragController(options: CanvasDragOptions) {
  const { owner } = options;
  let dragging:
    | {
        node: InternalNode;
        siblings: InternalNode[];
        from: number;
        to: number;
        ending?: { commit: boolean };
        overview?: ReturnType<typeof createCanvasDragOverview>;
      }
    | undefined;
  let disposed = false;
  const dragManager = new DragDropManager({
    // Canvas already provides localized announcements and keyboard instructions.
    plugins: (defaults) => defaults.filter((plugin) => plugin !== Accessibility),
  });
  let sortables: Sortable[] = [];
  const watchedDragAnimations = new WeakSet<Animation>();
  const reorderAnimation = createReorderAnimationLookup(() => dragManager.dragOperation.source);
  let sortableNodes: InternalNode[] = [];
  // A different selected block rebuilds even when the siblings are the same.
  let sortablesOwner: string | undefined;
  const clear = () => {
    for (const sortable of sortables) sortable.destroy();
    sortables = [];
    sortableNodes = [];
    sortablesOwner = undefined;
  };
  const finish = (commit: boolean) => {
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
      options.announce(held.node, {
        kind: 'moved',
        destinationPosition: held.to + 1,
        destinationCount: held.siblings.length,
      });
    } else {
      options.announce(held.node, { kind: commit ? 'unchanged' : 'canceled' });
    }
    options.redraw();
  };
  // Runs on every redraw, so reuse the Sortables while the siblings are unchanged.
  const sync = (node: InternalNode, siblings: InternalNode[], handle: HTMLButtonElement) => {
    // Moving fragments or roots in unrelated wrappers would change the template's layout.
    if (
      siblings.length < 2 ||
      siblings.some(
        (candidate) =>
          candidate.elements.length !== 1 ||
          candidate.elements[0]?.parentElement !== node.elements[0]?.parentElement,
      )
    ) {
      clear();
      handle.disabled = true;
      return;
    }
    handle.disabled = false;
    handle.addEventListener('pointerdown', () => handle.focus({ preventScroll: true }));
    const unchanged =
      sortablesOwner === node.id &&
      sortables.length === siblings.length &&
      sortableNodes.every((existing, index) => existing.id === siblings[index]?.id);
    if (unchanged) {
      sortables.forEach((sortable, index) => {
        const candidate = siblings[index];
        if (!candidate) return;
        sortable.index = index;
        sortable.element = candidate.elements[0];
        sortable.handle = handle;
      });
      sortableNodes = siblings;
      return;
    }
    clear();
    sortablesOwner = node.id;
    sortableNodes = siblings;
    sortables = siblings.map(
      (candidate, index) =>
        new Sortable(
          {
            id: candidate.id,
            index,
            group: node.parentId,
            element: candidate.elements[0],
            handle,
            disabled: { draggable: candidate !== node || !!options.isEditing() },
            collisionDetector: (input) => {
              if (!dragging?.overview) return defaultCollisionDetection(input);
              // FLIP animations move siblings through the pointer after a reorder. Wait for their
              // resting rectangles so an animation cannot immediately undo the intended move.
              const source = dragManager.dragOperation.source;
              const animation = reorderAnimation();
              if (animation && !watchedDragAnimations.has(animation)) {
                watchedDragAnimations.add(animation);
                const held = dragging;
                const refresh = () => {
                  if (
                    !disposed &&
                    dragging === held &&
                    !held.ending &&
                    dragManager.dragOperation.status.dragging
                  ) {
                    dragManager.collisionObserver.forceUpdate();
                  }
                };
                void animation.finished.then(refresh, refresh);
              }
              return animation && source?.id !== input.droppable.id
                ? null
                : defaultCollisionDetection(input);
            },
            transition: { duration: 220 },
          },
          dragManager,
        ),
    );
  };
  dragManager.monitor.addEventListener('beforedragstart', (event) => {
    if (!options.canStart()) event.preventDefault();
  });
  dragManager.monitor.addEventListener('dragstart', ({ operation, nativeEvent }) => {
    const node = sortableNodes.find((candidate) => candidate.id === operation.source?.id);
    if (!node) return;
    const from = sortableNodes.indexOf(node);
    dragging = { node, siblings: [...sortableNodes], from, to: from };
    const element = node.elements[0];
    if (element instanceof HTMLElement && nativeEvent && 'clientX' in nativeEvent) {
      dragging.overview = createCanvasDragOverview(owner, element);
    }
    options.onInteraction?.({ kind: node.kind, target: node.target }, { dragging: true });
    options.announce(node, { kind: 'dragging' });
    options.redraw();
  });
  dragManager.monitor.addEventListener('dragend', ({ operation, canceled }) => {
    if (!dragging) return;
    if (isSortable(operation.source)) dragging.to = operation.source.index;
    dragging.ending = { commit: !canceled };
    options.redraw();
  });

  return {
    active: () => dragging !== undefined,
    idle: () => dragManager.dragOperation.status.idle,
    sync,
    clear,
    cancel: () => dragManager.actions.stop({ canceled: true }),
    /** Advances the drag once per overlay frame. `finished` means the page may be re-read. */
    step(): { placeholder?: Element } | 'restoring' | 'finished' | undefined {
      if (!dragging) return undefined;
      if (dragging.ending && dragManager.dragOperation.status.idle) {
        if (dragging.overview && !dragging.overview.restored) {
          dragging.overview.restore(!dragging.ending.commit);
          return 'restoring';
        }
        finish(dragging.ending.commit);
        return 'finished';
      }
      const source = dragManager.dragOperation.source;
      if (isSortable(source) && source.index !== dragging.to) {
        dragging.to = source.index;
        options.announce(dragging.node, {
          kind: 'preview',
          destinationPosition: source.index + 1,
          destinationCount: dragging.siblings.length,
        });
      }
      return { placeholder: isSortable(source) ? source.sortable.droppable.proxy : undefined };
    },
    dispose() {
      if (dragging) {
        dragging.overview?.dispose();
        dragManager.actions.stop({ canceled: true });
        finish(false);
      }
      const destroy = () => {
        if (!dragManager.dragOperation.status.idle) {
          owner.requestAnimationFrame(destroy);
          return;
        }
        clear();
        dragManager.destroy();
      };
      destroy();
      disposed = true;
    },
  };
}
