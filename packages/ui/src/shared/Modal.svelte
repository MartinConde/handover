<script lang="ts">
import { onMount, type Snippet } from 'svelte';

let {
  labelledby,
  describedby,
  role = 'dialog',
  panelClass = 'dialog',
  scrimClass = '',
  initialFocus,
  returnTo,
  panel = $bindable(),
  dismissible = true,
  onclose,
  children,
}: {
  labelledby: string;
  describedby?: string;
  role?: 'dialog' | 'alertdialog';
  panelClass?: string;
  scrimClass?: string;
  /** A selector inside the panel. The panel itself is the calm default for long dialogs. */
  initialFocus?: string;
  /** Override the opener when the control that was clicked is removed as the dialog opens. */
  returnTo?: HTMLElement | null;
  panel?: HTMLElement;
  /** Busy commits keep their boundary until the result is known. */
  dismissible?: boolean;
  onclose: () => void;
  children: Snippet;
} = $props();

let modal = $state<HTMLDialogElement>();

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function shownControls() {
  return Array.from(panel?.querySelectorAll<HTMLElement>(focusable) ?? []).filter(
    (element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true',
  );
}

function focusFirst() {
  const requested = initialFocus && panel?.querySelector<HTMLElement>(initialFocus);
  (requested || panel)?.focus();
}

function topmost() {
  return Array.from(document.querySelectorAll<HTMLDialogElement>('dialog.modal-host[open]')).at(-1);
}

function globalKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || topmost() !== modal) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (dismissible) onclose();
}

function keydown(event: KeyboardEvent) {
  // A modal is an input boundary too: editor and shell shortcuts do not act through it.
  event.stopPropagation();
  if (event.key === 'Escape') {
    event.preventDefault();
    if (dismissible) onclose();
    return;
  }
  if (event.key !== 'Tab') return;

  const controls = shownControls();
  if (!controls.length) {
    event.preventDefault();
    panel?.focus();
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (
    event.shiftKey &&
    (document.activeElement === first || !modal?.contains(document.activeElement))
  ) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function cancel(event: Event) {
  // Own Escape instead of letting the browser close without updating feature state.
  event.preventDefault();
  event.stopPropagation();
  if (dismissible) onclose();
}

onMount(() => {
  const opener =
    returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  if (typeof modal?.showModal === 'function') modal.showModal();
  else modal?.setAttribute('open', '');
  focusFirst();
  window.addEventListener('keydown', globalKeydown, true);

  return () => {
    window.removeEventListener('keydown', globalKeydown, true);
    if (modal?.open && typeof modal.close === 'function') modal.close();
    if (opener?.isConnected) opener.focus();
    else {
      const remaining = topmost()?.querySelector<HTMLElement>('.modal-panel');
      if (remaining) remaining.focus();
      else document.getElementById('workspace')?.focus();
    }
    queueMicrotask(() => {
      if (!document.activeElement?.isConnected) document.getElementById('workspace')?.focus();
    });
  };
});
</script>

<dialog
  class="modal-host"
  bind:this={modal}
  {role}
  aria-modal="true"
  aria-labelledby={labelledby}
  aria-describedby={describedby}
  oncancel={cancel}
  onkeydown={keydown}
>
  <div class="scrim modal-scrim {scrimClass}">
    <div class="modal-panel {panelClass}" tabindex="-1" bind:this={panel}>
      {@render children()}
    </div>
  </div>
</dialog>
