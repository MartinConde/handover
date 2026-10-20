<script lang="ts">
import Modal from './Modal.svelte';

let { dismissible = true, panelClass = 'dialog' } = $props<{
  dismissible?: boolean;
  panelClass?: string;
}>();
let open = $state(false);
let nested = $state(false);
</script>

<button type="button" onclick={() => (open = true)}>Open dialog</button>
{#if open}
  <Modal labelledby="modal-title" {dismissible} {panelClass} onclose={() => (open = false)}>
    <h2 id="modal-title">Example dialog</h2>
    <button type="button" onclick={() => (nested = true)}>Open nested dialog</button>
  </Modal>
{/if}
{#if nested}
  <Modal labelledby="nested-title" onclose={() => (nested = false)}>
    <h2 id="nested-title">Nested dialog</h2>
  </Modal>
{/if}
