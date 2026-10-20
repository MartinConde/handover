<script lang="ts">
import type { ComponentProps, Snippet } from 'svelte';
import Modal from './Modal.svelte';

let {
  labelledby,
  describedby,
  role = 'alertdialog',
  initialFocus,
  returnTo,
  title,
  cancel,
  confirm,
  busy = false,
  onconfirm,
  onclose,
  children,
}: Pick<
  ComponentProps<typeof Modal>,
  'labelledby' | 'describedby' | 'role' | 'initialFocus' | 'returnTo' | 'onclose'
> & {
  title: string;
  cancel: string;
  /** The label as it should read now, so a busy state passes its own wording. */
  confirm: string;
  busy?: boolean;
  onconfirm: () => void;
  /** The body, with the element that `describedby` names. */
  children: Snippet;
} = $props();
</script>

<Modal {labelledby} {describedby} {role} {initialFocus} {returnTo} dismissible={!busy} {onclose}>
  <h2 id={labelledby}>{title}</h2>
  {@render children()}
  <div class="actions">
    <button class="btn" type="button" disabled={busy} onclick={onclose}>{cancel}</button>
    <button class="btn btn-danger" type="button" disabled={busy} onclick={onconfirm}>{confirm}</button>
  </div>
</Modal>
