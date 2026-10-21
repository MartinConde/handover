import { richtextErrors } from '@handover/core';
import { Editor, Extension, type JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  proseSelection,
  restoreProseSelection,
  richTextExtensions,
} from '../../editor/fields/rich-text-kit';
import type { Pickable } from '../../entry-directory';
import { messageOptions } from '../../i18n';
import * as m from '../../paraglide/messages.js';
import type {
  CanvasAcknowledgement,
  CanvasEditingState,
  CanvasHistoryMutation,
  CanvasSelection,
  CanvasTarget,
  CanvasTextField,
  CanvasTextHistory,
  CanvasTextSelection,
} from '../canvas-protocol';
import { sameCanvasTarget } from '../canvas-target';
import { type CanvasLinkEditorFeedback, createCanvasLinkEditor } from './canvas-link-editor';
import { pinWrapping, readWrapping } from './canvas-plain-text';
import { createRichTextToolbar } from './canvas-rich-text-toolbar';
import type { CanvasUiLocaleState } from './canvas-ui-locale';

type RichField = Extract<CanvasTextField, { kind: 'richtext' }>;

interface CanvasRichTextOptions {
  command: (
    target: CanvasTarget,
    command:
      | { type: 'field'; changes: readonly [{ value: string }]; history: CanvasTextHistory }
      | CanvasHistoryMutation,
  ) => Promise<CanvasAcknowledgement>;
  interaction: (target: CanvasTarget, state: CanvasEditingState) => void;
  root?: Document;
  owner?: Window;
  readDirectory?: () => Promise<Pickable>;
  uiLocale?: CanvasUiLocaleState;
}

// Markdown source line wrapping is a space in rendered prose. TipTap's break-spaces
// would otherwise display these text-node newlines as hard line breaks.
const proseSoftBreaks = (node: JSONContent): JSONContent => ({
  ...node,
  ...(node.type === 'text' && node.text ? { text: node.text.replace(/\r?\n/g, ' ') } : {}),
  ...(node.content ? { content: node.content.map(proseSoftBreaks) } : {}),
});

const domSelection = (view: EditorView): CanvasTextSelection | undefined => {
  const selection = view.dom.ownerDocument.getSelection();
  const anchorNode = selection?.anchorNode;
  const focusNode = selection?.focusNode;
  if (
    !selection ||
    !anchorNode ||
    !focusNode ||
    !view.dom.contains(anchorNode) ||
    !view.dom.contains(focusNode)
  )
    return;
  try {
    return {
      kind: 'text',
      anchor: view.posAtDOM(anchorNode, selection.anchorOffset),
      head: view.posAtDOM(focusNode, selection.focusOffset),
    };
  } catch {
    return;
  }
};

const compatible = (element: Element): element is HTMLElement =>
  element instanceof HTMLElement &&
  ['ARTICLE', 'ASIDE', 'DIV', 'MAIN', 'SECTION'].includes(element.tagName) &&
  !element.closest('[contenteditable="true"]');

// One lazy TipTap instance mounted only on an explicitly annotated block-capable prose root.
export function createCanvasRichTextRuntime(options: CanvasRichTextOptions) {
  const root = options.root ?? document;
  const owner = options.owner ?? window;
  let configured: RichField | undefined;
  let active:
    | {
        element: HTMLElement;
        target: CanvasTarget;
        accepted: string;
        field: RichField;
        editor: Editor;
        original: DocumentFragment;
        initialValue: string;
        unpin: () => void;
      }
    | undefined;
  let disposed = false;
  let reconciling = false;
  let composing = false;
  let compositionBefore: CanvasTextSelection | undefined;
  let compositionGroup = '';
  let pendingBefore: CanvasTextSelection | undefined;
  let previousSelection: CanvasTextSelection | undefined;
  let nextIntent: CanvasTextHistory['kind'] | undefined;
  let generation = 0;
  let queued = 0;
  let lane = Promise.resolve();
  let refusalReason: string | undefined;
  const linkEditor = createCanvasLinkEditor({
    root,
    owner,
    readDirectory: options.readDirectory,
    uiLocale: options.uiLocale,
  });

  const {
    style,
    toolbar,
    status,
    optionsLocale,
    positionToolbar,
    refreshToolbar,
    translateUi,
    buttons,
  } = createRichTextToolbar({
    root,
    owner,
    uiLocale: options.uiLocale,
    active: () => active,
    refusalReason: () => refusalReason,
    onFormat: (editor, run) => {
      nextIntent = 'format';
      pendingBefore = proseSelection(editor.state.selection);
      run();
      nextIntent = undefined;
    },
    openLink: (editor) => openLink(editor),
  });

  const publish = (state: CanvasEditingState) => {
    if (active) options.interaction(active.target, state);
  };

  const apply = (value: string, selection?: CanvasTextSelection) => {
    if (!active || composing || reconciling) return;
    const held = selection ?? proseSelection(active.editor.state.selection);
    reconciling = true;
    try {
      if (active.editor.getMarkdown() !== value)
        active.editor.commands.setContent(
          proseSoftBreaks(active.editor.markdown?.parse(value) ?? active.editor.getJSON()),
          { emitUpdate: false },
        );
      const restored = restoreProseSelection(active.editor.state.doc, {
        kind: held.kind ?? 'text',
        anchor: held.anchor,
        head: held.head,
      });
      if (!restored.eq(active.editor.state.selection))
        active.editor.view.dispatch(active.editor.state.tr.setSelection(restored));
    } finally {
      reconciling = false;
    }
  };

  const refusal = (reason: string) => {
    if (!active) return;
    generation += 1;
    apply(active.accepted);
    active.element.dataset.handoverInlineRefusal = reason;
    refusalReason = reason;
    translateUi();
  };

  const enqueue = (
    command:
      | { type: 'field'; changes: readonly [{ value: string }]; history: CanvasTextHistory }
      | CanvasHistoryMutation,
    value?: string,
  ) => {
    if (!active) return Promise.resolve();
    const held = active;
    const ticket = generation;
    queued += 1;
    const run = lane.then(async () => {
      if (disposed || ticket !== generation || active !== held) return;
      const reply = await options.command(held.target, command);
      if (disposed || ticket !== generation || active !== held) return;
      if (!reply.ok) {
        if (reply.update) held.accepted = reply.update.value;
        refusal(reply.reason);
        return;
      }
      held.accepted = reply.update?.value ?? value ?? held.accepted;
      status.dataset.handoverCanvasRichtextVersion = String(reply.acceptedVersion);
      delete held.element.dataset.handoverInlineRefusal;
      refusalReason = undefined;
      status.textContent = '';
      const hasNewerLocalInput = queued > 1;
      if (reply.update && !hasNewerLocalInput) apply(reply.update.value, reply.update.selection);
    });
    lane = run
      .catch(() => refusal('handler-error'))
      .finally(() => {
        queued = Math.max(0, queued - 1);
      });
    return run;
  };

  const commit = (
    kind: CanvasTextHistory['kind'],
    before?: CanvasTextSelection,
    group?: string,
  ) => {
    if (!active) return;
    const value = active.editor.getMarkdown();
    void enqueue(
      {
        type: 'field',
        changes: [{ value }],
        history: {
          kind,
          ...(group ? { group } : {}),
          before: before ?? previousSelection,
          after: proseSelection(active.editor.state.selection),
        },
      },
      value,
    );
  };

  const replay = (direction: 'redo' | 'undo') => {
    void enqueue({ type: 'history', direction });
    return true;
  };

  const SessionHistory = Extension.create({
    name: 'handoverCanvasSessionHistory',
    priority: 1000,
    addKeyboardShortcuts() {
      return {
        'Mod-z': () => replay('undo'),
        'Mod-Shift-z': () => replay('redo'),
        'Mod-y': () => replay('redo'),
      };
    },
  });

  const openLink = (editor: Editor, anchor?: HTMLAnchorElement) => {
    if (editor.isActive('link')) editor.chain().focus().extendMarkRange('link').run();
    if (editor.state.selection.empty) return false;
    const selection = editor.state.selection;
    const selectedRange = { from: selection.from, to: selection.to };
    const label = editor.state.doc.textBetween(selection.from, selection.to, ' ');
    const href = String(editor.getAttributes('link').href ?? anchor?.getAttribute('href') ?? '');
    const range = root.getSelection()?.rangeCount ? root.getSelection()?.getRangeAt(0) : undefined;
    const measured =
      range && typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : undefined;
    const bounds =
      measured?.width || measured?.height ? measured : active?.element.getBoundingClientRect();
    if (!bounds) return false;
    const remove = Boolean(href);
    toolbar.hidden = true;
    linkEditor.open({
      anchor: () => bounds,
      value: { type: 'url', ref: '', href, label, newTab: false },
      locale: active?.target.locale ?? '',
      allowRemove: remove,
      onApply: (value) => {
        nextIntent = 'format';
        pendingBefore = proseSelection(selection);
        let applied = false;
        try {
          const linkType = editor.schema.marks.link;
          if (!linkType) throw new Error('Rich-text link mark is unavailable.');
          const link = linkType.create({ href: value.href });
          const retained = editor.state.doc
            .resolve(selectedRange.from)
            .marks()
            .filter((mark) => mark.type.name !== 'link');
          const content = editor.schema.text(value.label, [...retained, link]);
          const transaction = editor.state.tr.replaceWith(
            selectedRange.from,
            selectedRange.to,
            content,
          );
          transaction.setSelection(
            TextSelection.create(transaction.doc, selectedRange.from + content.nodeSize),
          );
          editor.view.dispatch(transaction);
          editor.view.focus();
          applied = true;
        } catch {
          applied = false;
        }
        nextIntent = undefined;
        return applied
          ? undefined
          : (((locale) =>
              m.canvas_link_update_failed(
                {},
                messageOptions(locale),
              )) satisfies CanvasLinkEditorFeedback);
      },
      onRemove: () => {
        nextIntent = 'format';
        pendingBefore = proseSelection(selection);
        const linkType = editor.schema.marks.link;
        if (!linkType) {
          nextIntent = undefined;
          return;
        }
        const transaction = editor.state.tr.removeMark(
          selectedRange.from,
          selectedRange.to,
          linkType,
        );
        editor.view.dispatch(transaction);
        editor.view.focus();
        nextIntent = undefined;
      },
      onClose: () => {
        if (!active) return;
        toolbar.hidden = false;
        editor.view.focus();
        refreshToolbar();
      },
    });
    return true;
  };

  const deactivate = () => {
    if (!active) return;
    const held = active;
    // Keep the last accepted content on screen until the replacement render is ready.
    apply(held.accepted);
    const content =
      held.accepted === held.initialValue ? held.original : root.createDocumentFragment();
    if (content !== held.original)
      for (const child of Array.from(held.editor.view.dom.childNodes))
        content.append(child.cloneNode(true));
    active = undefined;
    held.element.removeAttribute('data-handover-richtext-editing');
    held.element.removeAttribute('data-handover-inline-refusal');
    held.editor.destroy();
    held.unpin();
    held.element.replaceChildren(content);
    if (linkEditor.active()) linkEditor.close('cancel');
    toolbar.hidden = true;
    toolbar.replaceChildren();
    // A composition cut off here never gets its compositionend, which would block every later commit.
    composing = false;
    compositionBefore = undefined;
    compositionGroup = '';
    options.interaction(held.target, { inlineEditing: false, composing: false });
  };

  const finish = () => {
    if (!active) return;
    const held = active;
    const ticket = generation;
    void lane.finally(() => {
      if (!disposed && active === held && generation === ticket) deactivate();
    });
  };

  const activate = (
    selection: CanvasSelection,
    element: Element,
    trigger?: Element,
    point?: { x: number; y: number },
  ) => {
    if (
      disposed ||
      selection.kind !== 'field' ||
      !(element instanceof HTMLElement) ||
      (!compatible(element) && active?.element !== element) ||
      !configured ||
      !sameCanvasTarget(selection.target, configured.target) ||
      richtextErrors(configured.value, configured.tier).length
    )
      return false;
    if (active?.element === element) return true;
    if (active) deactivate();
    const field = configured;
    const triggeredLink =
      trigger instanceof HTMLAnchorElement && element.contains(trigger)
        ? { href: trigger.getAttribute('href') ?? '' }
        : undefined;
    // Read the rendered wrapping before TipTap's editable root brings the UA's own.
    const wrapping = readWrapping(element);
    const attributes = [
      'class',
      'style',
      'contenteditable',
      'role',
      'aria-label',
      'aria-multiline',
      'tabindex',
      'translate',
    ];
    const previousAttributes = attributes.map(
      (name) => [name, element.getAttribute(name)] as const,
    );
    const restoreAttributes = () => {
      for (const [name, value] of previousAttributes) {
        if (value === null) element.removeAttribute(name);
        else element.setAttribute(name, value);
      }
    };
    const computed = owner.getComputedStyle(element);
    const presentation = ['position', 'font-variant-ligatures', 'font-feature-settings'].map(
      (property) => [property, computed.getPropertyValue(property)] as const,
    );
    // Mount onto the authored prose root so direct-child selectors, flex/grid sizing,
    // and margin collapsing keep the same DOM relationships during editing.
    const original = root.createDocumentFragment();
    original.append(...Array.from(element.childNodes));
    let editor!: Editor;
    try {
      editor = new Editor({
        element: { mount: element },
        extensions: richTextExtensions(field.tier, [SessionHistory]),
        content: field.value,
        contentType: 'markdown',
        editorProps: {
          attributes: {
            'aria-label': m.canvas_rich_text_editable({}, messageOptions(optionsLocale())),
            'aria-multiline': 'true',
          },
          handleDOMEvents: {
            click: (_view, event) => {
              const anchor =
                event.target instanceof Element ? event.target.closest('a') : undefined;
              if (!(anchor instanceof HTMLAnchorElement) || !element.contains(anchor)) return false;
              event.preventDefault();
              queueMicrotask(() => {
                if (active?.editor === editor) openLink(editor, anchor);
              });
              return true;
            },
            beforeinput: (view, event) => {
              const intent = event as InputEvent;
              const direction =
                intent.inputType === 'historyUndo'
                  ? 'undo'
                  : intent.inputType === 'historyRedo'
                    ? 'redo'
                    : undefined;
              if (direction) {
                event.preventDefault();
                replay(direction);
                return true;
              }
              pendingBefore = domSelection(view) ?? proseSelection(view.state.selection);
              return false;
            },
            compositionstart: (view) => {
              composing = true;
              compositionBefore = domSelection(view) ?? proseSelection(view.state.selection);
              compositionGroup = `composition-${crypto.randomUUID()}`;
              publish({ inlineEditing: true, composing: true });
              return false;
            },
            compositionend: () => {
              const before = compositionBefore;
              const group = compositionGroup;
              queueMicrotask(() => {
                if (!active || !composing || compositionGroup !== group) return;
                composing = false;
                compositionBefore = undefined;
                compositionGroup = '';
                commit('composition', before, group);
                pendingBefore = undefined;
                publish({ inlineEditing: true, composing: false });
              });
              return false;
            },
          },
        },
        onCreate: ({ editor }) => {
          previousSelection = proseSelection(editor.state.selection);
        },
        onTransaction: ({ editor, transaction }) => {
          if (transaction.docChanged && !reconciling && !pendingBefore)
            pendingBefore = previousSelection;
          previousSelection = proseSelection(editor.state.selection);
          refreshToolbar();
        },
        onPaste: () => {
          pendingBefore = domSelection(editor.view) ?? proseSelection(editor.state.selection);
          nextIntent = 'paste';
          queueMicrotask(() => {
            if (nextIntent === 'paste') nextIntent = undefined;
          });
        },
        onUpdate: () => {
          if (reconciling || composing) return;
          commit(nextIntent ?? 'typing', pendingBefore);
          pendingBefore = undefined;
          nextIntent = undefined;
        },
      });
    } catch (error) {
      restoreAttributes();
      element.replaceChildren(original);
      throw error;
    }
    const parsed = editor.getJSON();
    const rendered = proseSoftBreaks(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(rendered))
      editor.commands.setContent(rendered, { emitUpdate: false });
    active = {
      element,
      target: field.target,
      accepted: field.value,
      field,
      editor,
      original,
      initialValue: field.value,
      unpin: restoreAttributes,
    };
    pinWrapping(element, wrapping);
    for (const [property, value] of presentation)
      if (value) element.style.setProperty(property, value, 'important');
    element.dataset.handoverRichtextEditing = '';
    buttons(field);
    toolbar.hidden = false;
    let linkRange: { from: number; to: number } | undefined;
    if (triggeredLink) {
      editor.state.doc.descendants((node, position) => {
        if (!node.isText) return;
        const sameLink = node.marks.some(
          (mark) =>
            mark.type.name === 'link' && String(mark.attrs.href ?? '') === triggeredLink.href,
        );
        if (!sameLink) return;
        if (!linkRange) linkRange = { from: position, to: position + node.nodeSize };
        else if (position === linkRange.to) linkRange.to = position + node.nodeSize;
      });
    }
    const clicked = point
      ? editor.view.posAtCoords({ left: point.x, top: point.y })?.pos
      : undefined;
    editor.commands.setTextSelection(linkRange ?? clicked ?? editor.state.doc.content.size);
    editor.view.focus();
    refreshToolbar();
    publish({ inlineEditing: true, composing: false });
    if (linkRange)
      queueMicrotask(() => {
        if (active?.editor === editor) openLink(editor);
      });
    return true;
  };

  const unsubscribeLocale = options.uiLocale?.subscribe(() => translateUi());

  const onKeyDown = (event: KeyboardEvent) => {
    if (!active) return;
    const target = event.target;
    if (
      !(target instanceof Node) ||
      (!active.element.contains(target) &&
        !toolbar.contains(target) &&
        !linkEditor.contains(target))
    )
      return;
    if (event.key !== 'Escape') return;
    // An IME uses Escape to cancel its own conversion; that must not also close the editor.
    if (event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  };

  const onFocusOut = () => {
    if (!active) return;
    owner.setTimeout(() => {
      if (!active) return;
      if (linkEditor.active()) return;
      const focused = root.activeElement;
      if (
        focused &&
        (active.element.contains(focused) ||
          toolbar.contains(focused) ||
          linkEditor.contains(focused))
      )
        return;
      finish();
    }, 0);
  };

  return {
    start() {
      if (disposed || style.isConnected) return;
      root.head.append(style);
      root.documentElement.append(toolbar, status);
      root.addEventListener('keydown', onKeyDown, true);
      root.addEventListener('focusout', onFocusOut, true);
      owner.addEventListener('blur', onFocusOut);
      root.addEventListener('scroll', positionToolbar, true);
      root.addEventListener('selectionchange', positionToolbar);
      owner.addEventListener('resize', positionToolbar);
    },
    configure(field?: RichField) {
      configured = field;
      if (!active) return;
      if (
        !field ||
        !sameCanvasTarget(active.target, field.target) ||
        field.tier !== active.field.tier
      ) {
        if (!queued && !composing) deactivate();
        else finish();
        return;
      }
      active.accepted = field.value;
      active.field = field;
      if (!queued && !composing) apply(field.value);
    },
    activate,
    active: () => active !== undefined,
    composing: () => composing,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      if (active) deactivate();
      root.removeEventListener('keydown', onKeyDown, true);
      root.removeEventListener('focusout', onFocusOut, true);
      owner.removeEventListener('blur', onFocusOut);
      root.removeEventListener('scroll', positionToolbar, true);
      root.removeEventListener('selectionchange', positionToolbar);
      owner.removeEventListener('resize', positionToolbar);
      style.remove();
      toolbar.remove();
      status.remove();
      linkEditor.dispose();
      unsubscribeLocale?.();
    },
  };
}
