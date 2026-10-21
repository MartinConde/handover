<script lang="ts">
import type { Field } from '@handover/core';
import MediaPicker from '../../media/MediaPicker.svelte';
import { fileSize } from '../../media/upload.js';
import * as m from '../../paraglide/messages.js';
import type { FieldLevel } from './field-level.js';
import PerLanguageInput from './PerLanguageInput.svelte';

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
  field: Extract<Field, { type: 'file' }>;
  text: string;
  says?: string;
} = $props();
const options = $derived(level.options);
const kind = $derived(
  (
    level
      .str([...at, 'mime'])
      .split('/')
      .pop() ?? ''
  ).toUpperCase(),
);
</script>

{#if level.translating}
  <!-- The download is one file for every language; what it is called is not. -->
  <div class="media-card is-file" {id} role="group" tabindex="-1" aria-labelledby="{id}-l">
    <div class="file-icon" aria-hidden="true">{kind}</div>
    <div class="meta">
      <div><div class="sub">{level.str([...at, 'src'])}</div></div>
      <PerLanguageInput {level} {id} {at} key="name" label={m.field_display_name({}, options)} />
      <p class="hint">{m.field_file_same({}, options)}</p>
    </div>
  </div>
{:else if level.read(at) !== undefined}
  <div class="media-card is-file" {id} role="group" tabindex="-1" aria-labelledby="{id}-l">
    <div class="file-icon" aria-hidden="true">{kind}</div>
    <div class="meta">
      <div><div class="sub">{level.str([...at, 'src'])} · {fileSize(level.read([...at, 'bytes']) as number | undefined, level.uiLocale)} · {level.str([...at, 'mime'])}</div></div>
      <PerLanguageInput {level} {id} {at} key="name" label={m.field_display_name({}, options)} />
      <div class="actions">
        <button class="btn btn-sm" type="button" onclick={() => (level.picker = id)}>{m.field_replace({}, options)}</button>
        <button class="btn btn-sm btn-ghost" type="button" onclick={() => level.write(at, undefined)}>{m.field_remove_value({}, options)}</button>
      </div>
    </div>
  </div>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -- the child button is the control -->
  <div class="dropzone" role="group" aria-labelledby="{id}-l" aria-describedby={says} ondragover={(e) => e.preventDefault()} ondrop={(e) => level.dropOn(id, e)}>
    <span>{m.field_file_drop({}, options)}</span>
    <span class="hint">{m.field_file_types({ formats: field.accept.map((mime) => (mime.split('/').pop() ?? '').toUpperCase()).join(', ') }, options)}</span>
    <button class="btn btn-sm" type="button" onclick={() => (level.picker = id)}>{m.field_picture_choose({}, options)}</button>
  </div>
{/if}
{#if level.picker === id}
  <MediaPicker
    kind="files"
    label={text}
    preset={{}}
    accept={field.accept}
    base={level.mediaBase}
    dropped={level.dropped}
    uiLocale={level.uiLocale}
    onpick={(items) => level.picked(at, 'file', items)}
    onclose={() => { level.picker = ''; level.dropped = []; }}
  />
{/if}
