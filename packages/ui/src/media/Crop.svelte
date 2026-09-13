<script lang="ts">
import { ParaglideMessage } from '@inlang/paraglide-js-svelte';
import { messageText, type UiMessage } from '../errors.js';
import type { UiLocale } from '../i18n.js';
import { messageOptions } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import Modal from '../shared/Modal.svelte';
import {
  CropError,
  cropName,
  dragRegion,
  fitRegion,
  moveRegion,
  type Region,
  sizeRegion,
  uploadCrop,
} from './crop.js';
import { type MediaItem, MediaUploadError } from './upload.js';

let {
  item,
  ratios = [],
  uiLocale = 'en',
  onmade,
  onclose,
}: {
  /** A region is measured in its own pixels. */
  item: MediaItem;
  ratios?: string[];
  uiLocale?: UiLocale;
  onmade: (made: MediaItem) => void;
  onclose: () => void;
} = $props();

// svelte-ignore state_referenced_locally -- dialog dimensions are initial snapshots
const width = item.width ?? 0;
// svelte-ignore state_referenced_locally -- dialog dimensions are initial snapshots
const height = item.height ?? 0;

// svelte-ignore state_referenced_locally -- the selected shape is an initial snapshot
let ratio = $state<string | undefined>(ratios[0]);
// svelte-ignore state_referenced_locally -- the crop starts from the initial shape
let region = $state<Region>(fitRegion(width, height, ratios[0]));
let busy = $state(false);
let failure = $state<UiMessage>();
let stage = $state<HTMLElement>();
let dragging:
  | { corner?: 'nw' | 'ne' | 'sw' | 'se'; from: Region; at: { x: number; y: number } }
  | undefined;

function at(e: PointerEvent) {
  const box = stage?.getBoundingClientRect();
  if (!box?.width || !box.height) return { x: 0, y: 0 };
  return {
    x: ((e.clientX - box.left) / box.width) * width,
    y: ((e.clientY - box.top) / box.height) * height,
  };
}

function grab(e: PointerEvent, corner?: 'nw' | 'ne' | 'sw' | 'se') {
  // The stage captures the pointer, so a fast drag off a 12 px handle is still this drag.
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

const pc = (n: number, of: number) => (of > 0 ? (n / of) * 100 : 0);

/** crop.ts refuses anything smaller either way. */
const MIN = 16;

const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
const options = $derived(messageOptions(uiLocale));

const cropMessage = (error: unknown): UiMessage =>
  error instanceof CropError || error instanceof MediaUploadError
    ? error.descriptor
    : error instanceof Error
      ? { code: 'CROP_FAILED', detail: error.message }
      : { code: 'CROP_FAILED' };

async function make() {
  busy = true;
  failure = undefined;
  try {
    onmade(await uploadCrop(item, region));
  } catch (err) {
    failure = cropMessage(err);
    busy = false;
  }
}
</script>

<Modal labelledby="crop-h" panelClass="dialog focal-dialog crop-dialog" dismissible={!busy} {onclose}>
    <h2 id="crop-h">{m.crop_title({ name: item.filename ?? item.src }, options)}</h2>
    <p>{m.crop_intro({}, options)}</p>
    <div class="dialog-cols">
      <!-- svelte-ignore a11y_no_static_element_interactions -- the sliders are the control -->
      <div class="focal-stage" bind:this={stage} onpointermove={drag} onpointerup={() => (dragging = undefined)} onpointercancel={() => (dragging = undefined)}>
        <img src={item.url} alt="" draggable="false" />
        <div class="crop-box" style="left: {pc(region.x, width)}%; top: {pc(region.y, height)}%; width: {pc(region.w, width)}%; height: {pc(region.h, height)}%" onpointerdown={(e) => grab(e)}>
          {#each CORNERS as corner (corner)}
            <!-- svelte-ignore a11y_no_static_element_interactions -- pointer affordance for the sliders -->
            <span class="crop-handle h-{corner}" aria-hidden="true" onpointerdown={(e) => grab(e, corner)}></span>
          {/each}
        </div>
      </div>
      <div class="crop-side">
        <div class="crop-group">
          <h3 class="variant-title" id="crop-shape-h">{m.crop_shape({}, options)}</h3>
          <div class="seg crop-shape" role="group" aria-labelledby="crop-shape-h">
            <button type="button" aria-pressed={!ratio} onclick={() => lock(undefined)}>{m.crop_free({}, options)}</button>
            {#each ratios as r (r)}
              <button type="button" aria-pressed={ratio === r} onclick={() => lock(r)}>{r}</button>
            {/each}
          </div>
        </div>
        <div class="crop-group">
          <h3 class="variant-title">{m.crop_position({}, options)}</h3>
          <div class="field">
            <div class="label-row"><label for="crop-x">{m.crop_left({}, options)}</label><output for="crop-x">{region.x} px</output></div>
            <input class="range" id="crop-x" type="range" min="0" max={Math.max(0, width - region.w)} value={region.x} disabled={width <= region.w} style="--fill: {pc(region.x, width - region.w)}%" oninput={(e) => (region = { ...region, x: Number(e.currentTarget.value) })} />
          </div>
          <div class="field">
            <div class="label-row"><label for="crop-y">{m.crop_top({}, options)}</label><output for="crop-y">{region.y} px</output></div>
            <input class="range" id="crop-y" type="range" min="0" max={Math.max(0, height - region.h)} value={region.y} disabled={height <= region.h} style="--fill: {pc(region.y, height - region.h)}%" oninput={(e) => (region = { ...region, y: Number(e.currentTarget.value) })} />
          </div>
        </div>
        <div class="crop-group">
          <h3 class="variant-title">{m.crop_size({}, options)}</h3>
          <div class="field">
            <div class="label-row"><label for="crop-w">{m.crop_width({}, options)}</label><output for="crop-w">{region.w} px</output></div>
            <input class="range" id="crop-w" type="range" min={MIN} max={width} value={region.w} style="--fill: {pc(region.w - MIN, width - MIN)}%" oninput={(e) => (region = sizeRegion(region, width, height, Number(e.currentTarget.value), region.h, ratio))} />
          </div>
          {#if !ratio}
            <div class="field">
              <div class="label-row"><label for="crop-hgt">{m.crop_height({}, options)}</label><output for="crop-hgt">{region.h} px</output></div>
              <input class="range" id="crop-hgt" type="range" min={MIN} max={height} value={region.h} style="--fill: {pc(region.h - MIN, height - MIN)}%" oninput={(e) => (region = sizeRegion(region, width, height, region.w, Number(e.currentTarget.value)))} />
            </div>
          {/if}
        </div>
        <div class="crop-meta">
          <span aria-live="polite"><b>{m.crop_dimensions({ cropWidth: region.w, cropHeight: region.h, sourceWidth: width, sourceHeight: height }, options)}</b></span>
          <span>
            <ParaglideMessage message={m.crop_saved_as} inputs={{ name: cropName(item.filename) }} {options}>
              {#snippet filename({ children })}<code>{@render children?.()}</code>{/snippet}
            </ParaglideMessage>
          </span>
        </div>
      </div>
    </div>
    {#if failure}<p class="notice notice-danger" role="alert">{messageText(failure, uiLocale)}{#if failure.detail}<span class="technical-detail">{m.common_technical_detail({ detail: failure.detail }, options)}</span>{/if}</p>{/if}
    <div class="actions">
      <button class="btn" type="button" disabled={busy} onclick={onclose}>{m.common_cancel({}, options)}</button>
      <button class="btn btn-primary" type="button" disabled={busy} onclick={make}>{busy ? m.crop_working({}, options) : m.crop_create({}, options)}</button>
    </div>
</Modal>
