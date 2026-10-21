<script lang="ts">
import type { Labels, Preset } from '@handover/core';
import { ParaglideMessage } from '@inlang/paraglide-js-svelte';
import { tick } from 'svelte';
import { messageDetail, messageText, type UiMessage } from '../errors.js';
import { messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, isRecord, uncertainResponse } from '../request.js';
import ConfirmDialog from '../shared/ConfirmDialog.svelte';
import MediaImage from '../shared/MediaImage.svelte';
import Crop from './Crop.svelte';
import Focal from './Focal.svelte';
import LibraryDetails from './LibraryDetails.svelte';
import { createMetadataLanes, type MetadataChange } from './metadata-lanes.svelte';
import {
  droppedFiles,
  extension,
  fileSize,
  isLibraryItem,
  type LibraryItem,
  mediaResponse,
  name,
  uploadFile,
  uploadImage,
  uploadMessage,
} from './upload.js';

let {
  base = '',
  presets = [],
  uiLocale = 'en',
}: {
  /** Where a stored key is served from. */
  base?: string;
  /** Every shape this site crops a picture to: what the focal picker previews and Crop offers. */
  presets?: { label: string; labels?: Labels; preset: Preset }[];
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
const lanes = createMetadataLanes({ show: showMetadataDraft });
let trigger = $state<HTMLElement>();
let readEpoch = 0;
const options = $derived(messageOptions(uiLocale));
const textOf = (message: UiMessage) => messageText(message, uiLocale);

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
    lanes.forget(Object.keys(lanes.failures).filter((id) => !items.some((item) => item.id === id)));
  }
  // The panel is about a picture that may no longer be in the list under this search.
  if (chosen)
    chosen = items.find((i) => i.id === chosen?.id) ?? (reconcileSelection ? undefined : chosen);
}

function retryRead(reconcileSelection = false) {
  const epoch = ++readEpoch;
  void load(kind, query, epoch, reconcileSelection);
}

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

async function pick(item: LibraryItem) {
  selectedTile = document.activeElement as HTMLElement;
  chosen = lanes.view(item);
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

function describeChosen(details: MetadataChange) {
  if (chosen) lanes.describe(chosen, details);
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
      row.state = uploadMessage(err);
      row.failed = true;
    }
  }
  if (kind === batchKind && query === batchQuery && readEpoch === batchEpoch) {
    const epoch = ++readEpoch;
    await load(batchKind, batchQuery, epoch);
  }
}

function drop(e: DragEvent) {
  over = false;
  take(droppedFiles(e));
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
    <button class="btn btn-primary" type="button" onclick={() => chooser?.click()}
      >{m.media_library_upload({}, options)}</button
    >
    <label class="visually-hidden" for="lib-file"
      >{m.media_library_files_to_upload({}, options)}</label
    >
    <input
      class="visually-hidden"
      type="file"
      id="lib-file"
      multiple
      accept={kind === 'images' ? 'image/*' : 'application/pdf'}
      bind:this={chooser}
      onchange={(e) => {
        take(Array.from(e.currentTarget.files ?? []));
        e.currentTarget.value = '';
      }}
    />
  </div>
  <div class="media-controls">
    <!-- Buttons rather than links: the kind is not an address of its own. -->
    <div class="tabs lib-tabs" role="tablist" aria-label={m.media_library_kind({}, options)}>
      <button
        type="button"
        role="tab"
        aria-selected={kind === 'images'}
        onclick={() => show('images')}>{m.media_library_images({}, options)}</button
      >
      <button
        type="button"
        role="tab"
        aria-selected={kind === 'files'}
        onclick={() => show('files')}>{m.media_library_files({}, options)}</button
      >
    </div>
    <div class="filters">
      <button
        class={['filter is-toggle', { 'is-on': only.archived }]}
        type="button"
        aria-pressed={only.archived}
        onclick={() => (only.archived = !only.archived)}
        >{m.media_library_archived({}, options)}</button
      >
      {#if kind === 'images'}
        <button
          class={['filter is-toggle', { 'is-on': only.recovered }]}
          type="button"
          aria-pressed={only.recovered}
          onclick={() => (only.recovered = !only.recovered)}
          >{m.media_library_recovered({}, options)}</button
        >
      {/if}
      <button
        class={['filter is-toggle', { 'is-on': only.unused }]}
        type="button"
        aria-pressed={only.unused}
        onclick={() => (only.unused = !only.unused)}>{m.media_library_unused({}, options)}</button
      >
    </div>
    <div class="field search">
      <label class="visually-hidden" for="lib-q">{m.media_library_search({}, options)}</label>
      <input
        class="input"
        id="lib-q"
        type="search"
        placeholder={m.media_library_search_placeholder({}, options)}
        bind:value={query}
      />
    </div>
  </div>
  {#if failure}
    <div class="notice notice-danger library-failure" role="alert">
      <p>{textOf(failure.message)}</p>
      {#if messageDetail(failure.message, uiLocale)}<p class="technical-detail">{messageDetail(failure.message, uiLocale)}</p>{/if}
      {#if failure.recovery}
        <button class="btn btn-sm" type="button" disabled={deleting} onclick={() => failure?.recovery === 'read' ? retryRead() : failure?.recovery === 'reload' ? retryRead(true) : remove()}>
          {failure.recovery === 'reload' ? m.media_library_reload({}, options) : failure.recovery === 'delete' ? m.media_library_retry_delete({}, options) : m.common_retry({}, options)}
        </button>
      {/if}
    </div>
  {/if}
  {#each Object.entries(lanes.failures) as [id, metadataFailure] (id)}
    <div class="notice notice-danger metadata-failure" role="alert">
      <p>{textOf(metadataFailure.message)}</p>
      {#if messageDetail(metadataFailure.message, uiLocale)}<p class="technical-detail">{messageDetail(metadataFailure.message, uiLocale)}</p>{/if}
      {#if metadataFailure.recovery}
        <button class="btn btn-sm" type="button" onclick={() => metadataFailure.recovery === 'reload' ? retryRead(true) : lanes.retry(id)}>
          {metadataFailure.recovery === 'reload' ? m.media_library_reload({}, options) : m.media_library_retry_metadata({ filename: metadataFailure.name }, options)}
        </button>
      {/if}
    </div>
  {/each}
  <div class={['lib-body', { 'has-selection': !!chosen }]}>
    <div class="lib-main">
      <!-- svelte-ignore a11y_no_static_element_interactions -- the child button is the control -->
      <div
        class={['dropzone', { 'is-big': !items.length, 'is-over': over }]}
        ondragover={(e) => {
          e.preventDefault();
          over = true;
        }}
        ondragleave={() => (over = false)}
        ondrop={drop}
      >
        <svg
          class="dz-icon"
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          ><path d="M12 16V4m0 0-4 4m4-4 4 4" /><path
            d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
          /></svg
        >
        <span class="dz-text">
          <span>
            <ParaglideMessage
              message={kind === 'images'
                ? m.media_library_drop_choose_images
                : m.media_library_drop_choose_files}
              inputs={{}}
              {options}
            >
              {#snippet drop({ children })}<b>{@render children?.()}</b>{/snippet}
              {#snippet choose({ children })}<button
                  class="btn-link"
                  type="button"
                  onclick={() => chooser?.click()}>{@render children?.()}</button
                >{/snippet}
            </ParaglideMessage>
          </span>
          <span class="hint"
            >{kind === 'images'
              ? m.media_library_image_hint({}, options)
              : m.media_library_file_hint({}, options)}</span
          >
        </span>
      </div>
      {#if queue.length}
        <ul class="upload-queue">
          {#each queue as row}
            <li class="upload-row">
              <span class="name">{row.name}</span>
              <span class={['state', { 'is-failed': row.failed }]} role={row.failed ? 'alert' : undefined} aria-live={row.failed ? undefined : 'polite'}>{queueText(row.state)}</span>
              {#if typeof row.state !== 'string' && messageDetail(row.state, uiLocale)}<span class="technical-detail">{messageDetail(row.state, uiLocale)}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if loading}
        <p class="placeholder">{m.media_library_loading({}, options)}</p>
      {:else if kind === 'images'}
        <div class="media-grid">
          {#each shown as item (item.id)}
            <article
              class={[
                'tile',
                { 'is-archived': item.archived, 'is-selected': chosen?.id === item.id },
              ]}
            >
              <span class="thumb">
                <MediaImage src={item.url} alt="" {uiLocale} />
                {#if item.archived}<span class="badge flag"
                    >{m.media_library_archived({}, options)}</span
                  >
                {:else if recovered(item)}<span class="badge badge-warn flag"
                    >{m.media_library_recovered({}, options)}</span
                  >{/if}
              </span>
              <!-- The whole card opens the panel; the link is what a keyboard reaches. -->
              <button class="tile-link name" type="button" onclick={() => pick(item)}
                >{name(item)}</button
              >
              <span class="sub">
                <span
                  >{item.width
                    ? `${item.width} × ${item.height}`
                    : fileSize(item.bytes, uiLocale)}</span
                >
                <span class={['badge', { 'is-used': !!item.uses?.length }]}>{count(item)}</span>
              </span>
              <!-- Above the stretched link, so both are reachable. -->
              {#if item.archived}
                <span class="tile-actions"
                  ><button
                    class="btn btn-sm"
                    type="button"
                    aria-label={m.media_library_unarchive_named({ filename: name(item) }, options)}
                    onclick={() => lanes.describe(item, { archived: false })}
                    >{m.media_library_unarchive({}, options)}</button
                  ></span
                >
              {/if}
            </article>
          {:else}
            <p class="hint">
              {query || filtering
                ? m.media_library_no_matches({}, options)
                : m.media_library_empty_images({}, options)}
            </p>
          {/each}
        </div>
      {:else}
        <div class="file-rows">
          {#each shown as item (item.id)}
            <div class={['file-row is-link', { 'is-selected': chosen?.id === item.id }]}>
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
      <LibraryDetails
        {chosen}
        {kind}
        {base}
        {uiLocale}
        recovered={recovered(chosen)}
        usage={count(chosen)}
        bind:panel={detailsPanel}
        bind:tag
        bind:copied
        describe={describeChosen}
        onclose={closeDetails}
        onframe={() => (framing = true)}
        oncrop={() => (cropping = true)}
        ondelete={ask}
      />
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
    onsave={(point) => { describeChosen({ focal: point }); framing = false; }}
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
  <ConfirmDialog
    labelledby="del-h"
    describedby="del-d"
    initialFocus=".actions .btn"
    returnTo={trigger}
    title={m.media_library_delete_title({ filename: name(chosen) }, options)}
    cancel={m.common_cancel({}, options)}
    confirm={deleting ? m.media_library_deleting({}, options) : m.media_library_delete_permanently({}, options)}
    busy={deleting}
    onconfirm={remove}
    onclose={closeDialog}
  >
    <div id="del-d">
      <p>{m.media_library_delete_intro({}, options)}</p>
      <p>{kind === 'images' ? m.media_library_delete_archive_image({}, options) : m.media_library_delete_archive_file({}, options)}</p>
    </div>
  </ConfirmDialog>
{/if}
