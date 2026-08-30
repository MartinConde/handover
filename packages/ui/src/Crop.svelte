<script lang="ts">
import {
  cropName,
  dragRegion,
  fitRegion,
  moveRegion,
  type Region,
  sizeRegion,
  uploadCrop,
} from './crop.js';
import type { MediaItem } from './upload.js';

let {
  item,
  ratios = [],
  onmade,
  onclose,
}: {
  /** The picture being cropped; its own dimensions are what a region is measured in. */
  item: MediaItem;
  /** The site's own shapes, offered beside Free. */
  ratios?: string[];
  /** The crop, once it is a row of its own. */
  onmade: (made: MediaItem) => void;
  onclose: () => void;
} = $props();

const width = item.width ?? 0;
const height = item.height ?? 0;

let ratio = $state<string | undefined>(ratios[0]);
let region = $state<Region>(fitRegion(width, height, ratios[0]));
let busy = $state(false);
let failure = $state('');
let panel = $state<HTMLElement>();
let stage = $state<HTMLElement>();
let dragging:
  | { corner?: 'nw' | 'ne' | 'sw' | 'se'; from: Region; at: { x: number; y: number } }
  | undefined;

$effect(() => {
  panel?.focus();
});

/** Where a pointer is on the photograph, in the photograph's own pixels. */
function at(e: PointerEvent) {
  const box = stage?.getBoundingClientRect();
  if (!box?.width || !box.height) return { x: 0, y: 0 };
  return {
    x: ((e.clientX - box.left) / box.width) * width,
    y: ((e.clientY - box.top) / box.height) * height,
  };
}

function grab(e: PointerEvent, corner?: 'nw' | 'ne' | 'sw' | 'se') {
  // The stage keeps the pointer, not the handle, so a fast drag off a 12 px square is still this
  // drag rather than the end of it.
  e.stopPropagation();
  stage?.setPointerCapture(e.pointerId);
  dragging = { corner, from: region, at: at(e) };
}

function drag(e: PointerEvent) {
  if (!dragging) return;
  const now = at(e);
  region = dragging.corner
    ? dragRegion(dragging.from, width, height, dragging.corner, now.x, now.y, ratio)
    : moveRegion(dragging.from, width, height, now.x - dragging.at.x, now.y - dragging.at.y);
}

function lock(next: string | undefined) {
  ratio = next;
  region = fitRegion(width, height, next);
}

const pc = (n: number, of: number) => (of ? (n / of) * 100 : 0);

/** The corners, which are the pointer's affordance for the two size sliders. */
const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;

async function make() {
  busy = true;
  failure = '';
  try {
    onmade(await uploadCrop(item, region));
  } catch (err) {
    failure = err instanceof Error ? err.message : 'the crop could not be made';
    busy = false;
  }
}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="scrim">
  <div class="dialog focal-dialog" role="dialog" aria-labelledby="crop-h" tabindex="-1" bind:this={panel}>
    <h2 id="crop-h">Crop a copy — {item.filename ?? item.src}</h2>
    <p>This makes a new image. The original is kept and stays wherever it is used.</p>
    <!-- svelte-ignore a11y_no_static_element_interactions -- the four sliders below are the
         control; the box is the pointer's way to the same four numbers -->
    <div class="focal-stage" bind:this={stage} onpointermove={drag} onpointerup={() => (dragging = undefined)} onpointercancel={() => (dragging = undefined)}>
      <img src={item.url} alt="" />
      <div class="crop-box" style="left: {pc(region.x, width)}%; top: {pc(region.y, height)}%; width: {pc(region.w, width)}%; height: {pc(region.h, height)}%" onpointerdown={(e) => grab(e)}>
        {#each CORNERS as corner (corner)}
          <!-- svelte-ignore a11y_no_static_element_interactions -- pointer affordance for the sliders -->
          <span class="crop-handle h-{corner}" aria-hidden="true" onpointerdown={(e) => grab(e, corner)}></span>
        {/each}
      </div>
    </div>
    <div class="crop-sliders">
      <div class="field">
        <label for="crop-x">Left</label>
        <input id="crop-x" type="range" min="0" max={Math.max(0, width - region.w)} value={region.x} oninput={(e) => (region = { ...region, x: Number(e.currentTarget.value) })} />
      </div>
      <div class="field">
        <label for="crop-y">Top</label>
        <input id="crop-y" type="range" min="0" max={Math.max(0, height - region.h)} value={region.y} oninput={(e) => (region = { ...region, y: Number(e.currentTarget.value) })} />
      </div>
      <div class="field">
        <label for="crop-w">Width</label>
        <input id="crop-w" type="range" min="16" max={width} value={region.w} oninput={(e) => (region = sizeRegion(region, width, height, Number(e.currentTarget.value), region.h, ratio))} />
      </div>
      {#if !ratio}
        <div class="field">
          <label for="crop-h">Height</label>
          <input id="crop-h" type="range" min="16" max={height} value={region.h} oninput={(e) => (region = sizeRegion(region, width, height, region.w, Number(e.currentTarget.value)))} />
        </div>
      {/if}
    </div>
    <div class="crop-meta">
      <span aria-live="polite">{region.w} × {region.h} px of {width} × {height}</span>
      <span>Saved as <code>{cropName(item.filename)}</code>, linked to the original</span>
      <div class="seg" role="group" aria-label="Ratio">
        <button type="button" aria-pressed={!ratio} onclick={() => lock(undefined)}>Free</button>
        {#each ratios as r (r)}
          <button type="button" aria-pressed={ratio === r} onclick={() => lock(r)}>{r}</button>
        {/each}
      </div>
    </div>
    {#if failure}<p class="notice notice-danger" role="alert">{failure}</p>{/if}
    <div class="actions">
      <button class="btn" type="button" onclick={onclose}>Cancel</button>
      <button class="btn btn-primary" type="button" disabled={busy} onclick={make}>{busy ? 'Cropping…' : 'Create cropped copy'}</button>
    </div>
  </div>
</div>
