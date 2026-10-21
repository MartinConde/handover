import type { Editor } from '@tiptap/core';
import { messageOptions } from '../../i18n';
import * as m from '../../paraglide/messages.js';
import type { CanvasTextField } from '../canvas-protocol';
import type { CanvasUiLocaleState } from './canvas-ui-locale';

type RichField = Extract<CanvasTextField, { kind: 'richtext' }>;

interface RichTextToolbarOptions {
  root: Document;
  owner: Window;
  uiLocale?: CanvasUiLocaleState;
  active: () => { element: HTMLElement; editor: Editor } | undefined;
  refusalReason: () => string | undefined;
  onFormat: (editor: Editor, run: () => void) => void;
  openLink: (editor: Editor) => boolean;
}

export function createRichTextToolbar({
  root,
  owner,
  uiLocale,
  active,
  refusalReason,
  onFormat,
  openLink,
}: RichTextToolbarOptions) {
  const style = root.createElement('style');
  style.dataset.handoverCanvasRichText = '';
  style.textContent = `
    [data-handover-richtext-editing],[data-handover-richtext-editing] .ProseMirror{outline:none!important;caret-color:currentColor!important;cursor:text!important}
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
  toolbar.hidden = true;
  const status = root.createElement('div');
  status.dataset.handoverCanvasRichtextStatus = '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText =
    'position:fixed;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0';

  // Anchor formatting to the edited selection and clamp it inside the iframe viewport.
  const positionToolbar = () => {
    const held = active();
    if (!held || toolbar.hidden) return;
    const selection = root.getSelection();
    const range =
      selection?.rangeCount && held.element.contains(selection.anchorNode)
        ? selection.getRangeAt(0)
        : undefined;
    const selectionBounds = range?.getBoundingClientRect?.();
    const bounds = selectionBounds?.height ? selectionBounds : held.element.getBoundingClientRect();
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
    const held = active();
    if (!held) return;
    positionToolbar();
    for (const button of Array.from(
      toolbar.querySelectorAll<HTMLButtonElement>('button[data-mark]'),
    )) {
      const mark = button.dataset.mark ?? '';
      const attrs = button.dataset.level ? { level: Number(button.dataset.level) } : undefined;
      button.setAttribute('aria-pressed', String(held.editor.isActive(mark, attrs)));
    }
  };

  const labels = (control: string) => {
    const options = messageOptions(optionsLocale());
    switch (control) {
      case 'bold':
        return m.rich_text_bold({}, options);
      case 'italic':
        return m.rich_text_italic({}, options);
      case 'link':
        return m.rich_text_link({}, options);
      case 'bulletList':
        return m.rich_text_bullet_list({}, options);
      case 'orderedList':
        return m.rich_text_numbered_list({}, options);
      case 'heading2':
        return m.rich_text_heading({ level: 2 }, options);
      case 'heading3':
        return m.rich_text_heading({ level: 3 }, options);
      default:
        return m.rich_text_quote({}, options);
    }
  };

  const shortLabel = (control: string) => {
    if (control === 'bulletList')
      return `• ${m.canvas_rich_text_list_short({}, messageOptions(optionsLocale()))}`;
    if (control === 'orderedList')
      return `1. ${m.canvas_rich_text_list_short({}, messageOptions(optionsLocale()))}`;
    if (control === 'link') return m.rich_text_link({}, messageOptions(optionsLocale()));
    return control === 'bold'
      ? 'B'
      : control === 'italic'
        ? 'I'
        : control.startsWith('heading')
          ? `H${control.at(-1)}`
          : '“”';
  };

  const optionsLocale = () => uiLocale?.current() ?? 'en';
  const translateUi = () => {
    const locale = optionsLocale();
    const translated = messageOptions(locale);
    toolbar.lang = locale;
    status.lang = locale;
    toolbar.setAttribute('aria-label', m.canvas_rich_text_formatting({}, translated));
    for (const button of Array.from(
      toolbar.querySelectorAll<HTMLButtonElement>('button[data-control]'),
    )) {
      const control = button.dataset.control ?? '';
      button.setAttribute('aria-label', labels(control));
      button.textContent = shortLabel(control);
    }
    active()?.editor.view.dom.setAttribute(
      'aria-label',
      m.canvas_rich_text_editable({}, translated),
    );
    const reason = refusalReason();
    if (reason) status.textContent = m.canvas_inline_change_refused({ reason }, translated);
  };
  translateUi();

  const buttons = (field: RichField) => {
    const specs = [
      {
        control: 'bold',
        mark: 'bold',
        run: (editor: Editor) => editor.chain().focus().toggleBold().run(),
      },
      {
        control: 'italic',
        mark: 'italic',
        run: (editor: Editor) => editor.chain().focus().toggleItalic().run(),
      },
      {
        control: 'link',
        mark: 'link',
        run: (editor: Editor) => openLink(editor),
      },
      {
        control: 'bulletList',
        mark: 'bulletList',
        run: (editor: Editor) => editor.chain().focus().toggleBulletList().run(),
      },
      {
        control: 'orderedList',
        mark: 'orderedList',
        run: (editor: Editor) => editor.chain().focus().toggleOrderedList().run(),
      },
      ...(field.tier === 'full'
        ? [
            {
              control: 'heading2',
              mark: 'heading',
              level: 2,
              run: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
            },
            {
              control: 'heading3',
              mark: 'heading',
              level: 3,
              run: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
            },
            {
              control: 'quote',
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
      button.dataset.control = spec.control;
      button.dataset.mark = spec.mark;
      if ('level' in spec && spec.level) button.dataset.level = String(spec.level);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        const held = active();
        if (!held) return;
        onFormat(held.editor, () => spec.run(held.editor));
        refreshToolbar();
      });
      toolbar.append(button);
    }
    translateUi();
  };

  return {
    style,
    toolbar,
    status,
    optionsLocale,
    positionToolbar,
    refreshToolbar,
    translateUi,
    buttons,
  };
}
