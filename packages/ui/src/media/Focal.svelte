<script lang="ts">
import type { Labels, Preset } from '@handover/core';
import type { UiLocale } from '../i18n.js';
import { messageOptions } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import Modal from '../shared/Modal.svelte';

let {
  name,
  url,
  focal,
  presets = [],
  uiLocale = 'en',
  onsave,
  onclose,
}: {
  /** What the heading calls the picture: its file name in the library. */
  name: string;
  url: string;
  focal: [number, number];
  /** The crops this dot is previewed in: the whole site's in the library. */
  presets?: { label: string; labels?: Labels; preset: Preset }[];
  uiLocale?: UiLocale;
  onsave: (focal: [number, number]) => void;
  onclose: () => void;
} = $props();

// svelte-ignore state_referenced_locally -- the dialog edits an initial snapshot
let across = $state(Math.round(focal[0] * 100));
// svelte-ignore state_referenced_locally -- the dialog edits an initial snapshot
let down = $state(Math.round(focal[1] * 100));
let stage = $state<HTMLElement>();

// A phone holds a picture upright whatever the site's fields crop to.
const options = $derived(messageOptions(uiLocale));
const phone = $derived<(typeof presets)[number]>({
  label: m.focal_phone_upright({}, options),
  preset: { ratio: '9:16' } as Preset,
});
const shapes = $derived(
  presets.some((p) => p.preset.ratio === phone.preset.ratio) ? presets : [...presets, phone],
);

function point(e: PointerEvent) {
  const box = stage?.getBoundingClientRect();
  if (!box?.width || !box.height) return;
  across = Math.round(Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1) * 100);
  down = Math.round(Math.min(Math.max((e.clientY - box.top) / box.height, 0), 1) * 100);
}

function grab(e: PointerEvent) {
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  point(e);
}

// The keyboard's way to the same two numbers: a step of one, ten with Shift.
function nudge(e: KeyboardEvent) {
  const step = e.shiftKey ? 10 : 1;
  const clamp = (n: number) => Math.min(Math.max(n, 0), 100);
  if (e.key === 'ArrowLeft') across = clamp(across - step);
  else if (e.key === 'ArrowRight') across = clamp(across + step);
  else if (e.key === 'ArrowUp') down = clamp(down - step);
  else if (e.key === 'ArrowDown') down = clamp(down + step);
  else return;
  e.preventDefault();
}

const aspect = (preset: Preset) => preset.ratio?.replace(':', ' / ') ?? '4 / 3';
</script>

<Modal labelledby="focal-h" panelClass="dialog focal-dialog" {onclose}>
    <h2 id="focal-h">{m.focal_title({ name }, options)}</h2>
    <p>{m.focal_intro({}, options)}</p>
    <div class="dialog-cols">
      <div>
        <!-- svelte-ignore a11y_no_static_element_interactions -- the handle is the control -->
        <div class="focal-stage" bind:this={stage} onpointerdown={grab} onpointermove={(e) => e.buttons === 1 && point(e)}>
          <img src={url} alt="" draggable="false" />
          <button
            class="focal-handle"
            type="button"
            style="left: {across}%; top: {down}%"
            aria-label={m.focal_position({ across, down }, options)}
            onkeydown={nudge}
          ></button>
        </div>
      </div>
      <div class="side-note">
        <p><b>{m.focal_preview_intro({}, options)}</b></p>
        <p>{m.focal_page_hint({}, options)}</p>
      </div>
    </div>
    {#if presets.length}
      <h3 class="variant-title">{m.focal_live_previews({}, options)}</h3>
      <div class="ratio-strip">
        {#each shapes as p (p.preset.ratio)}
          <div class="ratio-item">
            <div class="ratio-preview" style="aspect-ratio: {aspect(p.preset)}">
              <img src={url} alt="" style="object-position: {across}% {down}%" />
            </div>
            <span class="lbl">{p.preset.ratio}</span>
            <span class="sub">{[p.labels?.[uiLocale] ?? p.label, p.preset.max && `${p.preset.max} px`].filter(Boolean).join(' · ')}</span>
          </div>
        {/each}
      </div>
    {:else}
      <p class="hint">{m.focal_no_presets({}, options)}</p>
    {/if}
    <div class="actions">
      <button class="btn" type="button" onclick={onclose}>{m.common_cancel({}, options)}</button>
      <button class="btn btn-primary" type="button" onclick={() => onsave([across / 100, down / 100])}>{m.focal_save({}, options)}</button>
    </div>
</Modal>
