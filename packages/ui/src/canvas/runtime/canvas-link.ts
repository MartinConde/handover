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
import {
  type CanvasLinkDraft,
  type CanvasLinkEditorFeedback,
  createCanvasLinkEditor,
} from './canvas-link-editor';
import type { CanvasUiLocaleState } from './canvas-ui-locale';

type LinkField = Extract<CanvasTextField, { kind: 'link' }>;

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
    options.interaction(field.target, { inlineEditing: true, composing: false });
    editor.open({
      anchor: element,
      value: field.value,
      locale: field.target.locale,
      allowLabel: true,
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
        element.textContent = value.label;
        return undefined;
      },
      onClose: () => {
        if (!active || active.field !== field) return;
        active = undefined;
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

export type { CanvasLinkDraft };
