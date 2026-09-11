import { unsafeLinkScheme } from '@handover/core';
import {
  createEntryDirectoryReader,
  type Pickable,
  type PickEntry,
} from '../../entry-directory';

export interface CanvasLinkDraft {
  type: 'entry' | 'url';
  ref: string;
  href: string;
  label: string;
  newTab: boolean;
}

type CloseReason = 'applied' | 'cancel' | 'outside' | 'removed';

export interface CanvasLinkEditorOpen {
  anchor: Element | (() => DOMRect);
  value: CanvasLinkDraft;
  locale: string;
  label?: string;
  allowLabel?: boolean;
  allowNewTab?: boolean;
  allowRemove?: boolean;
  onApply: (value: CanvasLinkDraft) => string | undefined | Promise<string | undefined>;
  onRemove?: () => void | Promise<void>;
  onClose?: (reason: CloseReason) => void;
}

export interface CanvasLinkEditorOptions {
  root?: Document;
  owner?: Window;
  readDirectory?: () => Promise<Pickable>;
}

const copy = (value: CanvasLinkDraft): CanvasLinkDraft => ({ ...value });

/** A site-style-proof link editor shared by rich-text links and schema link fields in Canvas. */
export function createCanvasLinkEditor(options: CanvasLinkEditorOptions = {}) {
  const root = options.root ?? document;
  const owner = options.owner ?? window;
  const fallbackDirectory = createEntryDirectoryReader(owner.fetch.bind(owner));
  const readDirectory = options.readDirectory ?? fallbackDirectory.read;
  const style = root.createElement('style');
  style.dataset.handoverCanvasLinkEditorStyle = '';
  style.textContent = `
    [data-handover-canvas-link-editor]{all:initial;position:fixed;z-index:2147483647;box-sizing:border-box;display:grid;width:min(360px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;gap:16px;padding:16px;border:1px solid #e5e8e5;border-radius:12px;background:#fff;color:#202420;box-shadow:0 12px 36px rgb(23 26 33/.18);font:400 14px/1.45 system-ui,sans-serif;text-align:left;color-scheme:light}
    [data-handover-canvas-link-editor][hidden]{display:none}
    [data-handover-canvas-link-editor] *{box-sizing:border-box}
    [data-handover-canvas-link-editor] header{display:flex;align-items:center;gap:12px}
    [data-handover-canvas-link-editor] h2{all:initial;flex:1;color:#202420;font:600 15px/1.3 system-ui,sans-serif}
    [data-handover-canvas-link-editor] label,[data-handover-canvas-link-editor] legend{all:initial;display:block;margin:0 0 6px;color:#5b635d;font:500 12px/1.4 system-ui,sans-serif}
    [data-handover-canvas-link-editor] fieldset{all:initial;display:grid;min-width:0}
    [data-handover-canvas-link-editor] input[type="text"],[data-handover-canvas-link-editor] input[type="url"],[data-handover-canvas-link-editor] input[type="search"]{all:initial;box-sizing:border-box;width:100%;min-height:38px;padding:7px 10px;border:1px solid #89938b;border-radius:7px;background:#fff;color:#202420;font:400 14px/1.4 system-ui,sans-serif}
    [data-handover-canvas-link-editor] input:focus{outline:2px solid #537e2c;outline-offset:1px;border-color:#537e2c}
    [data-handover-canvas-link-editor] input[aria-invalid="true"]{border-color:#c0271b}
    [data-handover-canvas-link-editor] button{all:initial;box-sizing:border-box;display:inline-flex;min-height:34px;align-items:center;justify-content:center;padding:0 12px;border:1px solid #e5e8e5;border-radius:7px;background:#fff;color:#202420;font:500 13px/1 system-ui,sans-serif;cursor:pointer}
    [data-handover-canvas-link-editor] button:hover{background:#f7f8f7}
    [data-handover-canvas-link-editor] button:focus-visible{outline:2px solid #537e2c;outline-offset:2px}
    [data-handover-canvas-link-editor] button:disabled{color:#69726b;background:#f7f8f7;cursor:not-allowed}
    [data-handover-canvas-link-editor] [data-link-close]{min-height:28px;padding:0 8px;border-color:transparent;color:#5b635d}
    [data-handover-canvas-link-editor] [data-link-tabs]{display:grid;grid-template-columns:1fr 1fr;gap:3px;padding:3px;border-radius:7px;background:#f7f8f7}
    [data-handover-canvas-link-editor] [data-link-tabs] button{border:0;background:transparent;box-shadow:none}
    [data-handover-canvas-link-editor] [data-link-tabs] button[aria-pressed="true"]{background:#fff;box-shadow:0 1px 2px rgb(23 26 33/.1)}
    [data-handover-canvas-link-editor] [data-link-destination]{display:grid;gap:10px}
    [data-handover-canvas-link-editor] [data-link-results]{display:grid;max-height:176px;overflow:auto;gap:2px;padding:3px;border:1px solid #e5e8e5;border-radius:7px;scrollbar-gutter:stable}
    [data-handover-canvas-link-editor] [data-link-results] button{display:grid;height:auto;min-height:44px;justify-content:stretch;gap:1px;padding:7px 9px;border:0;text-align:left}
    [data-handover-canvas-link-editor] [data-link-results] button[aria-selected="true"]{background:#eef5e4;color:#42651f}
    [data-handover-canvas-link-editor] [data-link-results] strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
    [data-handover-canvas-link-editor] [data-link-results] small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#69726b;font:400 11px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    [data-handover-canvas-link-editor] [data-link-empty]{margin:0;padding:12px;color:#69726b;font-size:12px;text-align:center}
    [data-handover-canvas-link-editor] [data-link-check]{display:flex;align-items:center;gap:9px;margin:0;color:#202420;font-size:13px;cursor:pointer}
    [data-handover-canvas-link-editor] [data-link-check] input{width:17px;height:17px;margin:0;accent-color:#537e2c}
    [data-handover-canvas-link-editor] [data-link-error]{margin:6px 0 0;color:#b42318;font-size:12px}
    [data-handover-canvas-link-editor] [data-link-actions]{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:2px}
    [data-handover-canvas-link-editor] [data-link-remove]{margin-right:auto;border-color:transparent;color:#b42318}
    [data-handover-canvas-link-editor] [data-link-apply]{border-color:#c1ee67;background:#c1ee67;color:#23320f;font-weight:600}
    [data-handover-canvas-link-editor] [data-link-apply]:hover{border-color:#b2df58;background:#b2df58}
    @media (prefers-reduced-motion:no-preference){[data-handover-canvas-link-editor]{animation:handover-link-in 140ms cubic-bezier(.16,1,.3,1)}}
    @keyframes handover-link-in{from{opacity:.7;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
  `;

  const panel = root.createElement('div');
  panel.dataset.handoverCanvasLinkEditor = '';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.hidden = true;

  let opened: CanvasLinkEditorOpen | undefined;
  let draft: CanvasLinkDraft | undefined;
  let directory: PickEntry[] | undefined;
  let touchedDestination = false;

  const anchorBounds = () => {
    if (!opened) return new DOMRect();
    return typeof opened.anchor === 'function'
      ? opened.anchor()
      : opened.anchor.getBoundingClientRect();
  };

  const position = () => {
    if (!opened || panel.hidden) return;
    const anchor = anchorBounds();
    const bounds = panel.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, owner.innerWidth - bounds.width - 8));
    const below = anchor.bottom + 8;
    const top =
      below + bounds.height <= owner.innerHeight - 8
        ? below
        : Math.max(8, anchor.top - bounds.height - 8);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };

  const loadDirectory = () =>
    readDirectory().then((value) => [...(value.indexes ?? []), ...value.entries]);

  const field = (label: string, input: HTMLInputElement) => {
    const wrapper = root.createElement('div');
    const caption = root.createElement('label');
    caption.textContent = label;
    caption.htmlFor = input.id;
    wrapper.append(caption, input);
    return wrapper;
  };

  const makeButton = (label: string, action: () => void) => {
    const button = root.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  };

  const close = (reason: CloseReason = 'cancel') => {
    const held = opened;
    opened = undefined;
    draft = undefined;
    panel.hidden = true;
    panel.replaceChildren();
    held?.onClose?.(reason);
  };

  const draw = (focus: 'label' | 'search' | 'url' | 'apply' = 'label') => {
    if (!opened || !draft) return;
    panel.replaceChildren();
    panel.setAttribute('aria-label', opened.label ?? 'Edit link');

    const heading = root.createElement('header');
    const title = root.createElement('h2');
    title.textContent = opened.label ?? 'Edit link';
    const closeButton = makeButton('Close', () => close('cancel'));
    closeButton.dataset.linkClose = '';
    heading.append(title, closeButton);
    panel.append(heading);

    let labelInput: HTMLInputElement | undefined;
    if (opened.allowLabel) {
      labelInput = root.createElement('input');
      labelInput.type = 'text';
      labelInput.id = 'handover-canvas-link-label';
      labelInput.value = draft.label;
      labelInput.addEventListener('input', () => {
        if (draft) draft.label = labelInput?.value ?? '';
      });
      panel.append(field('Label', labelInput));
    }

    const destination = root.createElement('fieldset');
    destination.dataset.linkDestination = '';
    const legend = root.createElement('legend');
    legend.textContent = 'Destination';
    const tabs = root.createElement('div');
    tabs.dataset.linkTabs = '';
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Link destination type');
    const entryTab = makeButton('Page / Entry', () => {
      if (!draft || draft.type === 'entry') return;
      touchedDestination = true;
      draft.type = 'entry';
      draw('search');
    });
    entryTab.setAttribute('aria-pressed', String(draft.type === 'entry'));
    const urlTab = makeButton('URL', () => {
      if (!draft || draft.type === 'url') return;
      touchedDestination = true;
      draft.type = 'url';
      draw('url');
    });
    urlTab.setAttribute('aria-pressed', String(draft.type === 'url'));
    tabs.append(entryTab, urlTab);
    destination.append(legend, tabs);

    let destinationInput: HTMLInputElement | undefined;
    if (draft.type === 'url') {
      destinationInput = root.createElement('input');
      destinationInput.type = 'url';
      destinationInput.id = 'handover-canvas-link-url';
      destinationInput.placeholder = '/contact or https://…';
      destinationInput.value = draft.href;
      const urlField = field('Address', destinationInput);
      const error = root.createElement('p');
      error.dataset.linkError = '';
      error.hidden = true;
      const validate = () => {
        if (!draft || !destinationInput) return;
        draft.href = destinationInput.value;
        const refused = unsafeLinkScheme('default', draft.href);
        destinationInput.setAttribute('aria-invalid', String(Boolean(refused)));
        error.hidden = !refused;
        error.textContent = refused ? `${refused}: links are not allowed` : '';
        updateApply();
      };
      destinationInput.addEventListener('input', validate);
      urlField.append(error);
      destination.append(urlField);
    } else {
      destinationInput = root.createElement('input');
      destinationInput.type = 'search';
      destinationInput.id = 'handover-canvas-link-search';
      destinationInput.placeholder = 'Search pages and entries';
      destinationInput.setAttribute('aria-label', 'Search pages and entries');
      const results = root.createElement('div');
      results.dataset.linkResults = '';
      results.setAttribute('role', 'listbox');
      results.setAttribute('aria-label', 'Pages and entries');
      const paintResults = () => {
        if (!draft || !destinationInput) return;
        results.replaceChildren();
        if (!directory) {
          const loading = root.createElement('p');
          loading.dataset.linkEmpty = '';
          loading.textContent = 'Loading pages…';
          results.append(loading);
          return;
        }
        const query = destinationInput.value.trim().toLocaleLowerCase();
        const matches = directory
          .filter(
            (entry) =>
              !query ||
              entry.title.toLocaleLowerCase().includes(query) ||
              entry.path.toLocaleLowerCase().includes(query),
          )
          .slice(0, 30);
        for (const entry of matches) {
          const url = entry.urls[opened?.locale ?? ''];
          if (!url) continue;
          const row = makeButton(entry.title, () => {
            if (!draft) return;
            touchedDestination = true;
            draft.type = 'entry';
            draft.ref = entry.path;
            draft.href = url;
            paintResults();
            updateApply();
          });
          row.setAttribute('role', 'option');
          row.setAttribute('aria-selected', String(entry.path === draft.ref));
          const name = root.createElement('strong');
          name.textContent = entry.title;
          const path = root.createElement('small');
          path.textContent = url;
          row.replaceChildren(name, path);
          results.append(row);
        }
        if (!results.childElementCount) {
          const empty = root.createElement('p');
          empty.dataset.linkEmpty = '';
          empty.textContent = query
            ? `Nothing matches “${destinationInput.value.trim()}”`
            : 'No pages are available';
          results.append(empty);
        }
      };
      destinationInput.addEventListener('input', paintResults);
      destination.append(destinationInput, results);
      void loadDirectory()
        .then((entries) => {
          if (!opened || !draft || panel.hidden) return;
          directory = entries;
          if (!touchedDestination && draft.type === 'url' && draft.href) {
            const match = entries.find((entry) => entry.urls[opened?.locale ?? ''] === draft?.href);
            if (match) {
              draft.type = 'entry';
              draft.ref = match.path;
            }
          }
          paintResults();
          updateApply();
          position();
        })
        .catch(() => {
          if (!opened || !draft || panel.hidden) return;
          directory = [];
          paintResults();
          updateApply();
          position();
        });
      paintResults();
    }
    panel.append(destination);

    if (opened.allowNewTab) {
      const check = root.createElement('label');
      check.dataset.linkCheck = '';
      const checkbox = root.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = draft.newTab;
      checkbox.addEventListener('change', () => {
        if (draft) draft.newTab = checkbox.checked;
      });
      check.append(checkbox, root.createTextNode('Open in new tab'));
      panel.append(check);
    }

    const message = root.createElement('p');
    message.dataset.linkError = '';
    message.setAttribute('role', 'alert');
    message.hidden = true;
    panel.append(message);

    const actions = root.createElement('div');
    actions.dataset.linkActions = '';
    if (opened.allowRemove && opened.onRemove) {
      const remove = makeButton('Remove link', async () => {
        remove.disabled = true;
        try {
          await opened?.onRemove?.();
          close('removed');
        } catch {
          remove.disabled = false;
          message.hidden = false;
          message.textContent = 'This link could not be removed.';
          position();
        }
      });
      remove.dataset.linkRemove = '';
      actions.append(remove);
    }
    actions.append(makeButton('Cancel', () => close('cancel')));
    const apply = makeButton('Apply', async () => {
      if (!opened || !draft) return;
      apply.disabled = true;
      apply.textContent = 'Applying…';
      let error: string | undefined;
      try {
        error = await opened.onApply(copy(draft));
      } catch {
        error = 'This link could not be updated.';
      }
      if (!opened || !draft) return;
      if (!error) return close('applied');
      message.hidden = false;
      message.textContent = error;
      apply.textContent = 'Apply';
      updateApply();
      position();
    });
    apply.dataset.linkApply = '';
    actions.append(apply);
    panel.append(actions);

    function updateApply() {
      const refused = draft?.type === 'url' ? unsafeLinkScheme('default', draft.href) : undefined;
      apply.disabled = Boolean(
        !draft ||
          refused ||
          (draft.type === 'url' ? !draft.href.trim() : !draft.ref.trim()) ||
          (opened?.allowLabel && !draft.label.trim()),
      );
    }
    updateApply();
    panel.hidden = false;
    position();
    owner.requestAnimationFrame(position);
    const focused =
      focus === 'apply'
        ? apply
        : focus === 'search' || focus === 'url'
          ? destinationInput
          : (labelInput ?? destinationInput ?? apply);
    focused?.focus({ preventScroll: true });
    if (focused instanceof HTMLInputElement) focused.select();
  };

  const outside = (event: PointerEvent) => {
    if (!opened || panel.hidden || !(event.target instanceof Node) || panel.contains(event.target))
      return;
    const anchor = opened.anchor;
    if (anchor instanceof Element && anchor.contains(event.target)) return;
    close('outside');
  };
  const keydown = (event: KeyboardEvent) => {
    if (!opened || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close('cancel');
  };

  root.head.append(style);
  root.documentElement.append(panel);
  root.addEventListener('pointerdown', outside, true);
  root.addEventListener('keydown', keydown, true);
  root.addEventListener('scroll', position, true);
  owner.addEventListener('resize', position);

  return {
    open(value: CanvasLinkEditorOpen) {
      opened = value;
      draft = copy(value.value);
      touchedDestination = false;
      draw(value.allowLabel ? 'label' : value.value.type === 'entry' ? 'search' : 'url');
    },
    close,
    active: () => Boolean(opened && !panel.hidden),
    contains: (node: Node) => panel.contains(node),
    dispose() {
      opened = undefined;
      draft = undefined;
      root.removeEventListener('pointerdown', outside, true);
      root.removeEventListener('keydown', keydown, true);
      root.removeEventListener('scroll', position, true);
      owner.removeEventListener('resize', position);
      panel.remove();
      style.remove();
    },
  };
}
