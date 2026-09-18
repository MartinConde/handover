<script lang="ts">
import { cropWidth, type Preset } from '@handover/core';
import { messageText, type UiMessage } from '../errors.js';
import type { UiLocale } from '../i18n.js';
import { messageOptions } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, sitePath } from '../request.js';
import MediaImage from '../shared/MediaImage.svelte';
import Modal from '../shared/Modal.svelte';
import { fileSize, type MediaItem, MediaUploadError, uploadFile, uploadImage } from './upload.js';

let {
  kind,
  label,
  preset = {},
  accept = ['application/pdf'],
  base = '',
  dropped = [],
  many = false,
  uiLocale = 'en',
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
  uiLocale?: UiLocale;
  onpick: (items: MediaItem[]) => void;
  onclose: () => void;
} = $props();

let items = $state<MediaItem[]>([]);
/** In the order they were ticked: that is the order a gallery inserts them in. */
let chosen = $state<MediaItem[]>([]);
let query = $state('');
type QueueState = 'converting' | 'uploading' | 'reused' | 'uploaded' | UiMessage;
let queue = $state<{ name: string; state: QueueState; busy: boolean; failed?: boolean }[]>([]);
let over = $state(false);
let chooser = $state<HTMLInputElement>();
let readEpoch = 0;
let readLoading = $state(true);
let readKnown = $state(false);
let readError = $state(false);
const options = $derived(messageOptions(uiLocale));

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
  readError = false;
  const res = await fetch(`/admin/api/media?kind=${kinds}&q=${encodeURIComponent(q)}`);
  if (epoch !== readEpoch) return;
  if (!res.ok) {
    readLoading = false;
    readError = true;
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
  if (!item.width || !item.height) return m.media_picker_unknown_size({}, options);
  if (!preset.min) return undefined;
  const width = cropWidth(item.width, item.height, preset.ratio);
  if (width >= preset.min) return undefined;
  return preset.ratio
    ? m.media_picker_too_small_ratio({ ratio: preset.ratio, width, min: preset.min }, options)
    : m.media_picker_too_small({ width, min: preset.min }, options);
};

const queueText = (state: QueueState) => {
  if (typeof state !== 'string') return messageText(state, uiLocale);
  if (state === 'converting') return m.media_upload_converting({}, options);
  if (state === 'uploading') return m.media_upload_uploading({}, options);
  if (state === 'reused') return m.media_upload_reused({}, options);
  return m.media_upload_uploaded({}, options);
};
const uploadMessage = (error: unknown): UiMessage =>
  error instanceof MediaUploadError
    ? error.descriptor
    : error instanceof Error
      ? { code: 'MEDIA_UPLOAD_FAILED', detail: error.message }
      : { code: 'MEDIA_UPLOAD_FAILED' };

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
        state: kind === 'images' ? 'converting' : 'uploading',
        busy: true,
      }) - 1
    ] as { name: string; state: QueueState; busy: boolean; failed?: boolean };
    try {
      const media =
        kind === 'images' ? await uploadImage(file, { max: preset.max }) : await uploadFile(file);
      // The site already had these bytes: the fastest upload there is, and worth saying so.
      const held = items.some((i) => i.id === media.id);
      row.state = held ? 'reused' : 'uploaded';
      items = [media, ...items.filter((i) => i.id !== media.id)];
      // Uploading is not choosing: a refused picture is listed with its reason, not selected.
      if (!why(media)) chosen = many ? [...chosen, media] : [media];
    } catch (err) {
      row.state = uploadMessage(err);
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
        <h2 id="picker-h">{many ? m.media_picker_title_many({ field: label }, options) : kind === 'images' ? m.media_picker_title_image({ field: label }, options) : m.media_picker_title_file({ field: label }, options)}</h2>
        <span class="preset">
          {#if kind === 'files'}{m.media_picker_allowed({ formats: extensions }, options)}
          {:else if preset.ratio && preset.min}{m.media_picker_ratio_min({ ratio: preset.ratio, min: preset.min }, options)}
          {:else if preset.min}{m.media_picker_min({ min: preset.min }, options)}
          {:else if preset.ratio}{preset.ratio}{/if}
        </span>
      </div>
      <div class="picker-tools">
        <div class="field search">
          <label class="visually-hidden" for="picker-q">{m.media_picker_search({}, options)}</label>
          <input class="input" id="picker-q" type="search" placeholder={m.media_picker_search_placeholder({}, options)} bind:value={query} />
        </div>
      </div>
    </div>
    <div class="picker-body">
      <div class="picker-main">
        <!-- svelte-ignore a11y_no_static_element_interactions -- the child button is the control -->
        <div class={['dropzone', { 'is-over': over }]} ondragover={(e) => { e.preventDefault(); over = true; }} ondragleave={() => (over = false)} ondrop={drop}>
          <span>{kind === 'images' ? m.media_picker_drop_images({}, options) : m.media_picker_drop_files({}, options)}</span>
          <span class="hint">
            {#if kind === 'images'}{m.media_picker_image_hint({ max: preset.max ?? 2400 }, options)}
            {:else}{m.media_picker_file_hint({ formats: extensions }, options)}{/if}
          </span>
          <label class="visually-hidden" for="picker-file">{m.media_picker_files_to_upload({}, options)}</label>
          <input class="visually-hidden" type="file" id="picker-file" multiple accept={kind === 'images' ? 'image/*' : accept.join(',')} bind:this={chooser} onchange={(e) => { take(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = ''; }} />
          <button class="btn btn-sm" type="button" onclick={() => chooser?.click()}>{m.media_picker_choose_computer({}, options)}</button>
        </div>
        {#if queue.length}
          <fieldset class="picker-group">
            <legend>{m.media_picker_uploading({}, options)}</legend>
            <ul class="upload-queue">
              {#each queue as row}
                <li class="upload-row">
                  <span class="name">{row.name}</span>
                  <span class={['state', { 'is-failed': row.failed }]} role={row.failed ? 'alert' : undefined} aria-live={row.failed ? undefined : 'polite'}>{queueText(row.state)}{#if typeof row.state !== 'string' && row.state.detail}<span class="technical-detail">{m.common_technical_detail({ detail: row.state.detail }, options)}</span>{/if}</span>
                </li>
              {/each}
            </ul>
          </fieldset>
        {/if}
        <fieldset class="picker-group">
          <legend>{kind === 'images' ? m.media_picker_all_images({}, options) : m.media_picker_all_files({}, options)}</legend>
          {#if readError}
            <div class="notice notice-danger media-read-error" role="alert">
              {readKnown ? m.media_picker_read_failed_stale({}, options) : m.media_picker_read_failed({}, options)}
              <button class="btn-link" type="button" onclick={retryRead}>{m.common_retry({}, options)}</button>
            </div>
          {/if}
          <div class="media-grid">
            {#if readLoading && !readKnown}
              <p class="hint">{m.media_picker_loading({}, options)}</p>
            {:else}
            {#each items as item (item.id)}
              {@const refused = why(item)}
              <label class="tile">
                <!-- aria-disabled, not disabled: a disabled control would skip the reason. -->
                <input type={many ? 'checkbox' : 'radio'} name="picker-pick" value={item.id} checked={chosen.some((i) => i.id === item.id)} aria-disabled={refused ? 'true' : undefined} aria-describedby={refused ? `why-${item.id}` : undefined} onchange={() => { if (!refused) choose(item); }} />
                {#if kind === 'images'}
                  <span class="thumb"><MediaImage src={item.url} alt="" {uiLocale} /></span>
                {:else}
                  <span class="file-icon" aria-hidden="true">{(item.mime?.split('/').pop() ?? '').toUpperCase()}</span>
                {/if}
                <span class="name">{name(item)}</span>
                <span class="sub"><span>{item.width ? `${item.width} × ${item.height}` : fileSize(item.bytes, uiLocale)}</span></span>
                {#if refused}<span class="why" id="why-{item.id}">{refused}</span>{/if}
              </label>
            {:else}
              {#if !readError}<p class="hint">{query ? m.media_picker_no_matches({}, options) : kind === 'images' ? m.media_picker_empty_images({}, options) : m.media_picker_empty_files({}, options)}</p>{/if}
            {/each}
            {/if}
          </div>
        </fieldset>
      </div>
      <div class="picker-side">
        {#if many}
          <p class="side-title">{chosen.length ? m.media_picker_chosen_order({ count: chosen.length }, options) : m.media_picker_nothing_chosen({}, options)}</p>
          <!-- Taking one back out is × on its row here, not un-ticking it in a grid of forty. -->
          <ul class="upload-queue">
            {#each chosen as item (item.id)}
              <li class="upload-row">
                <span class="name">{name(item)}</span>
                <span class="state">{item.width ? `${item.width} × ${item.height}` : fileSize(item.bytes, uiLocale)}</span>
                <span class="actions"><button class="btn btn-icon btn-sm" type="button" aria-label={m.media_picker_remove({ filename: name(item) }, options)} onclick={() => choose(item)}>×</button></span>
              </li>
            {/each}
          </ul>
          <p class="hint">{m.media_picker_focal_each({ field: label }, options)}</p>
        {:else}
          <p class="side-title">{m.media_picker_selected({}, options)}</p>
          {#if !one}
            <p class="empty-side">{kind === 'images' ? m.media_picker_select_empty_image({}, options) : m.media_picker_select_empty_file({}, options)}</p>
          {:else}
            {#if kind === 'images'}
              {@const dot = [(one.focal?.[0] ?? 0.5) * 100, (one.focal?.[1] ?? 0.5) * 100]}
              <div class="ratio-preview" style="aspect-ratio: {aspect}">
                <MediaImage src={one.url} alt="" style="object-position: {dot[0]}% {dot[1]}%" {uiLocale} />
                <span class="focal" style="left: {dot[0]}%; top: {dot[1]}%" aria-hidden="true"></span>
              </div>
              <p class="hint">{m.media_picker_focal_hint({}, options)}</p>
            {/if}
            <dl class="facts">
              <div><dt>{name(one)}</dt><dd>{one.width ? `${one.width} × ${one.height} · ` : ''}{fileSize(one.bytes, uiLocale)}</dd></div>
              <div><dt>{m.media_picker_stored_as({}, options)}</dt><dd class="sub">{one.src}</dd></div>
            </dl>
          {/if}
        {/if}
      </div>
    </div>
    <div class="picker-foot">
      <a href={sitePath(`/admin/media`)}>{m.media_picker_manage({}, options)}</a>
      <span class="spacer"></span>
      <span class="count">{chosen.length ? m.media_picker_selected_count({ count: chosen.length }, options) : m.media_picker_nothing_selected({}, options)}</span>
      <button class="btn" type="button" disabled={uploading} onclick={onclose}>{m.common_cancel({}, options)}</button>
      <button class="btn btn-primary" type="button" disabled={uploading || !chosen.length} onclick={() => onpick(chosen)}>
        {uploading ? m.media_upload_uploading({}, options) : many && chosen.length > 1 ? m.media_picker_insert_images({ count: chosen.length }, options) : m.media_picker_insert({}, options)}
      </button>
    </div>
</Modal>
