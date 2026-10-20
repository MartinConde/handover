<script lang="ts">
import {
  EMBED_LABELS,
  type EmbedRefusalReason,
  type EmbedValue,
  embedThumb,
  type Field,
  parseEmbedUrl,
} from '@handover/core';
import { tick } from 'svelte';
import * as m from '../../paraglide/messages.js';
import MediaImage from '../../shared/MediaImage.svelte';
import type { FieldLevel } from './field-level.js';
import PerLanguageInput from './PerLanguageInput.svelte';

let {
  level,
  id,
  at,
  field,
  text,
  says,
  bad,
  pasting = $bindable(),
  refused = $bindable(),
}: {
  level: FieldLevel;
  id: string;
  at: readonly string[];
  field: Extract<Field, { type: 'embed' }>;
  text: string;
  says?: string;
  bad?: 'true';
  /** Which embed field of the level has the paste box open over a value it already holds. */
  pasting: string;
  /** The level's last paste that was not a link we know, and the field it was made in. */
  refused: { id: string; reason?: EmbedRefusalReason };
} = $props();
const options = $derived(level.options);

// A hand-edited file can hold anything under an embed key; half a value draws no card.
const value = $derived.by(() => {
  const v = level.read(at) as EmbedValue | undefined;
  return v && typeof v.id === 'string' && v.provider in EMBED_LABELS ? v : undefined;
});

// A control that replaces itself would drop focus, so focus follows onto its replacement.
const focusOn = (elementId: string) =>
  void tick().then(() => document.getElementById(elementId)?.focus());

// A mistyped link must never empty the field; a recognised one replaces the title too.
function paste(input: HTMLInputElement) {
  refused = { id: '' };
  if (!input.value.trim()) return;
  const parsed = parseEmbedUrl(input.value);
  if ('refused' in parsed) {
    refused = { id, reason: parsed.reason };
    return;
  }
  const { provider, id: chosen, start } = parsed.embed;
  // `title` and `start` are holes so each keeps its place in the file once typed.
  level.write(at, { provider, id: chosen, title: undefined, start });
  input.value = '';
  pasting = '';
  focusOn(`${id}-change`);
}
const refusal = (reason: EmbedRefusalReason | undefined) => {
  if (reason === 'shortened-map') return m.field_embed_shortened_map({}, options);
  if (reason === 'embed-code') return m.field_embed_code({}, options);
  if (reason === 'map-view') return m.field_embed_map_view({}, options);
  return m.field_embed_unknown({}, options);
};
</script>

{#snippet label()}
  <div class="label-row"><span id="{id}-l">{text}{#if field.required}<span class="req" aria-hidden="true">*</span>{/if}</span></div>
{/snippet}

{#snippet thumbnail(value: EmbedValue)}
  {@const still = embedThumb(value)}
  <span class="thumb" style="aspect-ratio: 16 / 9">{#if still}<MediaImage src={still} alt="" loading="lazy" uiLocale={level.uiLocale} />{/if}</span>
{/snippet}

{#if level.translating}
  <!-- A translation owns the words and not the video: the title, and nothing else. -->
  {@render label()}
  {#if value}
    <div class="media-card" {id} role="group" aria-labelledby="{id}-l">
      {@render thumbnail(value)}
      <div class="meta">
        <div><div class="name"><span class="badge badge-info">{EMBED_LABELS[value.provider]}</span> <span class="sub">{value.id}</span></div></div>
        <PerLanguageInput {level} {id} {at} key="title" label={m.field_title({}, options)} />
        <p class="hint">{m.field_video_same({}, options)}</p>
      </div>
    </div>
  {:else}
    <p class="hint" {id}>{m.field_list_empty({}, options)}</p>
  {/if}
{:else}
  {#if value && pasting !== id}
    {@render label()}
  {:else}
    <div class="label-row"><label for={id} id="{id}-l">{text}{#if field.required}<span class="req" aria-hidden="true">*</span>{/if}</label></div>
    <input class="input" {id} type="url" placeholder={m.field_embed_placeholder({}, options)} aria-invalid={refused.id === id ? 'true' : bad} aria-describedby={[refused.id === id ? `${id}-paste` : '', value ? `${id}-keep` : '', says].filter(Boolean).join(' ') || undefined} oninput={(e) => paste(e.currentTarget)} />
    {#if refused.id === id}<p class="error" id="{id}-paste">{refusal(refused.reason)}</p>{/if}
    {#if value}<p class="hint" id="{id}-keep">{m.field_embed_keep_hint({}, options)}</p>{/if}
  {/if}
  {#if value}
    <div class="media-card" id={pasting === id ? undefined : id} role="group" aria-labelledby="{id}-l" aria-describedby={pasting === id ? undefined : says}>
      {@render thumbnail(value)}
      <div class="meta">
        <div><div class="name"><span class="badge badge-info">{EMBED_LABELS[value.provider]}</span> <span class="sub">{value.id}</span></div></div>
        {#if pasting === id}
          <div class="actions"><button class="btn btn-sm btn-ghost" type="button" onclick={() => { pasting = ''; refused = { id: '' }; focusOn(`${id}-change`); }}>{m.field_embed_keep({}, options)}</button></div>
        {:else}
          <PerLanguageInput {level} {id} {at} key="title" label={m.field_title({}, options)} />
          {#if value.provider !== 'google-maps'}
            <div class="field"><div class="label-row"><label for="{id}.start">{m.field_embed_start({}, options)}</label></div><input class="input" id="{id}.start" type="number" min="0" step="1" aria-describedby="{id}.start-hint" value={level.num([...at, 'start'])} oninput={(e) => level.write([...at, 'start'], e.currentTarget.value === '' ? undefined : e.currentTarget.valueAsNumber)} /><p class="hint" id="{id}.start-hint">{m.field_embed_seconds_optional({}, options)}</p></div>
          {/if}
          <div class="actions">
            <button class="btn btn-sm" id="{id}-change" type="button" onclick={() => { pasting = id; focusOn(id); }}>{m.field_change({}, options)}</button>
            <button class="btn btn-sm btn-ghost" type="button" onclick={() => { level.write(at, undefined); pasting = ''; focusOn(id); }}>{m.field_remove_value({}, options)}</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
{/if}
