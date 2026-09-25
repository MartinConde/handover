import type { Pickable } from '../../entry-directory';
import { messageOptions } from '../../i18n';
import * as m from '../../paraglide/messages.js';
import type {
  CanvasAcknowledgement,
  CanvasEditingState,
  CanvasFieldMutation,
  CanvasSelection,
  CanvasTarget,
  CanvasTextField,
} from '../canvas-bridge';
import { sameCanvasTarget } from '../canvas-target';
import { type CanvasLinkEditorFeedback, createCanvasLinkEditor } from './canvas-link-editor';
import type { CanvasUiLocaleState } from './canvas-ui-locale';

type LinkField = Extract<CanvasTextField, { kind: 'link' }>;

// `textContent =` would wipe icon markup inside the link until the next render.
const setLabelText = (element: HTMLElement, label: string) => {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode())
    if (walker.currentNode.nodeValue?.trim()) texts.push(walker.currentNode as Text);
  const [first, ...rest] = texts;
  if (!first) return element.append(label);
  first.data = label;
  for (const node of rest) node.remove();
};

export interface CanvasLinkOptions {
  command: (target: CanvasTarget, command: CanvasFieldMutation) => Promise<CanvasAcknowledgement>;
  interaction: (target: CanvasTarget, state: CanvasEditingState) => void;
  root?: Document;
  owner?: Window;
  readDirectory?: () => Promise<Pickable>;
  uiLocale?: CanvasUiLocaleState;
}

/** Edits an annotated schema link without turning its button or anchor into a text-only surface. */
export function createCanvasLinkRuntime(options: CanvasLinkOptions) {
  const root = options.root ?? document;
  const owner = options.owner ?? window;
  let configured: LinkField | undefined;
  let active: { element: HTMLElement; field: LinkField } | undefined;
  let disposed = false;

  const editor = createCanvasLinkEditor({
    root,
    owner,
    readDirectory: options.readDirectory,
    uiLocale: options.uiLocale,
  });

  const finish = () => {
    const held = active;
    if (!held) return;
    active = undefined;
    held.element.removeAttribute('data-handover-link-editing');
    editor.close('cancel');
    options.interaction(held.field.target, { inlineEditing: false, composing: false });
  };

  const activate = (selection: CanvasSelection, element: Element) => {
    if (
      disposed ||
      selection.kind !== 'field' ||
      !(element instanceof HTMLElement) ||
      !configured ||
      !sameCanvasTarget(selection.target, configured.target)
    )
      return false;
    if (active) finish();
    const field = configured;
    active = { element, field };
    // The parent checks for this marker when an editing stop may have been lost.
    element.dataset.handoverLinkEditing = '';
    options.interaction(field.target, { inlineEditing: true, composing: false });
    editor.open({
      anchor: element,
      value: field.value,
      locale: field.target.locale,
      allowNewTab: true,
      onApply: async (value) => {
        const changes: CanvasFieldMutation['changes'] = [
          { path: ['type'], value: value.type },
          { path: ['ref'], value: value.type === 'entry' ? value.ref : undefined },
          { path: ['href'], value: value.type === 'url' ? value.href : undefined },
          { path: ['label'], value: value.label || undefined },
          { path: ['newTab'], value: value.newTab || undefined },
        ];
        const response = await options.command(field.target, { type: 'field', changes });
        if (!response.ok)
          return ((locale) =>
            m.canvas_link_update_failed_reason(
              { reason: response.reason },
              messageOptions(locale),
            )) satisfies CanvasLinkEditorFeedback;
        field.value = { ...value };
        setLabelText(element, value.label);
        return undefined;
      },
      onClose: () => {
        if (!active || active.field !== field) return;
        active = undefined;
        element.removeAttribute('data-handover-link-editing');
        options.interaction(field.target, { inlineEditing: false, composing: false });
      },
    });
    return true;
  };

  return {
    start() {},
    configure(field?: LinkField) {
      configured = field;
      if (active && (!field || !sameCanvasTarget(active.field.target, field.target))) finish();
    },
    activate,
    active: () => Boolean(active),
    dispose() {
      if (disposed) return;
      disposed = true;
      finish();
      editor.dispose();
    },
  };
}
