<script lang="ts">
import { onMount } from 'svelte';

let count = 0;
let hydrated = false;

onMount(() => {
  hydrated = true;
});
</script>

<button
  type="button"
  data-client-island
  data-hydrated={String(hydrated)}
  onclick={() => (count += 1)}
>
  Island count {count}
</button>
