<script lang="ts">
import type { Preset } from '@handover/core';
import { ParaglideMessage } from '@inlang/paraglide-js-svelte';
import { tick } from 'svelte';
import { messageText, responseMessage, type UiMessage } from '../errors.js';
import { formatMediaDate, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, sitePath, uncertainResponse } from '../request.js';
import MediaImage from '../shared/MediaImage.svelte';
import Modal from '../shared/Modal.svelte';
import Crop from './Crop.svelte';
import Focal from './Focal.svelte';
import { fileSize, type LibraryItem, MediaUploadError, uploadFile, uploadImage } from './upload.js';

let {
  base = '',
  presets = [],
  uiLocale = 'en',
}: {
  /** Where a stored key is served from. */
  base?: string;
  /** Every shape this site crops a picture to: what the focal picker previews and Crop offers. */
  presets?: { label: string; preset: Preset }[];
  uiLocale?: UiLocale;
} = $props();

let kind = $state<'images' | 'files'>('images');
let query = $state('');
let items = $state<LibraryItem[]>([]);
let chosen = $state<LibraryItem>();
let detailsPanel = $state<HTMLElement>();
let selectedTile: HTMLElement | undefined;
let loading = $state(true);
type Failure = { message: UiMessage; recovery?: 'read' | 'delete' | 'reload' };
let failure = $state<Failure>();
let copied = $state('');
let tag = $state('');
type QueueState = 'converting' | 'uploading' | 'reused' | 'uploaded' | UiMessage;
let queue = $state<{ name: string; state: QueueState; failed?: boolean }[]>([]);
let over = $state(false);
let chooser = $state<HTMLInputElement>();
let confirming = $state(false);
let deleting = $state(false);
/** The two dialogs the panel opens, and neither is open until a picture is. */
let framing = $state(false);
let cropping = $state(false);
type MetadataChange = {
  tags?: string[];
  alt?: string;
  archived?: boolean;
  focal?: [number, number];
};
type MetadataLane = {
  acknowledged: LibraryItem;
  draft: LibraryItem;
  pending: MetadataChange[];
  failed?: MetadataChange;
  writing: boolean;
};
const metadataLanes = new Map<string, MetadataLane>();
let metadataFailures = $state<
  Record<string, { message: UiMessage; name: string; recovery?: 'retry' | 'reload' }>
>({});
let trigger = $state<HTMLElement>();
let readEpoch = 0;
const options = $derived(messageOptions(uiLocale));
const textOf = (message: UiMessage) => messageText(message, uiLocale);
const detailOf = (message: UiMessage) =>
  message.detail ? m.common_technical_detail({ detail: message.detail }, options) : '';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isLibraryItem = (value: unknown): value is LibraryItem => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.id) ||
    typeof value.src !== 'string'
  )
    return false;
  if (value.filename != null && typeof value.filename !== 'string') return false;
  if (value.mime != null && typeof value.mime !== 'string') return false;
  if (value.bytes != null && typeof value.bytes !== 'number') return false;
  if (value.width != null && typeof value.width !== 'number') return false;
  if (value.height != null && typeof value.height !== 'number') return false;
  if (value.alt != null && typeof value.alt !== 'string') return false;
  if (value.archived != null && typeof value.archived !== 'boolean') return false;
  if (value.createdAt != null && typeof value.createdAt !== 'number') return false;
  if (
    value.tags != null &&
    (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string'))
  )
    return false;
  return (
    value.uses == null ||
    (Array.isArray(value.uses) &&
      value.uses.every(
        (use) =>
          isRecord(use) &&
          typeof use.entry === 'string' &&
          typeof use.title === 'string' &&
          typeof use.href === 'string',
      ))
  );
};

async function mediaResponse(response: Response, fallback: string): Promise<UiMessage> {
  const message = await responseMessage(response, fallback);
  let body: { uses?: unknown } | undefined;
  try {
    body = (await response.clone().json()) as typeof body;
  } catch {
    body = undefined;
  }
  return {
    ...message,
    ...(Array.isArray(body?.uses) ? { count: body.uses.length } : {}),
  };
}

// Debounced so typing a word does not spend a request per letter.
$effect(() => {
  const kinds = kind;
  const q = query;
  const epoch = ++readEpoch;
  const wait = setTimeout(() => load(kinds, q, epoch), 200);
  return () => {
    clearTimeout(wait);
    if (readEpoch === epoch) readEpoch++;
  };
});

async function load(
  kinds: 'images' | 'files',
  q: string,
  epoch: number,
  reconcileSelection = false,
) {
  const res = await fetch(`/admin/api/media?kind=${kinds}&archived=1&q=${encodeURIComponent(q)}`);
  if (epoch !== readEpoch) return;
  if (!res.ok) {
    loading = false;
    failure = {
      message: uncertainResponse(res)
        ? { code: 'MEDIA_LIBRARY_READ_FAILED', status: res.status }
        : await mediaResponse(res, 'MEDIA_LIBRARY_READ_FAILED'),
      recovery: 'read',
    };
    return;
  }
  let answer: unknown;
  try {
    answer = await res.json();
  } catch {
    answer = undefined;
  }
  const next = isRecord(answer) ? answer.media : undefined;
  if (epoch !== readEpoch) return;
  if (!Array.isArray(next) || !next.every(isLibraryItem)) {
    loading = false;
    failure = { message: { code: 'MEDIA_LIBRARY_READ_INVALID' }, recovery: 'read' };
    return;
  }
  loading = false;
  failure = undefined;
  items = next;
  if (reconcileSelection) {
    metadataFailures = Object.fromEntries(
      Object.entries(metadataFailures).filter(([id]) => items.some((item) => item.id === id)),
    );
  }
  // The panel is about a picture that may no longer be in the list under this search.
  if (chosen)
    chosen = items.find((i) => i.id === chosen?.id) ?? (reconcileSelection ? undefined : chosen);
}

function retryRead(reconcileSelection = false) {
  const epoch = ++readEpoch;
  void load(kind, query, epoch, reconcileSelection);
}

const name = (item: LibraryItem) => item.filename ?? item.src.replace(/^\w+\//, '');
const extension = (item: LibraryItem) => (item.mime?.split('/').pop() ?? '').toUpperCase();
const count = (item: LibraryItem) => {
  const n = item.uses?.length ?? 0;
  return n === 0
    ? m.media_library_not_used({}, options)
    : m.media_library_used_count({ count: n }, options);
};
// A row the reconciliation job wrote has no measured size, which is how it is told apart.
const recovered = (item: LibraryItem) => kind === 'images' && !(item.width && item.height);
// Filters over what is loaded: the list already carries the archived rows.
let only = $state({ archived: false, recovered: false, unused: false });
const shown = $derived(
  items.filter(
    (i) =>
      (!only.archived || i.archived) &&
      (!only.recovered || recovered(i)) &&
      (!only.unused || !i.uses?.length),
  ),
);
const filtering = $derived(only.archived || only.recovered || only.unused);
const heading = $derived(
  filtering
    ? kind === 'images'
      ? m.media_library_filtered_image_count({ count: shown.length }, options)
      : m.media_library_filtered_file_count({ count: shown.length }, options)
    : kind === 'images'
      ? m.media_library_image_count({ count: shown.length }, options)
      : m.media_library_file_count({ count: shown.length }, options),
);
/** Where the crops of this picture hold, in the percentages the dot and `object-position` want. */
const dot = (item: LibraryItem) => [(item.focal?.[0] ?? 0.5) * 100, (item.focal?.[1] ?? 0.5) * 100];
const when = (at?: number) => (at ? formatMediaDate(at, uiLocale) : '');

async function pick(item: LibraryItem) {
  selectedTile = document.activeElement as HTMLElement;
  const lane = metadataLanes.get(item.id);
  chosen = lane && (lane.writing || lane.failed || lane.pending.length) ? lane.draft : item;
  tag = '';
  copied = '';
  closeDialog();
  await tick();
  if (window.matchMedia?.('(max-width: 720px)').matches) {
    detailsPanel?.scrollIntoView({ block: 'start', behavior: 'instant' });
    detailsPanel?.focus({ preventScroll: true });
  }
}

function closeDetails() {
  chosen = undefined;
  selectedTile?.focus();
}

function ask() {
  trigger = (document.activeElement as HTMLElement | null) ?? undefined;
  confirming = true;
}

function closeDialog() {
  confirming = false;
}

function showMetadataDraft(id: string, draft: LibraryItem) {
  items = items.map((item) => (item.id === id ? { ...item, ...draft } : item));
  if (chosen?.id === id) chosen = draft;
}

function laneFor(item: LibraryItem) {
  const held = metadataLanes.get(item.id);
  if (held) {
    if (!held.writing && !held.failed && !held.pending.length) {
      held.acknowledged = item;
      held.draft = item;
    }
    return held;
  }
  const lane: MetadataLane = {
    acknowledged: item,
    draft: item,
    pending: [],
    writing: false,
  };
  metadataLanes.set(item.id, lane);
  return lane;
}

async function writeMetadata(id: string, lane: MetadataLane) {
  if (lane.writing) return;
  lane.writing = true;
  try {
    while (lane.failed || lane.pending.length) {
      const details = lane.failed ?? lane.pending.shift();
      if (!details) break;
      const res = await fetch(`/admin/api/media/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(details),
      });
      if (!res.ok) {
        lane.failed = details;
        const message = uncertainResponse(res)
          ? ({ code: 'MEDIA_METADATA_UNCONFIRMED', status: res.status } satisfies UiMessage)
          : await mediaResponse(res, 'MEDIA_METADATA_FAILED');
        metadataFailures = {
          ...metadataFailures,
          [id]: {
            message,
            name: name(lane.draft),
            recovery:
              message.code === 'MEDIA_NOT_FOUND'
                ? 'reload'
                : message.code === 'MEDIA_METADATA_INVALID'
                  ? undefined
                  : 'retry',
          },
        };
        break;
      }
      let answer: unknown;
      try {
        answer = await res.json();
      } catch {
        answer = undefined;
      }
      const saved = isRecord(answer) ? answer.media : undefined;
      if (!isLibraryItem(saved) || saved.id !== id) {
        lane.failed = details;
        metadataFailures = {
          ...metadataFailures,
          [id]: {
            message: { code: 'MEDIA_METADATA_INVALID' },
            name: name(lane.draft),
            recovery: 'retry',
          },
        };
        break;
      }
      lane.acknowledged = { ...lane.acknowledged, ...saved };
      lane.failed = undefined;
      const optimistic = lane.draft;
      lane.draft = { ...optimistic, ...saved };
      for (const waiting of lane.pending) {
        for (const key of Object.keys(waiting) as (keyof MetadataChange)[]) {
          Object.assign(lane.draft, { [key]: optimistic[key] });
        }
      }
      const { [id]: _, ...rest } = metadataFailures;
      metadataFailures = rest;
      showMetadataDraft(id, lane.draft);
    }
  } finally {
    lane.writing = false;
  }
}

/** Tags and the default alt are the library's own words, so they are saved as they are typed. */
function describe(details: MetadataChange, item = chosen) {
  if (!item) return;
  const lane = laneFor(item);
  lane.draft = { ...lane.draft, ...details };
  lane.pending.push(details);
  showMetadataDraft(item.id, lane.draft);
  if (!lane.failed) void writeMetadata(item.id, lane);
}

function retryMetadata(id: string) {
  const lane = metadataLanes.get(id);
  if (!lane?.failed) return;
  const { [id]: _, ...rest } = metadataFailures;
  metadataFailures = rest;
  void writeMetadata(id, lane);
}

function addTag() {
  const word = tag.trim();
  if (!word || chosen?.tags?.includes(word)) {
    tag = '';
    return;
  }
  describe({ tags: [...(chosen?.tags ?? []), word] });
  tag = '';
}

/** The gate is the server's: the request is refused if the use count was a build behind. */
async function remove() {
  const item = chosen;
  if (!item) return;
  deleting = true;
  const res = await fetch(`/admin/api/media/${item.id}`, { method: 'DELETE' });
  deleting = false;
  confirming = false;
  // Not `closeDialog`: the tile the button belonged to is about to go with the picture.
  if (!res.ok) {
    const message = uncertainResponse(res)
      ? ({ code: 'MEDIA_DELETE_UNCONFIRMED', status: res.status } satisfies UiMessage)
      : await mediaResponse(res, 'MEDIA_DELETE_FAILED');
    failure = {
      message,
      recovery:
        message.code === 'MEDIA_NOT_FOUND'
          ? 'reload'
          : message.code === 'MEDIA_DELETE_UNCONFIRMED'
            ? 'reload'
            : message.code === 'MEDIA_IN_USE' || message.code === 'MEDIA_PUBLISHED_IN_USE'
              ? undefined
              : 'delete',
    };
    return;
  }
  let answer: unknown;
  try {
    answer = await res.json();
  } catch {
    answer = undefined;
  }
  if (!isRecord(answer) || answer.deleted !== item.id) {
    failure = { message: { code: 'MEDIA_DELETE_INVALID' }, recovery: 'reload' };
    return;
  }
  failure = undefined;
  items = items.filter((i) => i.id !== item.id);
  chosen = undefined;
}

async function copyUrl(item: LibraryItem) {
  await navigator.clipboard?.writeText(item.url ?? `${base}/${item.src}`);
  copied = item.id;
}

async function take(files: File[]) {
  const batchKind = kind;
  const batchQuery = query;
  const batchEpoch = readEpoch;
  const rows = queue;
  const known = new Set(items.map((item) => item.id));
  for (const file of files) {
    // Read back out of the array: only the proxy in there is reactive, not the object pushed.
    const row = rows[
      rows.push({
        name: file.name,
        state: batchKind === 'images' ? 'converting' : 'uploading',
      }) - 1
    ] as { name: string; state: QueueState; failed?: boolean };
    try {
      const media = batchKind === 'images' ? await uploadImage(file) : await uploadFile(file);
      const held = known.has(media.id);
      known.add(media.id);
      row.state = held ? 'reused' : 'uploaded';
    } catch (err) {
      row.state =
        err instanceof MediaUploadError
          ? err.descriptor
          : err instanceof Error
            ? { code: 'MEDIA_UPLOAD_FAILED', detail: err.message }
            : { code: 'MEDIA_UPLOAD_FAILED' };
      row.failed = true;
    }
  }
  if (kind === batchKind && query === batchQuery && readEpoch === batchEpoch) {
    const epoch = ++readEpoch;
    await load(batchKind, batchQuery, epoch);
  }
}

function drop(e: DragEvent) {
  e.preventDefault();
  over = false;
  take(Array.from(e.dataTransfer?.files ?? []));
}

function show(next: 'images' | 'files') {
  if (kind === next) return;
  readEpoch++;
  kind = next;
  chosen = undefined;
  queue = [];
  items = [];
  loading = true;
  failure = undefined;
}

const queueText = (state: QueueState) => {
  if (typeof state !== 'string') return textOf(state);
  if (state === 'converting') return m.media_upload_converting({}, options);
  if (state === 'uploading') return m.media_upload_uploading({}, options);
  if (state === 'reused') return m.media_upload_reused({}, options);
  return m.media_upload_uploaded({}, options);
};
</script>

<main class="main media-page">
  <div class="list-toolbar">
    <h1>{m.media_library_title({}, options)} <span class="count">{heading}</span></h1>
    <span class="spacer"></span>
    <div class="filters">
      <button class="filter is-toggle" class:is-on={only.archived} type="button" aria-pressed={only.archived} onclick={() => (only.archived = !only.archived)}>{m.media_library_archived({}, options)}</button>
      {#if kind === 'images'}
        <button class="filter is-toggle" class:is-on={only.recovered} type="button" aria-pressed={only.recovered} onclick={() => (only.recovered = !only.recovered)}>{m.media_library_recovered({}, options)}</button>
      {/if}
      <button class="filter is-toggle" class:is-on={only.unused} type="button" aria-pressed={only.unused} onclick={() => (only.unused = !only.unused)}>{m.media_library_unused({}, options)}</button>
    </div>
    <div class="field search">
      <label class="visually-hidden" for="lib-q">{m.media_library_search({}, options)}</label>
      <input class="input" id="lib-q" type="search" placeholder={m.media_library_search_placeholder({}, options)} bind:value={query} />
    </div>
    <button class="btn btn-primary" type="button" onclick={() => chooser?.click()}>{m.media_library_upload({}, options)}</button>
    <label class="visually-hidden" for="lib-file">{m.media_library_files_to_upload({}, options)}</label>
    <input class="visually-hidden" type="file" id="lib-file" multiple accept={kind === 'images' ? 'image/*' : 'application/pdf'} bind:this={chooser} onchange={(e) => { take(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = ''; }} />
  </div>
  <!-- Buttons rather than links: the kind is not an address of its own. -->
  <div class="tabs lib-tabs" role="tablist" aria-label={m.media_library_kind({}, options)}>
    <button type="button" role="tab" aria-selected={kind === 'images'} onclick={() => show('images')}>{m.media_library_images({}, options)}</button>
    <button type="button" role="tab" aria-selected={kind === 'files'} onclick={() => show('files')}>{m.media_library_files({}, options)}</button>
  </div>
  {#if failure}
    <div class="notice notice-danger library-failure" role="alert">
      <p>{textOf(failure.message)}</p>
      {#if detailOf(failure.message)}<p class="detail">{detailOf(failure.message)}</p>{/if}
      {#if failure.recovery}
        <button class="btn btn-sm" type="button" disabled={deleting} onclick={() => failure?.recovery === 'read' ? retryRead() : failure?.recovery === 'reload' ? retryRead(true) : remove()}>
          {failure.recovery === 'reload' ? m.media_library_reload({}, options) : failure.recovery === 'delete' ? m.media_library_retry_delete({}, options) : m.common_retry({}, options)}
        </button>
      {/if}
    </div>
  {/if}
  {#each Object.entries(metadataFailures) as [id, metadataFailure] (id)}
    <div class="notice notice-danger metadata-failure" role="alert">
      <p>{textOf(metadataFailure.message)}</p>
      {#if detailOf(metadataFailure.message)}<p class="detail">{detailOf(metadataFailure.message)}</p>{/if}
      {#if metadataFailure.recovery}
        <button class="btn btn-sm" type="button" onclick={() => metadataFailure.recovery === 'reload' ? retryRead(true) : retryMetadata(id)}>
          {metadataFailure.recovery === 'reload' ? m.media_library_reload({}, options) : m.media_library_retry_metadata({ filename: metadataFailure.name }, options)}
        </button>
      {/if}
    </div>
  {/each}
  <div class="lib-body" class:has-selection={!!chosen}>
    <div class="lib-main">
      <!-- svelte-ignore a11y_no_static_element_interactions -- the child button is the control -->
      <div class="dropzone" class:is-big={!items.length} class:is-over={over} ondragover={(e) => { e.preventDefault(); over = true; }} ondragleave={() => (over = false)} ondrop={drop}>
        <svg class="dz-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
        <span class="dz-text">
          <span>
            <ParaglideMessage message={kind === 'images' ? m.media_library_drop_choose_images : m.media_library_drop_choose_files} inputs={{}} {options}>
              {#snippet drop({ children })}<b>{@render children?.()}</b>{/snippet}
              {#snippet choose({ children })}<button class="btn-link" type="button" onclick={() => chooser?.click()}>{@render children?.()}</button>{/snippet}
            </ParaglideMessage>
          </span>
          <span class="hint">{kind === 'images' ? m.media_library_image_hint({}, options) : m.media_library_file_hint({}, options)}</span>
        </span>
      </div>
      {#if queue.length}
        <ul class="upload-queue">
          {#each queue as row, i (i)}
            <li class="upload-row">
              <span class="name">{row.name}</span>
              <span class="state" class:is-failed={row.failed} role={row.failed ? 'alert' : undefined} aria-live={row.failed ? undefined : 'polite'}>{queueText(row.state)}</span>
              {#if typeof row.state !== 'string' && detailOf(row.state)}<span class="detail">{detailOf(row.state)}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if loading}
        <p class="placeholder">{m.media_library_loading({}, options)}</p>
      {:else if kind === 'images'}
        <div class="media-grid">
          {#each shown as item (item.id)}
            <article class="tile" class:is-archived={item.archived} class:is-selected={chosen?.id === item.id}>
              <span class="thumb">
                <MediaImage src={item.url} alt="" {uiLocale} />
                {#if item.archived}<span class="badge flag">{m.media_library_archived({}, options)}</span>
                {:else if recovered(item)}<span class="badge badge-warn flag">{m.media_library_recovered({}, options)}</span>{/if}
              </span>
              <!-- The whole card opens the panel; the link is what a keyboard reaches. -->
              <button class="tile-link name" type="button" onclick={() => pick(item)}>{name(item)}</button>
              <span class="sub">
                <span>{item.width ? `${item.width} × ${item.height}` : fileSize(item.bytes, uiLocale)}</span>
                <span class="badge" class:is-used={!!item.uses?.length}>{count(item)}</span>
              </span>
              <!-- Above the stretched link, so both are reachable. -->
              {#if item.archived}
                <span class="tile-actions"><button class="btn btn-sm" type="button" aria-label={m.media_library_unarchive_named({ filename: name(item) }, options)} onclick={() => describe({ archived: false }, item)}>{m.media_library_unarchive({}, options)}</button></span>
              {/if}
            </article>
          {:else}
            <p class="hint">{query || filtering ? m.media_library_no_matches({}, options) : m.media_library_empty_images({}, options)}</p>
          {/each}
        </div>
      {:else}
        <div class="file-rows">
          {#each shown as item (item.id)}
            <div class="file-row is-link" class:is-selected={chosen?.id === item.id}>
              <span class="file-icon" aria-hidden="true">{extension(item)}</span>
              <span class="who">
                <button class="tile-link name" type="button" onclick={() => pick(item)}>{name(item)}</button>
                <span class="sub">{fileSize(item.bytes, uiLocale)} · {item.mime}</span>
              </span>
              <span class="usage"><span class="badge">{count(item)}</span></span>
            </div>
          {:else}
            <p class="hint">{query || filtering ? m.media_library_no_matches({}, options) : m.media_library_empty_files({}, options)}</p>
          {/each}
        </div>
      {/if}
    </div>
    {#if chosen}
      <aside class="lib-side" tabindex="-1" bind:this={detailsPanel} class:is-recovered={recovered(chosen)} aria-labelledby="lib-side-h">
        <div class="side-head">
          <button class="btn btn-ghost btn-icon inspector-close" type="button" aria-label={m.media_library_close_details({}, options)} onclick={closeDetails}>×</button>
          <p class="side-title" id="lib-side-h">{name(chosen)}</p>
          <p class="side-meta">{[chosen.width ? `${chosen.width} × ${chosen.height}` : '', fileSize(chosen.bytes, uiLocale), extension(chosen), chosen.createdAt ? m.media_library_uploaded({ date: when(chosen.createdAt) }, options) : ''].filter(Boolean).join(' · ')}</p>
        </div>
        {#if kind === 'images'}
          <div class="preview">
            <MediaImage src={chosen.url} alt="" {uiLocale} />
            <span class="focal" style="left: {dot(chosen)[0]}%; top: {dot(chosen)[1]}%" aria-hidden="true"></span>
          </div>
          <p class="hint">{m.media_library_focal_hint({}, options)}</p>
          <div class="actions">
            <button class="action" type="button" onclick={() => (framing = true)}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></svg>
              {m.media_library_focal({}, options)}
            </button>
            <!-- A picture nobody measured cannot be cropped. -->
            <button class="action" type="button" disabled={!(chosen.width && chosen.height)} onclick={() => (cropping = true)}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" /></svg>
              {m.media_library_crop({}, options)}
            </button>
            <button class="action" type="button" onclick={() => chosen && copyUrl(chosen)}>
              {#if copied === chosen.id}
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
                {m.media_library_copied({}, options)}
              {:else}
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                {m.media_library_copy_url({}, options)}
              {/if}
            </button>
          </div>
        {:else}
          <span class="file-icon is-big" aria-hidden="true">{extension(chosen)}</span>
          <div class="actions">
            <button class="action" type="button" onclick={() => chosen && copyUrl(chosen)}>
              {#if copied === chosen.id}
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
                {m.media_library_copied({}, options)}
              {:else}
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                {m.media_library_copy_url({}, options)}
              {/if}
            </button>
          </div>
        {/if}
        {#if recovered(chosen)}
          <p class="notice">{m.media_library_recovered_hint({}, options)}</p>
        {/if}
        <dl class="facts">
          <div class="usage">
            <dt>{m.media_library_used({}, options)}</dt>
            <dd>
              {#if chosen.uses?.length}
                <details>
                  <summary><span class="badge">{count(chosen)}</span></summary>
                  <ul class="usage-list">
                    {#each chosen.uses as use (use.entry)}
                      <li><a href={sitePath(use.href)}>{use.title}</a><span class="where">{use.entry.split('/')[0]}</span></li>
                    {/each}
                  </ul>
                </details>
              {:else}
                <span class="badge">{m.media_library_not_used({}, options)}</span>
              {/if}
            </dd>
          </div>
          <div class="stored"><dt>{m.media_library_stored_as({}, options)}</dt><dd class="sub" title={chosen.src}>{chosen.src}</dd></div>
        </dl>
        <div class="field">
          <label for="lib-tags">{m.media_library_tags({}, options)}</label>
          <div class="tag-row">
            {#each chosen.tags ?? [] as word (word)}
              <span class="badge">{word} <button type="button" aria-label={m.media_library_remove_tag({ tag: word }, options)} onclick={() => describe({ tags: (chosen?.tags ?? []).filter((t) => t !== word) })}>×</button></span>
            {/each}
            <input id="lib-tags" type="text" placeholder={m.media_library_add_tag({}, options)} bind:value={tag} onblur={addTag} onkeydown={(e) => { if (e.key !== 'Enter') return; e.preventDefault(); addTag(); }} />
          </div>
          <span class="hint">{m.media_library_tags_hint({}, options)}</span>
        </div>
        {#if kind === 'images'}
          <div class="field">
            <label for="lib-alt">{m.media_library_default_alt({}, options)}</label>
            <textarea class="input textarea" id="lib-alt" value={chosen.alt ?? ''} onchange={(e) => describe({ alt: e.currentTarget.value })}></textarea>
            <span class="hint">{m.media_library_alt_hint({}, options)}</span>
          </div>
        {/if}
        <div class="actions is-keep">
          <button class="btn btn-sm btn-ghost archive" type="button" onclick={() => describe({ archived: !chosen?.archived })}>
            {#if chosen.archived}
              <svg aria-hidden="true" viewBox="0 0 24 24"><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h2" /><path d="M20 8v11a2 2 0 0 1-2 2h-2" /><path d="m9 15 3-3 3 3" /><path d="M12 12v9" /></svg>
              {m.media_library_unarchive({}, options)}
            {:else}
              <svg aria-hidden="true" viewBox="0 0 24 24"><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></svg>
              {m.media_library_archive({}, options)}
            {/if}
          </button>
          <button class="btn btn-sm btn-ghost btn-quiet-danger delete" type="button" disabled={!!chosen.uses?.length} onclick={ask}>
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
            {m.media_library_delete({}, options)}
          </button>
        </div>
        <p class="hint delete-hint">
          {#if chosen.uses?.length}
            {kind === 'images' ? m.media_library_delete_used_image({ usage: count(chosen) }, options) : m.media_library_delete_used_file({ usage: count(chosen) }, options)}
          {:else}
            {kind === 'images' ? m.media_library_delete_unused_image({}, options) : m.media_library_delete_unused_file({}, options)}
          {/if}
        </p>
      </aside>
    {/if}
  </div>
</main>

{#if framing && chosen}
  <Focal
    name={name(chosen)}
    url={chosen.url ?? `${base}/${chosen.src}`}
    focal={chosen.focal ?? [0.5, 0.5]}
    {presets}
    {uiLocale}
    onsave={(point) => { describe({ focal: point }); framing = false; }}
    onclose={() => (framing = false)}
  />
{/if}

{#if cropping && chosen}
  <Crop
    item={chosen}
    ratios={presets.map((p) => p.preset.ratio ?? '').filter(Boolean)}
    {uiLocale}
    onmade={(made) => {
      cropping = false;
      // The panel moves to the copy, which is how the client sees the original is still there.
      items = [{ ...made, tags: [], uses: [] }, ...items.filter((i) => i.id !== made.id)];
      chosen = items[0];
    }}
    onclose={() => (cropping = false)}
  />
{/if}

{#if confirming && chosen}
  <Modal
    labelledby="del-h"
    describedby="del-d"
    role="alertdialog"
    initialFocus=".actions .btn"
    returnTo={trigger}
    dismissible={!deleting}
    onclose={closeDialog}
  >
      <h2 id="del-h">{m.media_library_delete_title({ filename: name(chosen) }, options)}</h2>
      <div id="del-d">
        <p>{m.media_library_delete_intro({}, options)}</p>
        <p>{kind === 'images' ? m.media_library_delete_archive_image({}, options) : m.media_library_delete_archive_file({}, options)}</p>
      </div>
      <div class="actions">
        <button class="btn" type="button" disabled={deleting} onclick={closeDialog}>{m.media_library_cancel({}, options)}</button>
        <button class="btn btn-danger" type="button" disabled={deleting} onclick={remove}>
          {deleting ? m.media_library_deleting({}, options) : m.media_library_delete_permanently({}, options)}
        </button>
      </div>
  </Modal>
{/if}
