<script lang="ts">
let {
  src,
  alt = '',
  style = '',
  loading,
}: { src?: string; alt?: string; style?: string; loading?: 'eager' | 'lazy' } = $props();
let failed = $state('');
</script>

{#if !src || failed === src}
  <span class="media-unavailable" role="img" aria-label={src ? 'Image unavailable' : 'No image selected'}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 18 5-5 3 3 4-5 5 6"/></svg>
    <span>{src ? 'Image unavailable' : 'No image selected'}</span>
  </span>
{:else}
  <img {src} {alt} {style} {loading} onerror={() => (failed = src)} />
{/if}
