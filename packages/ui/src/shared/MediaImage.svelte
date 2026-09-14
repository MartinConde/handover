<script lang="ts">
import { messageOptions, type UiLocale } from '../i18n';
import * as m from '../paraglide/messages.js';

let {
  src,
  alt = '',
  style = '',
  loading,
  uiLocale = 'en',
}: {
  src?: string;
  alt?: string;
  style?: string;
  loading?: 'eager' | 'lazy';
  uiLocale?: UiLocale;
} = $props();
let failed = $state('');
const fallback = $derived(
  src
    ? m.media_image_unavailable({}, messageOptions(uiLocale))
    : m.media_image_not_selected({}, messageOptions(uiLocale)),
);
</script>

{#if !src || failed === src}
  <span class="media-unavailable" role="img" aria-label={fallback}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 18 5-5 3 3 4-5 5 6"/></svg>
    <span>{fallback}</span>
  </span>
{:else}
  <img {src} {alt} {style} {loading} onerror={() => (failed = src)} />
{/if}
