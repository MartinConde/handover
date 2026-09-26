/**
 * The site-page Canvas runtime has its own entry so it never executes in the admin shell or on a
 * public page. The rich editor remains a separate lazy boundary until an annotated rich-text field
 * asks for it.
 */
import { createCanvasChildBridge, readCanvasManifest } from './canvas/canvas-bridge';
import { sameCanvasTarget } from './canvas/canvas-target';
import { createCanvasLinkRuntime } from './canvas/runtime/canvas-link-field';
import { createCanvasNavigationRuntime } from './canvas/runtime/canvas-navigation';
import { createCanvasPlainTextRuntime } from './canvas/runtime/canvas-plain-text';
import { createCanvasSelectionRuntime } from './canvas/runtime/canvas-selection';
import { createCanvasUiLocaleState } from './canvas/runtime/canvas-ui-locale';
import { createEntryDirectoryReader } from './entry-directory';
import { messageOptions } from './i18n';
import * as m from './paraglide/messages.js';

export * from './canvas/runtime/canvas-selection';
export const loadCanvasRichTextEditor = () => import('./canvas/runtime/canvas-rich-text');

// A successful Canvas POST is same-origin and carries the route-verified identity in its manifest.
// Public pages and ordinary previews load no Canvas entry; a top-level asset fixture stays inert.
if (typeof window !== 'undefined' && window.parent !== window) {
  const manifest = readCanvasManifest();
  if (manifest) {
    const uiLocale = createCanvasUiLocaleState();
    const entryDirectory = createEntryDirectoryReader(
      window.fetch.bind(window),
      manifest.entryDirectory ?? '/admin/api/entries',
    );
    let selection: ReturnType<typeof createCanvasSelectionRuntime> | undefined;
    let link: ReturnType<typeof createCanvasLinkRuntime> | undefined;
    let text: ReturnType<typeof createCanvasPlainTextRuntime> | undefined;
    let richText:
      | ReturnType<typeof import('./canvas/runtime/canvas-rich-text').createCanvasRichTextRuntime>
      | undefined;
    let richTextLoad: ReturnType<typeof loadCanvasRichTextEditor> | undefined;
    let field: import('./canvas/canvas-bridge').CanvasTextField | undefined;
    let mode: import('./canvas/canvas-bridge').CanvasInteractionMode = 'edit';
    let requested:
      | {
          selection: import('./canvas/canvas-bridge').CanvasSelection;
          element: Element;
          trigger?: Element;
          caret?: number;
          point?: { x: number; y: number };
        }
      | undefined;
    const loadFailure = document.createElement('div');
    loadFailure.dataset.handoverCanvasRichtextFailure = '';
    loadFailure.style.cssText =
      'all:initial;position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647';
    const failureShadow = loadFailure.attachShadow({ mode: 'open' });
    failureShadow.innerHTML = `<style>
      div{display:flex;align-items:center;gap:12px;padding:12px;background:#fff;color:#202420;border:1px solid #c0271b;border-radius:6px;font:14px/1.5 system-ui;box-shadow:0 2px 8px #0002}
      span{flex:1}button{font:inherit;background:#fff;color:inherit;border:1px solid #767676;border-radius:4px;min-height:32px;cursor:pointer}button:focus-visible{outline:2px solid #537e2c;outline-offset:2px}
    </style><div role="alert"><span></span><button type="button"></button></div>`;
    const failureText = failureShadow.querySelector('span');
    const failureDismiss = failureShadow.querySelector('button');
    failureDismiss?.addEventListener('click', () => loadFailure.remove());
    uiLocale.subscribe((locale) => {
      loadFailure.lang = locale;
      const options = messageOptions(locale);
      if (failureText) failureText.textContent = m.canvas_richtext_load_failed({}, options);
      if (failureDismiss) failureDismiss.textContent = m.canvas_dismiss({}, options);
    });
    const activateRequested = () => {
      const pending = requested;
      if (!pending || !field || !sameCanvasTarget(pending.selection.target, field.target)) return;
      if (field.kind === 'link') {
        if (text?.active() || richText?.active()) return;
        requested = undefined;
        link?.activate(pending.selection, pending.element);
      } else if (field.kind === 'text') {
        if (richText?.active() || link?.active()) return;
        requested = undefined;
        text?.activate(pending.selection, pending.element, pending.caret);
      } else {
        if (!richText || text?.active() || link?.active()) return;
        requested = undefined;
        richText.activate(pending.selection, pending.element, pending.trigger, pending.point);
      }
    };
    const interaction = (
      target: import('./canvas/canvas-bridge').CanvasTarget,
      state: import('./canvas/canvas-bridge').CanvasEditingState,
    ) => {
      bridge.interaction(target, state);
      if (!state.inlineEditing) queueMicrotask(activateRequested);
    };
    const configureField = (next: import('./canvas/canvas-bridge').CanvasTextField | undefined) => {
      if (mode !== 'edit') next = undefined;
      if (next?.kind !== 'richtext') loadFailure.remove();
      field = next;
      text?.configure(next?.kind === 'text' ? next : undefined);
      link?.configure(next?.kind === 'link' ? next : undefined);
      richText?.configure(next?.kind === 'richtext' ? next : undefined);
      if (!next) {
        const pending = requested;
        requested = undefined;
        // The parent resolves non-inline fields against the schema before opening media controls.
        if (pending && mode === 'edit') {
          const { left, top, width, height } = pending.element.getBoundingClientRect();
          bridge.action('edit-media', pending.selection, undefined, { left, top, width, height });
        }
        return;
      }
      if (next.kind === 'text' || next.kind === 'link') return activateRequested();
      if (richText) return activateRequested();
      richTextLoad ??= loadCanvasRichTextEditor();
      const loading = richTextLoad;
      // Only a failed download gets the download notice, not an error thrown while starting.
      void loading.then(
        ({ createCanvasRichTextRuntime }) => {
          if (richText) return;
          loadFailure.remove();
          richText = createCanvasRichTextRuntime({
            command: (target, command) => bridge.command(target, command),
            interaction,
            readDirectory: entryDirectory.read,
            uiLocale,
          });
          richText.start();
          richText.configure(field?.kind === 'richtext' ? field : undefined);
          activateRequested();
        },
        () => {
          if (richTextLoad !== loading) return;
          richText?.dispose();
          richText = undefined;
          requested = undefined;
          richTextLoad = undefined;
          if (field?.kind === 'richtext' && mode === 'edit')
            document.documentElement.append(loadFailure);
        },
      );
    };
    const bridge = createCanvasChildBridge({
      manifest,
      parent: window.parent,
      origin: window.location.origin,
      onSelect: (value, settings) => selection?.select(value, settings),
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
      onProblems: (addresses) => selection?.problems(addresses),
      onUiLocale: (next) => uiLocale.set(next),
    });
    text = createCanvasPlainTextRuntime({
      command: (target, command) => bridge.command(target, command),
      interaction,
      uiLocale,
    });
    link = createCanvasLinkRuntime({
      command: (target, command) => bridge.command(target, command),
      interaction,
      readDirectory: entryDirectory.read,
      uiLocale,
    });
    selection = createCanvasSelectionRuntime({
      entryDocument: manifest.entry,
      adminBase: (manifest.entryDirectory ?? '/admin/api/entries').replace(/\/api\/entries$/, ''),
      onSelection: (value) => bridge.selection(value),
      onStructure: (nodes) => bridge.structure(nodes),
      onAction: (action, value, destination) => bridge.action(action, value, destination),
      onInteraction: (value, state) =>
        bridge.interaction(value.target, {
          inlineEditing: false,
          composing: false,
          dragging: state.dragging,
        }),
      onActivate: (value, element, intent) => {
        bridge.selection(value);
        if (value.kind !== 'field') return false;
        requested = { selection: value, element, ...intent };
        field = undefined;
        return true;
      },
      isEditing: () =>
        (text?.active() ?? false) || (link?.active() ?? false) || (richText?.active() ?? false),
      uiLocale,
    });
    const navigation = createCanvasNavigationRuntime({
      mode: () => mode,
      onNavigate: (request) => bridge.navigate(request),
    });
    bridge.start();
    text.start();
    selection.start();
    navigation.start();
  }
}
