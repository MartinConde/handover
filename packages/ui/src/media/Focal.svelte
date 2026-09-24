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
let area = $state<HTMLElement>();
let ratio = $state<number>();

const options = $derived(messageOptions(uiLocale));
const shapes = $derived.by(() => {
  const defaults = ['16:9', '3:2', '4:3', '1:1', '4:5', '9:16'].map((ratio) => ({
    label: ratio === '9:16' ? m.focal_phone_upright({}, options) : '',
    preset: { ratio } as Preset,
  }));
  const unique = new Map<string, (typeof presets)[number]>();
  for (const shape of [...presets, ...defaults]) {
    const ratio = shape.preset.ratio;
    if (ratio && !unique.has(ratio)) unique.set(ratio, shape);
  }
  return [...unique.values()];
});

// The stage is 3:2 and the picture is contained in it; dot and pointer use the picture's own box.
const frame = $derived.by(() => {
  if (!ratio) return 'inset: 0';
  if (ratio < 1.5) {
    const width = (ratio / 1.5) * 100;
    return `top: 0; bottom: 0; left: ${(100 - width) / 2}%; width: ${width}%`;
  }
  const height = (1.5 / ratio) * 100;
  return `left: 0; right: 0; top: ${(100 - height) / 2}%; height: ${height}%`;
});

function point(e: PointerEvent) {
  const box = area?.getBoundingClientRect();
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

const previewWidth = (preset: Preset) => {
  const [width = 4, height = 3] = (preset.ratio ?? '4:3').split(':').map(Number);
  return (96 * width) / height;
};
const aspect = (preset: Preset) => preset.ratio?.replace(':', ' / ') ?? '4 / 3';
</script>

<Modal labelledby="focal-h" describedby="focal-description" panelClass="dialog focal-dialog" {onclose}>
  <header>
    <h2 id="focal-h">{m.focal_title({ name }, options)}</h2>
    <p id="focal-description">{m.focal_intro({}, options)}</p>
  </header>
  <!-- svelte-ignore a11y_no_static_element_interactions -- the handle is the control -->
  <div class="focal-stage" onpointerdown={grab} onpointermove={(e) => e.buttons === 1 && point(e)}>
    <img
      src={url}
      alt=""
      draggable="false"
      onload={(e) => {
        const { naturalWidth, naturalHeight } = e.currentTarget as HTMLImageElement;
        ratio = naturalWidth / naturalHeight || undefined;
      }}
    />
    <div class="focal-frame" style={frame} bind:this={area}>
      <button
        class="focal-handle"
        type="button"
        style="left: {across}%; top: {down}%"
        aria-label={m.focal_position({ across, down }, options)}
        onkeydown={nudge}
      ></button>
    </div>
  </div>
  <!-- Screen readers in browse mode keep arrow keys for themselves; native sliders still work there. -->
  <div class="focal-axes">
    <label>{m.focal_across({}, options)} <input type="range" min="0" max="100" bind:value={across} /></label>
    <label>{m.focal_down({}, options)} <input type="range" min="0" max="100" bind:value={down} /></label>
  </div>
  <h3 class="variant-title">{m.focal_live_previews({}, options)}</h3>
  <div class="ratio-strip">
    {#each shapes as p (p.preset.ratio)}
      <div class="ratio-item" style:--preview-width={`${previewWidth(p.preset)}px`}>
        <div class="ratio-preview" style="aspect-ratio: {aspect(p.preset)}">
          <img src={url} alt="" style="object-position: {across}% {down}%" />
        </div>
        <span class="lbl">{p.preset.ratio}</span>
        {#if p.label}<span class="sub">{p.labels?.[uiLocale] ?? p.label}</span>{/if}
      </div>
    {/each}
  </div>
  <div class="actions">
    <button class="btn" type="button" onclick={onclose}>{m.common_cancel({}, options)}</button>
    <button class="btn btn-primary" type="button" onclick={() => onsave([across / 100, down / 100])}>{m.focal_save({}, options)}</button>
  </div>
</Modal>
