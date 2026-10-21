<script lang="ts">
import type { ComponentProps, Snippet } from 'svelte';
import Editor from './Editor.svelte';

// Stands in for the shell's top bar, which draws what the Editor hands it.
let props: Omit<ComponentProps<typeof Editor>, 'ontopbar'> = $props();
let bar = $state.raw<{ lead: Snippet; actions: Snippet }>();
</script>

<header class="topbar">
  {#if bar}
    <div class="entry-lead">{@render bar.lead()}</div>
    <div class="entry-actions">{@render bar.actions()}</div>
  {/if}
</header>
<Editor
  {...props}
  ontopbar={(parts) => {
    bar = parts;
    return () => (bar = undefined);
  }}
/>
