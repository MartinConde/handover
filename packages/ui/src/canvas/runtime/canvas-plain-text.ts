import { messageOptions, type UiLocale } from '../../i18n';
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
} from '../canvas-bridge';
import { historyDirection, sameCanvasTarget } from '../canvas-target';
import type { CanvasUiLocaleState } from './canvas-ui-locale';

type PlainField = Extract<CanvasTextField, { kind: 'text' }>;

export interface CanvasPlainTextOptions {
  command: (
    target: CanvasTarget,
    command:
      | { type: 'field'; changes: readonly [{ value: string }]; history: CanvasTextHistory }
      | CanvasHistoryMutation,
  ) => Promise<CanvasAcknowledgement>;
  interaction: (target: CanvasTarget, state: CanvasEditingState) => void;
  root?: Document;
  uiLocale?: CanvasUiLocaleState;
}

const length = (element: HTMLElement) => element.textContent?.length ?? 0;

/** Chrome's UA sheet gives `[contenteditable]` its own wrapping, which re-flows the reader's text
 * the moment editing opens. Hold the rendered values so the line breaks never move. `white-space`
 * stays out: the UA leaves it alone, and a rich-text root needs the `pre-wrap` TipTap gives it. */
const WRAPPING = ['overflow-wrap', 'word-break', 'line-break'] as const;

export const readWrapping = (element: HTMLElement) => {
  const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
  return WRAPPING.map((property) => [property, computed?.getPropertyValue(property)] as const);
};

export const pinWrapping = (element: HTMLElement, rendered = readWrapping(element)) => {
  const held = WRAPPING.map(
    (property) =>
      [
        property,
        element.style.getPropertyValue(property),
        element.style.getPropertyPriority(property),
      ] as const,
  );
  for (const [property, value] of rendered)
    if (value) element.style.setProperty(property, value, 'important');
  return () => {
    for (const [property, value, priority] of held) {
      element.style.removeProperty(property);
      if (value) element.style.setProperty(property, value, priority);
    }
  };
};

const pointOffset = (element: HTMLElement, node: Node | null, offset: number) => {
  if (!node || !element.contains(node)) return length(element);
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  try {
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return length(element);
  }
};

const readSelection = (element: HTMLElement): CanvasTextSelection => {
  const selection = element.ownerDocument.getSelection();
  if (!selection?.rangeCount) return { anchor: length(element), head: length(element) };
  return {
    anchor: pointOffset(element, selection.anchorNode, selection.anchorOffset),
    head: pointOffset(element, selection.focusNode, selection.focusOffset),
  };
};

const textPoint = (element: HTMLElement, wanted: number) => {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, Math.min(length(element), wanted));
  let node = walker.nextNode();
  while (node) {
    const size = node.textContent?.length ?? 0;
    if (remaining <= size) return { node, offset: remaining };
    remaining -= size;
    node = walker.nextNode();
  }
  return { node: element as Node, offset: element.childNodes.length };
};

const restoreSelection = (element: HTMLElement, value: CanvasTextSelection) => {
  const selection = element.ownerDocument.getSelection();
  if (!selection) return;
  const anchor = textPoint(element, value.anchor);
  const head = textPoint(element, value.head);
  try {
    selection.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
  } catch {
    const range = element.ownerDocument.createRange();
    range.setStart(head.node, head.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
};

const replaceSelection = (element: HTMLElement, value: string) => {
  const selection = element.ownerDocument.getSelection();
  if (!selection?.rangeCount || !element.contains(selection.anchorNode)) {
    element.textContent = `${element.textContent ?? ''}${value}`;
    restoreSelection(element, { anchor: length(element), head: length(element) });
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const text = element.ownerDocument.createTextNode(value);
  range.insertNode(text);
  range.setStartAfter(text);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

/** One focused contenteditable surface. It mutates only its annotated element and commits through
 * the versioned parent bridge; the site document never owns persistence or undo. */
export function createCanvasPlainTextRuntime(options: CanvasPlainTextOptions) {
  const root = options.root ?? document;
  let configured: PlainField | undefined;
  let active:
    | {
        element: HTMLElement;
        target: CanvasTarget;
        accepted: string;
        attribute: string | null;
        spellcheck: string | null;
        unpin: () => void;
      }
    | undefined;
  let disposed = false;
  let composing = false;
  let compositionBefore: CanvasTextSelection | undefined;
  let compositionGroup = '';
  let beforeInput: CanvasTextSelection | undefined;
  let generation = 0;
  let queued = 0;
  let lane = Promise.resolve();
  let refusalReason: string | undefined;
  let unsubscribeLocale: (() => void) | undefined;
  const locale = (): UiLocale => options.uiLocale?.current() ?? 'en';

  const style = root.createElement('style');
  style.dataset.handoverCanvasText = '';
  style.textContent = `
    [data-handover-inline-editing]{outline:none!important;caret-color:currentColor!important;cursor:text!important}
    [data-handover-inline-refusal]{outline:1px solid #b42318!important;outline-offset:2px!important}
  `;
  const status = root.createElement('div');
  status.dataset.handoverCanvasTextStatus = '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText =
    'position:fixed;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0';

  const translateUi = (nextLocale = locale()) => {
    status.lang = nextLocale;
    if (refusalReason)
      status.textContent = m.canvas_inline_change_refused(
        { reason: refusalReason },
        messageOptions(nextLocale),
      );
  };

  const publish = (state: CanvasEditingState) => {
    if (active) options.interaction(active.target, state);
  };

  const apply = (value: string, selection?: CanvasTextSelection) => {
    if (!active || composing) return;
    const held = selection ?? readSelection(active.element);
    if (active.element.textContent !== value) active.element.textContent = value;
    restoreSelection(active.element, held);
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
      status.dataset.handoverCanvasTextVersion = String(reply.acceptedVersion);
      delete held.element.dataset.handoverInlineRefusal;
      refusalReason = undefined;
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

  const commit = (kind: CanvasTextHistory['kind'], before: CanvasTextSelection, group?: string) => {
    if (!active) return;
    const value = active.element.textContent ?? '';
    void enqueue(
      {
        type: 'field',
        changes: [{ value }],
        history: {
          kind,
          ...(group ? { group } : {}),
          before,
          after: readSelection(active.element),
        },
      },
      value,
    );
  };

  const deactivate = () => {
    if (!active) return;
    const held = active;
    active = undefined;
    held.element.removeAttribute('data-handover-inline-editing');
    held.element.removeAttribute('data-handover-inline-refusal');
    if (held.attribute === null) held.element.removeAttribute('contenteditable');
    else held.element.setAttribute('contenteditable', held.attribute);
    if (held.spellcheck === null) held.element.removeAttribute('spellcheck');
    else held.element.setAttribute('spellcheck', held.spellcheck);
    held.unpin();
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

  const activate = (selection: CanvasSelection, element: Element, caret?: number) => {
    if (
      disposed ||
      selection.kind !== 'field' ||
      !(element instanceof HTMLElement) ||
      !configured ||
      !sameCanvasTarget(selection.target, configured.target)
    )
      return false;
    if (active?.element === element) return true;
    if (active) deactivate();
    active = {
      element,
      target: configured.target,
      accepted: configured.value,
      attribute: element.getAttribute('contenteditable'),
      spellcheck: element.getAttribute('spellcheck'),
      unpin: pinWrapping(element),
    };
    if (element.textContent !== configured.value) element.textContent = configured.value;
    // `plaintext-only` still fails to emit normal editing events in current WebKit. The paste
    // handler below enforces the same data contract consistently in all supported engines.
    element.setAttribute('contenteditable', 'true');
    element.setAttribute('spellcheck', 'true');
    element.dataset.handoverInlineEditing = '';
    element.focus({ preventScroll: true });
    const point = Math.max(0, Math.min(length(element), caret ?? length(element)));
    restoreSelection(element, { anchor: point, head: point });
    publish({ inlineEditing: true, composing: false });
    return true;
  };

  const onBeforeInput = (raw: Event) => {
    const event = raw as InputEvent;
    if (!active?.element.contains(event.target as Node)) return;
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault();
      void enqueue({
        type: 'history',
        direction: event.inputType === 'historyUndo' ? 'undo' : 'redo',
      });
      return;
    }
    // Plain text has no breaks or marks; the commit reads only textContent and would drop them.
    if (
      event.inputType === 'insertParagraph' ||
      event.inputType === 'insertLineBreak' ||
      event.inputType.startsWith('format')
    ) {
      event.preventDefault();
      return;
    }
    if (event.inputType === 'insertFromDrop') {
      event.preventDefault();
      const before = readSelection(active.element);
      const [drop] = event.getTargetRanges();
      if (drop) {
        const range = active.element.ownerDocument.createRange();
        range.setStart(drop.startContainer, drop.startOffset);
        range.setEnd(drop.endContainer, drop.endOffset);
        active.element.ownerDocument.getSelection()?.removeAllRanges();
        active.element.ownerDocument.getSelection()?.addRange(range);
      }
      replaceSelection(active.element, event.dataTransfer?.getData('text/plain') ?? '');
      commit('paste', before);
      return;
    }
    beforeInput = readSelection(active.element);
  };

  const onInput = (raw: Event) => {
    const event = raw as InputEvent;
    if (!active?.element.contains(event.target as Node) || composing) return;
    const before = beforeInput ?? readSelection(active.element);
    beforeInput = undefined;
    commit(event.inputType === 'insertFromPaste' ? 'paste' : 'typing', before);
  };

  const onPaste = (event: ClipboardEvent) => {
    if (!active?.element.contains(event.target as Node)) return;
    event.preventDefault();
    const before = readSelection(active.element);
    replaceSelection(active.element, event.clipboardData?.getData('text/plain') ?? '');
    commit('paste', before);
  };

  const onCompositionStart = (event: CompositionEvent) => {
    if (!active?.element.contains(event.target as Node)) return;
    composing = true;
    compositionBefore = readSelection(active.element);
    compositionGroup = `composition-${crypto.randomUUID()}`;
    publish({ inlineEditing: true, composing: true });
  };

  const onCompositionEnd = (event: CompositionEvent) => {
    if (!active?.element.contains(event.target as Node) || !composing) return;
    const before = compositionBefore ?? readSelection(active.element);
    const group = compositionGroup;
    composing = false;
    compositionBefore = undefined;
    compositionGroup = '';
    queueMicrotask(() => {
      if (!active) return;
      commit('composition', before, group);
      publish({ inlineEditing: true, composing: false });
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!active?.element.contains(event.target as Node)) return;
    if (event.key === 'Escape') {
      // An IME uses Escape to cancel its own conversion; that must not also close the editor.
      if (event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      finish();
      return;
    }
    if (event.altKey) return;
    const direction = historyDirection(event);
    if (!direction) return;
    event.preventDefault();
    void enqueue({ type: 'history', direction });
  };

  const onFocusOut = (event: FocusEvent) => {
    if (!active || event.target !== active.element) return;
    if (event.relatedTarget instanceof Node && active.element.contains(event.relatedTarget)) return;
    finish();
  };

  return {
    start() {
      if (disposed || style.isConnected) return;
      root.head.append(style);
      root.documentElement.append(status);
      root.addEventListener('beforeinput', onBeforeInput, true);
      root.addEventListener('input', onInput, true);
      root.addEventListener('paste', onPaste, true);
      root.addEventListener('compositionstart', onCompositionStart, true);
      root.addEventListener('compositionend', onCompositionEnd, true);
      root.addEventListener('keydown', onKeyDown, true);
      root.addEventListener('focusout', onFocusOut, true);
      unsubscribeLocale = options.uiLocale?.subscribe(translateUi);
      translateUi();
    },
    configure(field?: PlainField) {
      configured = field;
      if (!active) return;
      if (!field || !sameCanvasTarget(active.target, field.target)) {
        if (!queued && !composing) deactivate();
        else finish();
        return;
      }
      active.accepted = field.value;
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
      root.removeEventListener('beforeinput', onBeforeInput, true);
      root.removeEventListener('input', onInput, true);
      root.removeEventListener('paste', onPaste, true);
      root.removeEventListener('compositionstart', onCompositionStart, true);
      root.removeEventListener('compositionend', onCompositionEnd, true);
      root.removeEventListener('keydown', onKeyDown, true);
      root.removeEventListener('focusout', onFocusOut, true);
      unsubscribeLocale?.();
      unsubscribeLocale = undefined;
      style.remove();
      status.remove();
    },
  };
}
