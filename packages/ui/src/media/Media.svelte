<script lang="ts">
import { type Preset, tooSmall } from '@handover/core';
import { request as fetch, sitePath } from '../request.js';
import MediaImage from '../shared/MediaImage.svelte';
import Modal from '../shared/Modal.svelte';
import { fileSize, type MediaItem, uploadFile, uploadImage } from './upload.js';

let {
  kind,
  label,
  preset = {},
  accept = ['application/pdf'],
  base = '',
  dropped = [],
  many = false,
  onpick,
  onclose,
}: {
  /** Pictures or downloads, decided by the field that opened this. */
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
  /** An array of pictures takes as many as are ticked, in the order they were ticked. */
  many?: boolean;
  onpick: (items: MediaItem[]) => void;
  onclose: () => void;
} = $props();

let items = $state<MediaItem[]>([]);
/** In the order they were ticked: that is the order a gallery inserts them in. */
let chosen = $state<MediaItem[]>([]);
let query = $state('');
let queue = $state<{ name: string; state: string; busy: boolean; failed?: boolean }[]>([]);
let over = $state(false);
let chooser = $state<HTMLInputElement>();
let readEpoch = 0;
let readLoading = $state(true);
let readKnown = $state(false);
let readError = $state('');

let opened = false;
// Searching is the same load with the words on it: tags are not in what was loaded here.
$effect(() => {
  const kinds = kind;
  const q = query;
  const epoch = ++readEpoch;
  // Opening waits for nothing, and what was dropped on the field goes up once.
  if (!opened) {
    opened = true;
    load(kinds, '', epoch).then(() => take(dropped));
    return () => {
      if (readEpoch === epoch) readEpoch++;
    };
  }
  // A client typing a word should not spend a request per letter on it.
  const wait = setTimeout(() => load(kinds, q, epoch), 200);
  return () => {
    clearTimeout(wait);
    if (readEpoch === epoch) readEpoch++;
  };
});

async function load(kinds: 'images' | 'files', q: string, epoch: number) {
  readLoading = true;
  readError = '';
  const res = await fetch(`/admin/api/media?kind=${kinds}&q=${encodeURIComponent(q)}`);
  if (epoch !== readEpoch) return;
  if (!res.ok) {
    readLoading = false;
    readError = 'Could not load the media library. Check the connection and try again.';
    return;
  }
  const next = ((await res.json()) as { media: MediaItem[] }).media;
  if (epoch === readEpoch) {
    items = next;
    readKnown = true;
    readLoading = false;
  }
}

function retryRead() {
  const epoch = ++readEpoch;
  void load(kind, query, epoch);
}

// Measured on the crop at the field's ratio, so a tall phone photo cannot pass a floor sideways.
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
/** The one picture a single-value field is about, which is the whole of what its panel shows. */
const one = $derived(chosen[0]);
const uploading = $derived(queue.some((row) => row.busy));

async function take(files: File[]) {
  for (const file of files) {
    // Read back out of the array: only the proxy in there updates the screen.
    const row = queue[
      queue.push({
        name: file.name,
        state: kind === 'images' ? 'Converting…' : 'Uploading…',
        busy: true,
      }) - 1
    ] as { name: string; state: string; busy: boolean; failed?: boolean };
    try {
      const media =
        kind === 'images' ? await uploadImage(file, { max: preset.max }) : await uploadFile(file);
      // The site already had these bytes: the fastest upload there is, and worth saying so.
      const held = items.some((i) => i.id === media.id);
      row.state = held ? 'Already in your library — reused, nothing uploaded' : 'Uploaded';
      items = [media, ...items.filter((i) => i.id !== media.id)];
      // Uploading is not choosing: a refused picture is listed with its reason, not selected.
      if (!why(media)) chosen = many ? [...chosen, media] : [media];
    } catch (err) {
      row.state = err instanceof Error ? err.message : 'The upload failed';
      row.failed = true;
    } finally {
      row.busy = false;
    }
  }
}

/** One at a time replaces; a gallery adds to the end and un-ticking takes it back out. */
function choose(item: MediaItem) {
  if (!many) {
    chosen = [item];
    return;
  }
  chosen = chosen.some((i) => i.id === item.id)
    ? chosen.filter((i) => i.id !== item.id)
    : [...chosen, item];
}

function drop(e: DragEvent) {
  e.preventDefault();
  over = false;
  take(Array.from(e.dataTransfer?.files ?? []));
}
</script>

<Modal labelledby="picker-h" panelClass="dialog picker-dialog" dismissible={!uploading} {onclose}>
    <div class="picker-head">
      <div class="head-row">
        <h2 id="picker-h">Choose {many ? 'images' : kind === 'images' ? 'an image' : 'a file'} for “{label}”</h2>
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
          <input class="input" id="picker-q" type="search" placeholder="Search by file name or tag" bind:value={query} />
        </div>
      </div>
    </div>
    <div class="picker-body">
      <div class="picker-main">
        <!-- svelte-ignore a11y_no_static_element_interactions -- the child button is the control -->
        <div class="dropzone" class:is-over={over} ondragover={(e) => { e.preventDefault(); over = true; }} ondragleave={() => (over = false)} ondrop={drop}>
          <span>Drop {kind === 'images' ? 'images' : 'files'} here to upload</span>
          <span class="hint">
            {#if kind === 'images'}JPEG, PNG, WebP or HEIC · saved at up to {preset.max ?? 2400} px wide
            {:else}{extensions} up to 10 MB{/if}
          </span>
          <label class="visually-hidden" for="picker-file">Files to upload</label>
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
          {#if readError}
            <div class="notice notice-danger media-read-error" role="alert">
              {readError}{readKnown ? ' The items below are the last result.' : ''}
              <button class="btn-link" type="button" onclick={retryRead}>Retry</button>
            </div>
          {/if}
          <div class="media-grid">
            {#if readLoading && !readKnown}
              <p class="hint">Loading media…</p>
            {:else}
            {#each items as item (item.id)}
              {@const refused = why(item)}
              <label class="tile">
                <!-- aria-disabled, not disabled: a disabled control would skip the reason. -->
                <input type={many ? 'checkbox' : 'radio'} name="picker-pick" value={item.id} checked={chosen.some((i) => i.id === item.id)} aria-disabled={refused ? 'true' : undefined} aria-describedby={refused ? `why-${item.id}` : undefined} onchange={() => { if (!refused) choose(item); }} />
                {#if kind === 'images'}
                  <span class="thumb"><MediaImage src={item.url} alt="" /></span>
                {:else}
                  <span class="file-icon" aria-hidden="true">{(item.mime?.split('/').pop() ?? '').toUpperCase()}</span>
                {/if}
                <span class="name">{name(item)}</span>
                <span class="sub"><span>{item.width ? `${item.width} × ${item.height}` : fileSize(item.bytes)}</span></span>
                {#if refused}<span class="why" id="why-{item.id}">{refused}</span>{/if}
              </label>
            {:else}
              {#if !readError}<p class="hint">{query ? 'Nothing here matches that.' : `Nothing here yet — drop ${kind === 'images' ? 'a picture' : 'a file'} on the box above.`}</p>{/if}
            {/each}
            {/if}
          </div>
        </fieldset>
      </div>
      <div class="picker-side">
        {#if many}
          <p class="side-title">{chosen.length ? `${chosen.length} chosen — they go in this order` : 'Nothing chosen yet'}</p>
          <!-- Taking one back out is × on its row here, not un-ticking it in a grid of forty. -->
          <ul class="upload-queue">
            {#each chosen as item (item.id)}
              <li class="upload-row">
                <span class="name">{name(item)}</span>
                <span class="state">{item.width ? `${item.width} × ${item.height}` : fileSize(item.bytes)}</span>
                <span class="actions"><button class="btn btn-icon btn-sm" type="button" aria-label="Remove {name(item)}" onclick={() => choose(item)}>×</button></span>
              </li>
            {/each}
          </ul>
          <p class="hint">Each picture keeps its own focal point once it is in {label}.</p>
        {:else}
          <p class="side-title">Selected</p>
          {#if !one}
            <p class="empty-side">Nothing chosen yet. Upload {kind === 'images' ? 'a picture' : 'a file'}, or drag one onto the box.</p>
          {:else}
            {#if kind === 'images'}
              {@const dot = [(one.focal?.[0] ?? 0.5) * 100, (one.focal?.[1] ?? 0.5) * 100]}
              <div class="ratio-preview" style="aspect-ratio: {aspect}">
                <MediaImage src={one.url} alt="" style="object-position: {dot[0]}% {dot[1]}%" />
                <span class="focal" style="left: {dot[0]}%; top: {dot[1]}%" aria-hidden="true"></span>
              </div>
              <p class="hint">The dot is where the crop holds. It comes from the library, and this field can move it once the picture is in — where it is saved with the field, the same in every language.</p>
            {/if}
            <dl class="facts">
              <div><dt>{name(one)}</dt><dd>{one.width ? `${one.width} × ${one.height} · ` : ''}{fileSize(one.bytes)}</dd></div>
              <div><dt>Stored as</dt><dd class="sub">{one.src}</dd></div>
            </dl>
          {/if}
        {/if}
      </div>
    </div>
    <div class="picker-foot">
      <a href={sitePath(`/admin/media`)}>Manage in Media library</a>
      <span class="spacer"></span>
      <span class="count">{chosen.length ? `${chosen.length} selected` : 'Nothing selected'}</span>
      <button class="btn" type="button" disabled={uploading} onclick={onclose}>Cancel</button>
      <button class="btn btn-primary" type="button" disabled={uploading || !chosen.length} onclick={() => onpick(chosen)}>
        {uploading ? 'Uploading…' : many && chosen.length > 1 ? `Insert ${chosen.length} images` : 'Insert'}
      </button>
    </div>
</Modal>
