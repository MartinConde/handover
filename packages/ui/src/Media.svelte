<script lang="ts">
import { type Preset, tooSmall } from '@handover/core';
import { fileSize, type MediaItem, uploadFile, uploadImage } from './upload.js';

let {
  kind,
  label,
  preset = {},
  accept = ['application/pdf'],
  base = '',
  dropped = [],
  onpick,
  onclose,
}: {
  /** Pictures or downloads. The field that opened this decides which library it is.  */
  kind: 'images' | 'files';
  /** The field's own name: what the client is choosing for. */
  label: string;
  /** The ratio it will be shown at, the cap on the way in, the floor refused under. */
  preset?: Preset;
  /** The types a `file` field takes. */
  accept?: string[];
  /** Where a stored key is served from. */
  base?: string;
  /** Files dropped on the field itself: the picker opens with them already going up. */
  dropped?: File[];
  onpick: (item: MediaItem) => void;
  onclose: () => void;
} = $props();

let items = $state<MediaItem[]>([]);
let chosen = $state<MediaItem>();
let query = $state('');
let queue = $state<{ name: string; state: string; failed?: boolean }[]>([]);
let over = $state(false);
let panel = $state<HTMLElement>();
let chooser = $state<HTMLInputElement>();

// The library, and then anything the client dropped on the field to get here.
$effect(() => {
  panel?.focus();
  load().then(() => take(dropped));
});

async function load() {
  const res = await fetch(`/admin/api/media?kind=${kind}`);
  if (res.ok) items = ((await res.json()) as { media: MediaItem[] }).media;
}

const shown = $derived(
  items.filter((i) => !query || (i.filename ?? i.src).toLowerCase().includes(query.toLowerCase())),
);

// Why this picture cannot go in this field: measured on the crop at the field's ratio, not on
// the file, so a tall phone photo cannot pass a floor sideways. A field with no floor refuses
// nothing. A row whose size nobody knows — what the reconciliation job recovers, since a HEAD
// cannot measure a picture — is refused whatever the floor is: the field stores those numbers.
const why = (item: MediaItem) => {
  if (kind === 'files') return undefined;
  if (!item.width || !item.height)
    return 'This picture’s size is not known yet, so it cannot be chosen for a field';
  return tooSmall(preset, item.width, item.height);
};

const name = (item: MediaItem) => item.filename ?? item.src.replace(/^\w+\//, '');
const extensions = $derived(
  accept.map((mime) => (mime.split('/').pop() ?? '').toUpperCase()).join(', '),
);
/** `aspect-ratio` takes the preset's own words: `16:9` is already the CSS value. */
const aspect = $derived(preset.ratio?.replace(':', ' / ') ?? '4 / 3');

async function take(files: File[]) {
  for (const file of files) {
    // The row is read back out of the array: what is in there is the reactive proxy, and the
    // object that went in is not — writing to that one updates nothing on the screen.
    const row = queue[
      queue.push({ name: file.name, state: kind === 'images' ? 'Converting…' : 'Uploading…' }) - 1
    ] as { name: string; state: string; failed?: boolean };
    try {
      const media =
        kind === 'images' ? await uploadImage(file, { max: preset.max }) : await uploadFile(file);
      // The site already had these bytes: the fastest upload there is, and worth saying so.
      const held = items.some((i) => i.id === media.id);
      row.state = held ? 'Already in your library — reused, nothing uploaded' : 'Uploaded';
      items = [media, ...items.filter((i) => i.id !== media.id)];
      // Uploading is not choosing: a picture the field is too narrow for is listed with its
      // reason like any other, rather than selected because it arrived last.
      if (!why(media)) chosen = media;
    } catch (err) {
      row.state = err instanceof Error ? err.message : 'The upload failed';
      row.failed = true;
    }
  }
}

function drop(e: DragEvent) {
  e.preventDefault();
  over = false;
  take(Array.from(e.dataTransfer?.files ?? []));
}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<!-- The editor behind is not inert, so this claims no trap it does not have. -->
<div class="scrim">
  <div class="dialog picker-dialog" role="dialog" aria-labelledby="picker-h" tabindex="-1" bind:this={panel}>
    <div class="picker-head">
      <div class="head-row">
        <h2 id="picker-h">Choose {kind === 'images' ? 'an image' : 'a file'} for “{label}”</h2>
        <span class="preset">
          {#if kind === 'files'}Allowed: {extensions}
          {:else if preset.ratio && preset.min}{preset.ratio} · at least {preset.min} px wide
          {:else if preset.min}At least {preset.min} px wide
          {:else if preset.ratio}{preset.ratio}{/if}
        </span>
      </div>
      <div class="picker-tools">
        <div class="field search">
          <label class="visually-hidden" for="picker-q">Search media</label>
          <input class="input" id="picker-q" type="search" placeholder="Search by file name" bind:value={query} />
        </div>
      </div>
    </div>
    <div class="picker-body">
      <div class="picker-main">
        <!-- svelte-ignore a11y_no_static_element_interactions -- the button inside is the control; the zone is a drop target -->
        <div class="dropzone" class:is-over={over} ondragover={(e) => { e.preventDefault(); over = true; }} ondragleave={() => (over = false)} ondrop={drop}>
          <span>Drop {kind === 'images' ? 'images' : 'files'} here to upload</span>
          <span class="hint">
            {#if kind === 'images'}JPEG, PNG, WebP or HEIC · saved at up to {preset.max ?? 2400} px wide
            {:else}{extensions} up to 10 MB{/if}
          </span>
          <input class="visually-hidden" type="file" id="picker-file" multiple accept={kind === 'images' ? 'image/*' : accept.join(',')} bind:this={chooser} onchange={(e) => { take(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = ''; }} />
          <button class="btn btn-sm" type="button" onclick={() => chooser?.click()}>Choose from your computer</button>
        </div>
        {#if queue.length}
          <fieldset class="picker-group">
            <legend>Uploading</legend>
            <ul class="upload-queue">
              {#each queue as row, i (i)}
                <li class="upload-row">
                  <span class="name">{row.name}</span>
                  <span class="state" class:is-failed={row.failed} role={row.failed ? 'alert' : undefined} aria-live={row.failed ? undefined : 'polite'}>{row.state}</span>
                </li>
              {/each}
            </ul>
          </fieldset>
        {/if}
        <fieldset class="picker-group">
          <legend>{kind === 'images' ? 'All images' : 'All files'}</legend>
          <div class="media-grid">
            {#each shown as item (item.id)}
              {@const refused = why(item)}
              <label class="tile">
                <!-- Refused with aria-disabled rather than disabled: a disabled radio takes no
                     focus, so a keyboard would arrow past the tile and never hear the reason. -->
                <input type="radio" name="picker-pick" value={item.id} checked={chosen?.id === item.id} aria-disabled={refused ? 'true' : undefined} aria-describedby={refused ? `why-${item.id}` : undefined} onchange={() => { if (!refused) chosen = item; }} />
                {#if kind === 'images'}
                  <span class="thumb"><img src={item.url} alt="" /></span>
                {:else}
                  <span class="file-icon" aria-hidden="true">{(item.mime?.split('/').pop() ?? '').toUpperCase()}</span>
                {/if}
                <span class="name">{name(item)}</span>
                <span class="sub"><span>{item.width ? `${item.width} × ${item.height}` : fileSize(item.bytes)}</span></span>
                {#if refused}<span class="why" id="why-{item.id}">{refused}</span>{/if}
              </label>
            {:else}
              <p class="hint">Nothing here yet — drop {kind === 'images' ? 'a picture' : 'a file'} on the box above.</p>
            {/each}
          </div>
        </fieldset>
      </div>
      <div class="picker-side">
        <p class="side-title">Selected</p>
        {#if !chosen}
          <p class="empty-side">Nothing chosen yet. Upload {kind === 'images' ? 'a picture' : 'a file'}, or drag one onto the box.</p>
        {:else}
          {#if kind === 'images'}
            <div class="ratio-preview" style="aspect-ratio: {aspect}">
              <img src={chosen.url} alt="" />
              <span class="focal" aria-hidden="true"></span>
            </div>
            <p class="hint">The dot is where the crop holds. It is saved with this field, not with the picture, and it is the same in every language.</p>
          {/if}
          <dl class="facts">
            <div><dt>{name(chosen)}</dt><dd>{chosen.width ? `${chosen.width} × ${chosen.height} · ` : ''}{fileSize(chosen.bytes)}</dd></div>
            <div><dt>Stored as</dt><dd class="sub">{chosen.src}</dd></div>
          </dl>
          {#if kind === 'images'}
            <button class="btn btn-sm" type="button" disabled title="Moving the focal point ships with the media library in Phase 4">Set focal point</button>
          {/if}
        {/if}
      </div>
    </div>
    <div class="picker-foot">
      <span class="spacer"></span>
      <span class="count">{chosen ? '1 selected' : 'Nothing selected'}</span>
      <button class="btn" type="button" onclick={onclose}>Cancel</button>
      <button class="btn btn-primary" type="button" disabled={!chosen} onclick={() => chosen && onpick(chosen)}>Insert</button>
    </div>
  </div>
</div>
