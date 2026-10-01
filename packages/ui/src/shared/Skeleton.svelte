<script lang="ts">
// The loading text stays in the tree, so screen readers and tests still read "Loading…".
let {
  label,
  shape = 'rows',
  count = shape === 'lines' ? 3 : 5,
}: { label: string; shape?: 'rows' | 'form' | 'lines'; count?: number } = $props();
const items = $derived(Array.from({ length: count }, (_, i) => i));
</script>

<div class={['skeletons', `is-${shape}`]}>
  <span class="visually-hidden">{label}</span>
  {#if shape === 'form'}
    <span class="skeleton is-title" aria-hidden="true"></span>
  {/if}
  {#each items as item (item)}
    {#if shape === 'rows'}
      <div class="skeleton-row" aria-hidden="true">
        <span class="skeleton {item % 2 ? 'w-40' : 'w-60'}"></span>
        <span class="skeleton w-20"></span>
      </div>
    {:else if shape === 'form'}
      <div class="skeleton-field" aria-hidden="true">
        <span class="skeleton w-20"></span>
        <span class="skeleton is-input"></span>
      </div>
    {:else}
      <span class="skeleton {['w-80', 'w-60', 'w-40'][item % 3]}" aria-hidden="true"></span>
    {/if}
  {/each}
</div>
