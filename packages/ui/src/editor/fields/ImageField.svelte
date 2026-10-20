<script lang="ts">
import type { Field } from '@handover/core';
import Focal from '../../media/Focal.svelte';
import Media from '../../media/Media.svelte';
import * as m from '../../paraglide/messages.js';
import { aspect, centred, type FieldLevel } from './field-level.js';
import ImageCard from './ImageCard.svelte';

let {
  level,
  id,
  at,
  field,
  text,
  says,
}: {
  level: FieldLevel;
  id: string;
  at: readonly string[];
  field: Extract<Field, { type: 'image' }>;
  text: string;
  says?: string;
} = $props();
const options = $derived(level.options);
let framing = $state(false);
</script>

{#if level.translating}
  <!-- A translation owns the words and not the picture: the alt, and nothing else. -->
  <ImageCard {level} {id} {at} ratio={aspect(field.preset)} labelledby="{id}-l" />
{:else if level.read(at) !== undefined}
  <ImageCard
    {level}
    {id}
    {at}
    ratio={aspect(field.preset)}
    labelledby="{id}-l"
    onframe={() => (framing = true)}
    onreplace={() => (level.picker = id)}
    onremove={() => level.write(at, undefined)}
  />
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -- the child button is the control -->
  <div
    class="dropzone"
    role="group"
    aria-labelledby="{id}-l"
    aria-describedby={says}
    ondragover={(e) => e.preventDefault()}
    ondrop={(e) => level.dropOn(id, e)}
  >
    <span>{m.field_image_drop({}, options)}</span>
    {#if field.preset.ratio || field.preset.min}<span class="hint"
        >{[
          field.preset.ratio,
          field.preset.min && m.field_image_min_width({ min: field.preset.min }, options),
        ]
          .filter(Boolean)
          .join(' · ')}</span
      >{/if}
    <span class="hint">{m.field_image_formats({ max: field.preset.max ?? 2400 }, options)}</span>
    <button class="btn btn-sm" type="button" onclick={() => (level.picker = id)}
      >{m.field_picture_choose({}, options)}</button
    >
  </div>
{/if}
{#if framing}
  <!-- The page's own dot wins over the library's default and is the same in every language. -->
  <Focal
    name={text}
    url={level.src(at)}
    focal={level.point(at)}
    presets={field.preset.ratio ? [{ label: text, preset: field.preset }] : []}
    uiLocale={level.uiLocale}
    onsave={(moved) => { level.write([...at, 'focal'], centred(moved) ? undefined : moved); framing = false; }}
    onclose={() => (framing = false)}
  />
{/if}
{#if level.picker === id}
  <Media
    kind="images"
    label={text}
    preset={field.preset}
    accept={[]}
    base={level.mediaBase}
    dropped={level.dropped}
    uiLocale={level.uiLocale}
    onpick={(items) => level.picked(at, 'image', items)}
    onclose={() => { level.picker = ''; level.dropped = []; }}
  />
{/if}
