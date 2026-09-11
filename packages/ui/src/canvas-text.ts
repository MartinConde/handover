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
}

const sameDocument = (
  a: { collection: string; id: string },
  b: { collection: string; id: string },
) => a.collection === b.collection && a.id === b.id;

const sameLocation = (
  a: { document: { collection: string; id: string }; locale: string; address: string } | undefined,
  b: { document: { collection: string; id: string }; locale: string; address: string } | undefined,
) =>
  a === b ||
  (!!a &&
    !!b &&
    sameDocument(a.document, b.document) &&
    a.locale === b.locale &&
    a.address === b.address);

const sameTarget = (a: CanvasTarget, b: CanvasTarget) =>
  sameLocation(a, b) && sameLocation(a.occurrence, b.occurrence);

const length = (element: HTMLElement) => element.textContent?.length ?? 0;

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
  let requested: { selection: CanvasSelection; element: HTMLElement } | undefined;
  let active:
    | {
        element: HTMLElement;
        target: CanvasTarget;
        accepted: string;
        attribute: string | null;
        spellcheck: string | null;
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
      status.dataset.handoverCanvasTextVersion = String(reply.acceptedVersion);
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
    if (disposed || selection.kind !== 'field' || !(element instanceof HTMLElement)) return false;
    if (!configured || !sameTarget(selection.target, configured.target)) {
      requested = { selection, element };
      return true;
    }
    requested = undefined;
    if (active?.element === element) return true;
    if (active) deactivate();
    active = {
      element,
      target: configured.target,
      accepted: configured.value,
      attribute: element.getAttribute('contenteditable'),
      spellcheck: element.getAttribute('spellcheck'),
    };
    if (element.textContent !== configured.value) element.textContent = configured.value;
    // `plaintext-only` still fails to emit normal editing events in current WebKit. The paste
    // handler below enforces the same data contract consistently in all supported engines.
    element.setAttribute('contenteditable', 'true');
    element.setAttribute('spellcheck', 'true');
    element.dataset.handoverInlineEditing = '';
    element.focus({ preventScroll: true });
    restoreSelection(element, { anchor: length(element), head: length(element) });
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
      event.preventDefault();
      event.stopPropagation();
      finish();
      return;
    }
    const modifier = event.metaKey || event.ctrlKey;
    if (!modifier || event.altKey || event.key.toLowerCase() !== 'z') return;
    event.preventDefault();
    void enqueue({ type: 'history', direction: event.shiftKey ? 'redo' : 'undo' });
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
    },
    configure(field?: PlainField) {
      configured = field;
      const pending = requested;
      if (pending) {
        if (field && sameTarget(pending.selection.target, field.target)) {
          requested = undefined;
          activate(pending.selection, pending.element);
        } else if (!field) {
          requested = undefined;
        }
      }
      if (!active) return;
      if (!field || !sameTarget(active.target, field.target)) {
        if (!queued && !composing) deactivate();
        else finish();
        return;
      }
      active.accepted = field.value;
      if (!queued && !composing) apply(field.value);
    },
    requestActivation(selection: CanvasSelection, element: Element) {
      if (disposed || selection.kind !== 'field' || !(element instanceof HTMLElement)) return false;
      configured = undefined;
      requested = { selection, element };
      return true;
    },
    activate,
    active: () => active !== undefined,
    composing: () => composing,
    dispose() {
      if (disposed) return;
      disposed = true;
      requested = undefined;
      generation += 1;
      if (active) deactivate();
      root.removeEventListener('beforeinput', onBeforeInput, true);
      root.removeEventListener('input', onInput, true);
      root.removeEventListener('paste', onPaste, true);
      root.removeEventListener('compositionstart', onCompositionStart, true);
      root.removeEventListener('compositionend', onCompositionEnd, true);
      root.removeEventListener('keydown', onKeyDown, true);
      root.removeEventListener('focusout', onFocusOut, true);
      style.remove();
      status.remove();
    },
  };
}
