/**
 * The site-page Canvas runtime has its own entry so it never executes in the admin shell or on a
 * public page. The rich editor remains a separate lazy boundary until an annotated rich-text field
 * asks for it.
 */
import { createCanvasChildBridge, readCanvasManifest } from './canvas-bridge';
import { createCanvasNavigationRuntime } from './canvas-navigation';
import { createCanvasSelectionRuntime } from './canvas-selection';
import { createCanvasPlainTextRuntime } from './canvas-text';

export * from './canvas-bridge';
export * from './canvas-renderer';
export * from './canvas-selection';
export * from './canvas-text';
export const loadCanvasRichTextEditor = () => import('./canvas-rich-text');

// A successful Canvas POST is same-origin and carries the route-verified identity in its manifest.
// Public pages and ordinary previews load no Canvas entry; a top-level asset fixture stays inert.
if (typeof window !== 'undefined' && window.parent !== window) {
  const manifest = readCanvasManifest();
  if (manifest) {
    let selection: ReturnType<typeof createCanvasSelectionRuntime> | undefined;
    let text: ReturnType<typeof createCanvasPlainTextRuntime> | undefined;
    let richText:
      | ReturnType<typeof import('./canvas-rich-text').createCanvasRichTextRuntime>
      | undefined;
    let richTextLoad: ReturnType<typeof loadCanvasRichTextEditor> | undefined;
    let field: import('./canvas-bridge').CanvasTextField | undefined;
    let mode: import('./canvas-navigation').CanvasInteractionMode = 'edit';
    let requested:
      | { selection: import('./canvas-bridge').CanvasSelection; element: Element }
      | undefined;
    const sameTarget = (
      a: import('./canvas-bridge').CanvasTarget,
      b: import('./canvas-bridge').CanvasTarget,
    ) => JSON.stringify(a) === JSON.stringify(b);
    const activateRequested = () => {
      const pending = requested;
      if (!pending || !field || !sameTarget(pending.selection.target, field.target)) return;
      if (field.kind === 'text') {
        if (richText?.active()) return;
        requested = undefined;
        text?.activate(pending.selection, pending.element);
      } else {
        if (!richText || text?.active()) return;
        requested = undefined;
        richText.activate(pending.selection, pending.element);
      }
    };
    const interaction = (
      target: import('./canvas-bridge').CanvasTarget,
      state: import('./canvas-bridge').CanvasEditingState,
    ) => {
      bridge.interaction(target, state);
      if (!state.inlineEditing) queueMicrotask(activateRequested);
    };
    const configureField = (next: import('./canvas-bridge').CanvasTextField | undefined) => {
      if (mode !== 'edit') next = undefined;
      field = next;
      text?.configure(next?.kind === 'text' ? next : undefined);
      richText?.configure(next?.kind === 'richtext' ? next : undefined);
      if (!next) {
        requested = undefined;
        return;
      }
      if (next.kind === 'text') return activateRequested();
      if (richText) return activateRequested();
      richTextLoad ??= loadCanvasRichTextEditor();
      void richTextLoad
        .then(({ createCanvasRichTextRuntime }) => {
          if (richText) return;
          richText = createCanvasRichTextRuntime({
            command: (target, command) => bridge.command(target, command),
            interaction,
          });
          richText.start();
          richText.configure(field?.kind === 'richtext' ? field : undefined);
          activateRequested();
        })
        .catch(() => {
          requested = undefined;
          richTextLoad = undefined;
        });
    };
    const bridge = createCanvasChildBridge({
      manifest,
      parent: window.parent,
      origin: window.location.origin,
      onSelect: (value) => selection?.select(value, { scroll: true }),
      onTextField: configureField,
      onActions: ({ selection: value, actions }) => selection?.actions(value, actions),
      onMode: (next) => {
        mode = next;
        selection?.setEnabled(next === 'edit');
        if (next !== 'edit') {
          requested = undefined;
          configureField(undefined);
        }
      },
    });
    text = createCanvasPlainTextRuntime({
      command: (target, command) => bridge.command(target, command),
      interaction,
    });
    selection = createCanvasSelectionRuntime({
      onSelection: (value) => bridge.selection(value),
      onStructure: (nodes) => bridge.structure(nodes),
      onAction: (action, value, destination) => bridge.action(action, value, destination),
      onInteraction: (value, state) =>
        bridge.interaction(value.target, {
          inlineEditing: false,
          composing: false,
          dragging: state.dragging,
        }),
      onActivate: (value, element) => {
        bridge.selection(value);
        if (value.kind !== 'field') return false;
        requested = { selection: value, element };
        field = undefined;
        return true;
      },
      isEditing: () => (text?.active() ?? false) || (richText?.active() ?? false),
    });
    const navigation = createCanvasNavigationRuntime({
      onNavigate: (request) => bridge.navigate(request),
    });
    bridge.start();
    text.start();
    navigation.start();
    selection.start();
  }
}
