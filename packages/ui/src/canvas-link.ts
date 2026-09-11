import type {
  CanvasAcknowledgement,
  CanvasEditingState,
  CanvasFieldMutation,
  CanvasSelection,
  CanvasTarget,
  CanvasTextField,
} from './canvas-bridge';
import { type CanvasLinkDraft, createCanvasLinkEditor } from './canvas-link-editor';

type LinkField = Extract<CanvasTextField, { kind: 'link' }>;

export interface CanvasLinkOptions {
  command: (target: CanvasTarget, command: CanvasFieldMutation) => Promise<CanvasAcknowledgement>;
  interaction: (target: CanvasTarget, state: CanvasEditingState) => void;
  root?: Document;
  owner?: Window;
}

const sameTarget = (a: CanvasTarget, b: CanvasTarget) => JSON.stringify(a) === JSON.stringify(b);

/** Edits an annotated schema link without turning its button or anchor into a text-only surface. */
export function createCanvasLinkRuntime(options: CanvasLinkOptions) {
  const root = options.root ?? document;
  const owner = options.owner ?? window;
  let configured: LinkField | undefined;
  let active: { element: HTMLElement; field: LinkField } | undefined;
  let disposed = false;

  const editor = createCanvasLinkEditor({ root, owner });

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
      !sameTarget(selection.target, configured.target)
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
      label: 'Edit link',
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
        if (!response.ok) return `This link could not be updated (${response.reason}).`;
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
      if (active && (!field || !sameTarget(active.field.target, field.target))) finish();
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
