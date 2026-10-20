<script lang="ts">
import * as m from '../../paraglide/messages.js';
import MediaImage from '../../shared/MediaImage.svelte';
import type { FieldLevel } from './field-level.js';
import PerLanguageInput from './PerLanguageInput.svelte';

let {
  level,
  id,
  at,
  ratio,
  labelledby,
  onframe,
  onreplace,
  onremove,
  locked = false,
}: {
  level: FieldLevel;
  id: string;
  at: readonly string[];
  ratio: string;
  /** Present when the card is the field's own group rather than part of a dialog. */
  labelledby?: string;
  /** Absent for a translation, which owns the alt text and not the picture. */
  onframe?: () => void;
  onreplace?: () => void;
  onremove?: () => void;
  locked?: boolean;
} = $props();
const options = $derived(level.options);
const dot = $derived(level.point(at).map((n) => n * 100));
const key = $derived(level.str([...at, 'src']));
const width = $derived(level.num([...at, 'width']));
const height = $derived(level.num([...at, 'height']));
</script>

{#snippet picture()}<MediaImage src={level.src(at)} alt="" style="object-position: {dot[0]}% {dot[1]}%" uiLocale={level.uiLocale} /><span class="focal" style="left: {dot[0]}%; top: {dot[1]}%" aria-hidden="true"></span>{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- the tabindex is -1 or absent -->
<div class="media-card is-image" id={labelledby ? id : undefined} role={labelledby ? 'group' : undefined} tabindex={labelledby ? -1 : undefined} aria-labelledby={labelledby}>
  {#if onframe}
    <button class="thumb field-image-preview" type="button" aria-label={m.field_picture_set_focal({}, options)} title={m.field_picture_set_focal({}, options)} onclick={onframe} style="aspect-ratio: {ratio}">{@render picture()}</button>
  {:else}
    <span class="thumb" style="aspect-ratio: {ratio}">{@render picture()}</span>
  {/if}
  <div class="meta">
    <div class="field-image-name"><span title={key}>{key.split('/').pop()}</span>{#if width && height}<small>{width} × {height}</small>{/if}</div>
    <PerLanguageInput {level} {id} {at} key="alt" label={m.field_alt_text({}, options)} />
    {#if onframe}
      <div class="actions">
        <button class="btn btn-sm" type="button" onclick={onframe}>{m.field_picture_set_focal({}, options)}</button>
        <button class="btn btn-sm" type="button" onclick={onreplace}>{m.field_replace({}, options)}</button>
        <button class="btn btn-sm btn-ghost btn-icon image-remove" type="button" aria-label={m.field_remove_value({}, options)} title={m.field_remove_value({}, options)} disabled={locked} onclick={onremove}><svg class="field-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" /></svg></button>
      </div>
    {:else}
      <p class="hint">{m.field_picture_same({}, options)}</p>
    {/if}
  </div>
</div>
