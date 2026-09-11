import { richtextErrors, unsafeLinkScheme } from '@handover/core';
import { Editor, Extension } from '@tiptap/core';
import type { Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type {
  CanvasAcknowledgement,
  CanvasEditingState,
  CanvasHistoryMutation,
  CanvasSelection,
  CanvasTarget,
  CanvasTextField,
  CanvasTextHistory,
  CanvasTextSelection,
} from './canvas-bridge';
import { proseSelection, restoreProseSelection, richTextExtensions } from './rich-text-kit';

type RichField = Extract<CanvasTextField, { kind: 'richtext' }>;

export interface CanvasRichTextOptions {
  command: (
    target: CanvasTarget,
    command:
      | { type: 'field'; changes: readonly [{ value: string }]; history: CanvasTextHistory }
      | CanvasHistoryMutation,
  ) => Promise<CanvasAcknowledgement>;
  interaction: (target: CanvasTarget, state: CanvasEditingState) => void;
  root?: Document;
  owner?: Window;
}

const sameTarget = (a: CanvasTarget, b: CanvasTarget) => JSON.stringify(a) === JSON.stringify(b);

const historySelection = (selection: Selection): CanvasTextSelection => proseSelection(selection);

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

/** One lazy TipTap instance mounted only on an explicitly annotated block-capable prose root. */
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

  const style = root.createElement('style');
  style.dataset.handoverCanvasRichText = '';
  style.textContent = `
    [data-handover-richtext-editing],[data-handover-richtext-editing] .ProseMirror{outline:none!important;caret-color:currentColor!important;cursor:text!important}
    [data-handover-richtext-editing] .ProseMirror{min-height:1.5em;display:flow-root}
    [data-handover-inline-refusal]{outline:1px solid #b42318!important;outline-offset:2px!important}
    [data-handover-canvas-richtext-toolbar]{all:initial;position:fixed;z-index:2147483647;top:12px;left:12px;display:flex;flex-wrap:wrap;justify-content:center;box-sizing:border-box;width:max-content;max-width:calc(100vw - 24px);gap:3px;padding:5px;border:1px solid #e5e8e5;border-radius:7px;background:#fff;color:#202420;box-shadow:0 4px 16px rgb(23 26 33/.12);font:600 12px/1 system-ui,sans-serif}
    [data-handover-richtext-editing] ::selection{background:#dce8bd;color:inherit}
    [data-handover-canvas-richtext-toolbar][hidden]{display:none}
    [data-handover-canvas-richtext-toolbar] button{all:initial;box-sizing:border-box;min-width:30px;height:30px;padding:0 8px;border-radius:5px;color:#202420;font:600 12px/30px system-ui,sans-serif;text-align:center;cursor:pointer}
    [data-handover-canvas-richtext-toolbar] button:hover{background:#f7f8f7}
    [data-handover-canvas-richtext-toolbar] button:focus-visible{outline:2px solid #537e2c;outline-offset:1px}
    [data-handover-canvas-richtext-toolbar] button[aria-pressed="true"]{background:#eef5e4;color:#42651f}
  `;
  const toolbar = root.createElement('div');
  toolbar.dataset.handoverCanvasRichtextToolbar = '';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Rich text formatting');
  toolbar.hidden = true;
  const status = root.createElement('div');
  status.dataset.handoverCanvasRichtextStatus = '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText =
    'position:fixed;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0';

  const publish = (state: CanvasEditingState) => {
    if (active) options.interaction(active.target, state);
  };

  const apply = (value: string, selection?: CanvasTextSelection) => {
    if (!active || composing || reconciling) return;
    const held = selection ?? historySelection(active.editor.state.selection);
    reconciling = true;
    try {
      if (active.editor.getMarkdown() !== value)
        active.editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
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
    status.textContent = `The inline change was not applied (${reason}).`;
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
      status.textContent = '';
      const hasNewerLocalInput = queued > 1;
      if (reply.update && (command.type === 'history' || !hasNewerLocalInput))
        apply(reply.update.value, reply.update.selection);
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
          after: historySelection(active.editor.state.selection),
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

  // Anchor formatting to the edited selection and clamp it inside the iframe viewport.
  const positionToolbar = () => {
    if (!active || toolbar.hidden) return;
    const selection = root.getSelection();
    const range =
      selection?.rangeCount && active.element.contains(selection.anchorNode)
        ? selection.getRangeAt(0)
        : undefined;
    const selectionBounds = range?.getBoundingClientRect?.();
    const bounds = selectionBounds?.height
      ? selectionBounds
      : active.element.getBoundingClientRect();
    const toolbarBounds = toolbar.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(
        bounds.left + bounds.width / 2 - toolbarBounds.width / 2,
        owner.innerWidth - toolbarBounds.width - 8,
      ),
    );
    const above = bounds.top - toolbarBounds.height - 10;
    const top = Math.max(
      8,
      Math.min(
        above >= 8 ? above : bounds.bottom + 10,
        owner.innerHeight - toolbarBounds.height - 8,
      ),
    );
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
  };

  const refreshToolbar = () => {
    if (!active) return;
    positionToolbar();
    for (const button of Array.from(
      toolbar.querySelectorAll<HTMLButtonElement>('button[data-mark]'),
    )) {
      const mark = button.dataset.mark ?? '';
      const attrs = button.dataset.level ? { level: Number(button.dataset.level) } : undefined;
      button.setAttribute('aria-pressed', String(active.editor.isActive(mark, attrs)));
    }
  };

  const buttons = (field: RichField) => {
    const specs = [
      {
        label: 'Bold',
        text: 'B',
        mark: 'bold',
        run: (editor: Editor) => editor.chain().focus().toggleBold().run(),
      },
      {
        label: 'Italic',
        text: 'I',
        mark: 'italic',
        run: (editor: Editor) => editor.chain().focus().toggleItalic().run(),
      },
      {
        label: 'Link',
        text: 'Link',
        mark: 'link',
        run: (editor: Editor) => {
          if (editor.isActive('link')) return editor.chain().focus().unsetLink().run();
          if (editor.state.selection.empty) return false;
          const href = owner.prompt('Link URL')?.trim();
          if (!href || unsafeLinkScheme('default', href)) return false;
          return editor.chain().focus().setLink({ href }).run();
        },
      },
      {
        label: 'Bullet list',
        text: '• List',
        mark: 'bulletList',
        run: (editor: Editor) => editor.chain().focus().toggleBulletList().run(),
      },
      {
        label: 'Numbered list',
        text: '1. List',
        mark: 'orderedList',
        run: (editor: Editor) => editor.chain().focus().toggleOrderedList().run(),
      },
      ...(field.tier === 'full'
        ? [
            {
              label: 'Heading 2',
              text: 'H2',
              mark: 'heading',
              level: 2,
              run: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
            },
            {
              label: 'Heading 3',
              text: 'H3',
              mark: 'heading',
              level: 3,
              run: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
            },
            {
              label: 'Quote',
              text: '“”',
              mark: 'blockquote',
              run: (editor: Editor) => editor.chain().focus().toggleBlockquote().run(),
            },
          ]
        : []),
    ];
    toolbar.replaceChildren();
    for (const spec of specs) {
      const button = root.createElement('button');
      button.type = 'button';
      button.dataset.mark = spec.mark;
      if ('level' in spec && spec.level) button.dataset.level = String(spec.level);
      button.setAttribute('aria-label', spec.label);
      button.setAttribute('aria-pressed', 'false');
      button.textContent = spec.text;
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        if (!active) return;
        nextIntent = 'format';
        pendingBefore = historySelection(active.editor.state.selection);
        spec.run(active.editor);
        nextIntent = undefined;
        refreshToolbar();
      });
      toolbar.append(button);
    }
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
    held.element.replaceChildren(content);
    toolbar.hidden = true;
    toolbar.replaceChildren();
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

  const activate = (selection: CanvasSelection, element: Element) => {
    if (
      disposed ||
      selection.kind !== 'field' ||
      !compatible(element) ||
      !configured ||
      !sameTarget(selection.target, configured.target) ||
      richtextErrors('default', configured.value, configured.tier).length
    )
      return false;
    if (active?.element === element) return true;
    if (active) deactivate();
    const field = configured;
    // TipTap appends its own editable root; detach the rendered prose first.
    const original = root.createDocumentFragment();
    original.append(...Array.from(element.childNodes));
    let editor!: Editor;
    try {
      editor = new Editor({
        element,
        extensions: richTextExtensions(field.tier, [SessionHistory]),
        content: field.value,
        contentType: 'markdown',
        editorProps: {
          attributes: {
            'aria-label': 'Rich text in Canvas',
            'aria-multiline': 'true',
          },
          handleDOMEvents: {
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
              pendingBefore = domSelection(view) ?? historySelection(view.state.selection);
              return false;
            },
            compositionstart: (view) => {
              composing = true;
              compositionBefore = domSelection(view) ?? historySelection(view.state.selection);
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
          previousSelection = historySelection(editor.state.selection);
        },
        onTransaction: ({ editor, transaction }) => {
          if (transaction.docChanged && !reconciling && !pendingBefore)
            pendingBefore = previousSelection;
          previousSelection = historySelection(editor.state.selection);
          refreshToolbar();
        },
        onPaste: () => {
          pendingBefore = domSelection(editor.view) ?? historySelection(editor.state.selection);
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
      element.replaceChildren(original);
      throw error;
    }
    active = {
      element,
      target: field.target,
      accepted: field.value,
      field,
      editor,
      original,
      initialValue: field.value,
    };
    element.dataset.handoverRichtextEditing = '';
    buttons(field);
    toolbar.hidden = false;
    editor.commands.setTextSelection(editor.state.doc.content.size);
    editor.view.focus();
    refreshToolbar();
    publish({ inlineEditing: true, composing: false });
    return true;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!active) return;
    const target = event.target;
    if (
      !(target instanceof Node) ||
      (!active.element.contains(target) && !toolbar.contains(target))
    )
      return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  };

  const onFocusOut = () => {
    if (!active) return;
    queueMicrotask(() => {
      if (!active) return;
      const focused = root.activeElement;
      if (focused && (active.element.contains(focused) || toolbar.contains(focused))) return;
      finish();
    });
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
      if (!field || !sameTarget(active.target, field.target) || field.tier !== active.field.tier) {
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
    },
  };
}
