<script lang="ts">
import type { Preset } from '@handover/core';

let {
  name,
  url,
  focal,
  presets = [],
  onsave,
  onclose,
}: {
  /** What the heading calls the picture: its file name in the library, the field's name in a form. */
  name: string;
  url: string;
  focal: [number, number];
  /** The crops this dot is previewed in: the whole site's in the library, the field's own in a form. */
  presets?: { label: string; preset: Preset }[];
  onsave: (focal: [number, number]) => void;
  onclose: () => void;
} = $props();

// Whole percents: the dot is a place in a photograph, and nobody is choosing 41.7% of one.
let across = $state(Math.round(focal[0] * 100));
let down = $state(Math.round(focal[1] * 100));
let panel = $state<HTMLElement>();
let stage = $state<HTMLElement>();

$effect(() => {
  panel?.focus();
});

// A phone holds a picture upright whatever the site's fields crop to, so that shape is always
// previewed after the site's own.
const PHONE = { label: 'Phone, upright', preset: { ratio: '9:16' } as Preset };
const shapes = $derived(presets.some((p) => p.preset.ratio === PHONE.preset.ratio) ? presets : [...presets, PHONE]);

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

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<!-- The screen behind is not inert, as on every other dialog here, so this claims no trap. -->
<div class="scrim">
  <div class="dialog focal-dialog" role="dialog" aria-labelledby="focal-h" tabindex="-1" bind:this={panel}>
    <h2 id="focal-h">Focal point — {name}</h2>
    <p>Put the dot on the part that has to stay in every crop. Drag it, or move it with the arrow keys.</p>
    <div class="dialog-cols">
      <div>
        <!-- svelte-ignore a11y_no_static_element_interactions -- the handle is the control; the
             picture is the pointer's way to the same two numbers. A press anywhere on it lands
             the dot, and the picture itself is not draggable, or the browser would drag a ghost
             of it instead. -->
        <div class="focal-stage" bind:this={stage} onpointerdown={grab} onpointermove={(e) => e.buttons === 1 && point(e)}>
          <img src={url} alt="" draggable="false" />
          <button
            class="focal-handle"
            type="button"
            style="left: {across}%; top: {down}%"
            aria-label="Focal point, {across}% across, {down}% down"
            onkeydown={nudge}
          ></button>
        </div>
      </div>
      <div class="side-note">
        <p><b>Every crop, framed around the dot.</b> These are the shapes this site renders, and a phone held upright; nothing is written to the picture itself.</p>
        <p>This dot is what a page starts with when this picture is put on it. A page that has its own keeps it — moving this one does not go back and change those.</p>
      </div>
    </div>
    {#if presets.length}
      <h3 class="variant-title">Live previews</h3>
      <div class="ratio-strip">
        {#each shapes as p (p.preset.ratio)}
          <div class="ratio-item">
            <div class="ratio-preview" style="aspect-ratio: {aspect(p.preset)}">
              <img src={url} alt="" style="object-position: {across}% {down}%" />
            </div>
            <span class="lbl">{p.preset.ratio}</span>
            <span class="sub">{[p.label, p.preset.max && `${p.preset.max} px`].filter(Boolean).join(' · ')}</span>
          </div>
        {/each}
      </div>
    {:else}
      <p class="hint">This site shows its pictures whole, so the dot only matters where a page crops one.</p>
    {/if}
    <div class="actions">
      <button class="btn" type="button" onclick={onclose}>Cancel</button>
      <button class="btn btn-primary" type="button" onclick={() => onsave([across / 100, down / 100])}>Save focal point</button>
    </div>
  </div>
</div>
