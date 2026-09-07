<script lang="ts">
import type { Preset } from '@handover/core';
import { tick } from 'svelte';
import Crop from './Crop.svelte';
import Focal from './Focal.svelte';
import MediaImage from './MediaImage.svelte';
import { request as fetch, sitePath } from './request.js';
import { fileSize, type LibraryItem, uploadFile, uploadImage } from './upload.js';

let {
  base = '',
  presets = [],
}: {
  /** Where a stored key is served from. */
  base?: string;
  /** Every shape this site crops a picture to: what the focal picker previews and Crop offers. */
  presets?: { label: string; preset: Preset }[];
} = $props();

let kind = $state<'images' | 'files'>('images');
let query = $state('');
let items = $state<LibraryItem[]>([]);
let chosen = $state<LibraryItem>();
let detailsPanel = $state<HTMLElement>();
let selectedTile: HTMLElement | undefined;
let loading = $state(true);
let failure = $state('');
let copied = $state('');
let tag = $state('');
let queue = $state<{ name: string; state: string; failed?: boolean }[]>([]);
let over = $state(false);
let chooser = $state<HTMLInputElement>();
let confirming = $state(false);
/** The two dialogs the panel opens, and neither is open until a picture is. */
let framing = $state(false);
let cropping = $state(false);
/** Cancel, where the answer is no; and the button that opened the dialog, to give focus back. */
let opening = $state<HTMLElement>();
let trigger: HTMLElement | undefined;

$effect(() => {
  opening?.focus();
});

// Debounced so typing a word does not spend a request per letter.
$effect(() => {
  const kinds = kind;
  const q = query;
  const wait = setTimeout(() => load(kinds, q), 200);
  return () => clearTimeout(wait);
});

async function load(kinds: 'images' | 'files', q: string) {
  const res = await fetch(`/admin/api/media?kind=${kinds}&archived=1&q=${encodeURIComponent(q)}`);
  loading = false;
  if (!res.ok) {
    failure = `Could not load the library (${res.status}).`;
    return;
  }
  failure = '';
  items = ((await res.json()) as { media: LibraryItem[] }).media;
  // The panel is about a picture that may no longer be in the list under this search.
  if (chosen) chosen = items.find((i) => i.id === chosen?.id) ?? chosen;
}

const name = (item: LibraryItem) => item.filename ?? item.src.replace(/^\w+\//, '');
const extension = (item: LibraryItem) => (item.mime?.split('/').pop() ?? '').toUpperCase();
const count = (item: LibraryItem) => {
  const n = item.uses?.length ?? 0;
  return n === 0 ? 'not used yet' : n === 1 ? 'used in 1 place' : `used in ${n} places`;
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
  [
    shown.length,
    ...(['archived', 'recovered', 'unused'] as const).filter((f) => only[f]),
    kind === 'images' ? 'images' : 'files',
  ].join(' '),
);
/** Where the crops of this picture hold, in the percentages the dot and `object-position` want. */
const dot = (item: LibraryItem) => [(item.focal?.[0] ?? 0.5) * 100, (item.focal?.[1] ?? 0.5) * 100];
const when = (at?: number) =>
  at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : '';

async function pick(item: LibraryItem) {
  selectedTile = document.activeElement as HTMLElement;
  chosen = item;
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
  const back = confirming ? trigger : undefined;
  confirming = false;
  back?.focus();
}

/** Tags and the default alt are the library's own words, so they are saved as they are typed. */
async function describe(
  details: {
    tags?: string[];
    alt?: string;
    archived?: boolean;
    focal?: [number, number];
  },
  item = chosen,
) {
  if (!item) return;
  const res = await fetch(`/admin/api/media/${item.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(details),
  });
  if (!res.ok) {
    failure = `That change was not saved (${res.status}).`;
    return;
  }
  const saved = ((await res.json()) as { media: LibraryItem }).media;
  items = items.map((i) => (i.id === saved.id ? { ...i, ...saved } : i));
  if (chosen?.id === item.id) chosen = { ...item, ...saved };
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
  const res = await fetch(`/admin/api/media/${item.id}`, { method: 'DELETE' });
  confirming = false;
  // Not `closeDialog`: the tile the button belonged to is about to go with the picture.
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    failure = body?.error ?? `That picture was not deleted (${res.status}).`;
    return;
  }
  failure = '';
  items = items.filter((i) => i.id !== item.id);
  chosen = undefined;
}

async function copyUrl(item: LibraryItem) {
  await navigator.clipboard?.writeText(item.url ?? `${base}/${item.src}`);
  copied = item.id;
}

async function take(files: File[]) {
  for (const file of files) {
    // Read back out of the array: only the proxy in there is reactive, not the object pushed.
    const row = queue[
      queue.push({ name: file.name, state: kind === 'images' ? 'Converting…' : 'Uploading…' }) - 1
    ] as { name: string; state: string; failed?: boolean };
    try {
      const media = kind === 'images' ? await uploadImage(file) : await uploadFile(file);
      const held = items.some((i) => i.id === media.id);
      row.state = held ? 'Already in your library — reused, nothing uploaded' : 'Uploaded';
      items = [{ ...media, tags: [], uses: [] }, ...items.filter((i) => i.id !== media.id)];
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

function show(next: 'images' | 'files') {
  kind = next;
  chosen = undefined;
  queue = [];
}
</script>

<main class="main media-page">
  <div class="list-toolbar">
    <h1>Media <span class="count">{heading}</span></h1>
    <span class="spacer"></span>
    <div class="filters">
      <button class="filter is-toggle" class:is-on={only.archived} type="button" aria-pressed={only.archived} onclick={() => (only.archived = !only.archived)}>Archived</button>
      {#if kind === 'images'}
        <button class="filter is-toggle" class:is-on={only.recovered} type="button" aria-pressed={only.recovered} onclick={() => (only.recovered = !only.recovered)}>Recovered</button>
      {/if}
      <button class="filter is-toggle" class:is-on={only.unused} type="button" aria-pressed={only.unused} onclick={() => (only.unused = !only.unused)}>Unused</button>
    </div>
    <div class="field search">
      <label class="visually-hidden" for="lib-q">Search media</label>
      <input class="input" id="lib-q" type="search" placeholder="Search by file name or tag" bind:value={query} />
    </div>
    <button class="btn btn-primary" type="button" onclick={() => chooser?.click()}>Upload</button>
    <label class="visually-hidden" for="lib-file">Files to upload</label>
    <input class="visually-hidden" type="file" id="lib-file" multiple accept={kind === 'images' ? 'image/*' : 'application/pdf'} bind:this={chooser} onchange={(e) => { take(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = ''; }} />
  </div>
  <!-- Buttons rather than links: the kind is not an address of its own. -->
  <div class="tabs lib-tabs" role="tablist" aria-label="Media kind">
    <button type="button" role="tab" aria-selected={kind === 'images'} onclick={() => show('images')}>Images</button>
    <button type="button" role="tab" aria-selected={kind === 'files'} onclick={() => show('files')}>Files</button>
  </div>
  {#if failure}<p class="notice notice-danger" role="alert">{failure}</p>{/if}
  <div class="lib-body" class:has-selection={!!chosen}>
    <div class="lib-main">
      <!-- svelte-ignore a11y_no_static_element_interactions -- the child button is the control -->
      <div class="dropzone" class:is-big={!items.length} class:is-over={over} ondragover={(e) => { e.preventDefault(); over = true; }} ondragleave={() => (over = false)} ondrop={drop}>
        <svg class="dz-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
        <span class="dz-text">
          <span><b>Drop {kind === 'images' ? 'images' : 'files'} here</b> or <button class="btn-link" type="button" onclick={() => chooser?.click()}>choose {kind === 'images' ? 'images' : 'files'}</button></span>
          <span class="hint">{kind === 'images' ? 'JPEG, PNG, WebP or HEIC' : 'PDF'} up to 10 MB</span>
        </span>
      </div>
      {#if queue.length}
        <ul class="upload-queue">
          {#each queue as row, i (i)}
            <li class="upload-row">
              <span class="name">{row.name}</span>
              <span class="state" class:is-failed={row.failed} role={row.failed ? 'alert' : undefined} aria-live={row.failed ? undefined : 'polite'}>{row.state}</span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if loading}
        <p class="placeholder">Loading…</p>
      {:else if kind === 'images'}
        <div class="media-grid">
          {#each shown as item (item.id)}
            <article class="tile" class:is-archived={item.archived} class:is-selected={chosen?.id === item.id}>
              <span class="thumb">
                <MediaImage src={item.url} alt="" />
                {#if item.archived}<span class="badge flag">Archived</span>
                {:else if recovered(item)}<span class="badge badge-warn flag">Recovered</span>{/if}
              </span>
              <!-- The whole card opens the panel; the link is what a keyboard reaches. -->
              <button class="tile-link name" type="button" onclick={() => pick(item)}>{name(item)}</button>
              <span class="sub">
                <span>{item.width ? `${item.width} × ${item.height}` : fileSize(item.bytes)}</span>
                <span class="badge" class:is-used={!!item.uses?.length}>{count(item)}</span>
              </span>
              <!-- Above the stretched link, so both are reachable. -->
              {#if item.archived}
                <span class="tile-actions"><button class="btn btn-sm" type="button" onclick={() => describe({ archived: false }, item)}>Unarchive<span class="visually-hidden">{` ${name(item)}`}</span></button></span>
              {/if}
            </article>
          {:else}
            <p class="hint">{query || filtering ? 'Nothing here matches that.' : 'Nothing here yet — drop a picture on the box above.'}</p>
          {/each}
        </div>
      {:else}
        <div class="file-rows">
          {#each shown as item (item.id)}
            <div class="file-row is-link" class:is-selected={chosen?.id === item.id}>
              <span class="file-icon" aria-hidden="true">{extension(item)}</span>
              <span class="who">
                <button class="tile-link name" type="button" onclick={() => pick(item)}>{name(item)}</button>
                <span class="sub">{fileSize(item.bytes)} · {item.mime}</span>
              </span>
              <span class="usage"><span class="badge">{count(item)}</span></span>
            </div>
          {:else}
            <p class="hint">{query || filtering ? 'Nothing here matches that.' : 'Nothing here yet — drop a file on the box above.'}</p>
          {/each}
        </div>
      {/if}
    </div>
    {#if chosen}
      <aside class="lib-side" tabindex="-1" bind:this={detailsPanel} class:is-recovered={recovered(chosen)} aria-labelledby="lib-side-h">
        <div class="side-head">
          <button class="btn btn-ghost btn-icon inspector-close" type="button" aria-label="Close media details" onclick={closeDetails}>×</button>
          <p class="side-title" id="lib-side-h">{name(chosen)}</p>
          <p class="side-meta">{[chosen.width ? `${chosen.width} × ${chosen.height}` : '', fileSize(chosen.bytes), extension(chosen), chosen.createdAt ? `uploaded ${when(chosen.createdAt)}` : ''].filter(Boolean).join(' · ')}</p>
        </div>
        {#if kind === 'images'}
          <div class="preview">
            <MediaImage src={chosen.url} alt="" />
            <span class="focal" style="left: {dot(chosen)[0]}%; top: {dot(chosen)[1]}%" aria-hidden="true"></span>
          </div>
          <p class="hint">The dot is this picture's default focal point. A page that set its own keeps it.</p>
          <div class="actions">
            <button class="action" type="button" onclick={() => (framing = true)}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></svg>
              Focal point
            </button>
            <!-- A picture nobody measured cannot be cropped. -->
            <button class="action" type="button" disabled={!(chosen.width && chosen.height)} onclick={() => (cropping = true)}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" /></svg>
              Crop
            </button>
            <button class="action" type="button" onclick={() => chosen && copyUrl(chosen)}>
              {#if copied === chosen.id}
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
                Copied
              {:else}
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                Copy URL
              {/if}
            </button>
          </div>
        {:else}
          <span class="file-icon is-big" aria-hidden="true">{extension(chosen)}</span>
          <div class="actions">
            <button class="action" type="button" onclick={() => chosen && copyUrl(chosen)}>
              {#if copied === chosen.id}
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
                Copied
              {:else}
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                Copy URL
              {/if}
            </button>
          </div>
        {/if}
        {#if recovered(chosen)}
          <p class="notice">Recovered: this file was found in storage without a record, probably from an interrupted upload.</p>
        {/if}
        <dl class="facts">
          <div class="usage">
            <dt>Used</dt>
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
                <span class="badge">not used yet</span>
              {/if}
            </dd>
          </div>
          <div class="stored"><dt>Stored as</dt><dd class="sub" title={chosen.src}>{chosen.src}</dd></div>
        </dl>
        <div class="field">
          <label for="lib-tags">Tags</label>
          <div class="tag-row">
            {#each chosen.tags ?? [] as word (word)}
              <span class="badge">{word} <button type="button" aria-label="Remove tag {word}" onclick={() => describe({ tags: (chosen?.tags ?? []).filter((t) => t !== word) })}>×</button></span>
            {/each}
            <input id="lib-tags" type="text" placeholder="Add a tag" bind:value={tag} onblur={addTag} onkeydown={(e) => { if (e.key !== 'Enter') return; e.preventDefault(); addTag(); }} />
          </div>
          <span class="hint">Tags are what the search above finds a picture by.</span>
        </div>
        {#if kind === 'images'}
          <div class="field">
            <label for="lib-alt">Default alt text</label>
            <textarea class="input textarea" id="lib-alt" value={chosen.alt ?? ''} onchange={(e) => describe({ alt: e.currentTarget.value })}></textarea>
            <span class="hint">Each page can override this — and its own alt text, in its own language, wins there.</span>
          </div>
        {/if}
        <div class="actions is-keep">
          <button class="btn btn-sm btn-ghost archive" type="button" onclick={() => describe({ archived: !chosen?.archived })}>
            {#if chosen.archived}
              <svg aria-hidden="true" viewBox="0 0 24 24"><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h2" /><path d="M20 8v11a2 2 0 0 1-2 2h-2" /><path d="m9 15 3-3 3 3" /><path d="M12 12v9" /></svg>
              Unarchive
            {:else}
              <svg aria-hidden="true" viewBox="0 0 24 24"><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></svg>
              Archive
            {/if}
          </button>
          <button class="btn btn-sm btn-ghost btn-quiet-danger delete" type="button" disabled={!!chosen.uses?.length} onclick={ask}>
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
            Delete
          </button>
        </div>
        <p class="hint delete-hint">
          {#if chosen.uses?.length}
            Delete is off while this {kind === 'images' ? 'picture' : 'file'} is {count(chosen)}. Archiving hides it from the picker and keeps every page working.
          {:else}
            Not used anywhere, so Delete is available. It asks first — and archiving keeps the {kind === 'images' ? 'picture' : 'file'} instead.
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
    onsave={(point) => { describe({ focal: point }); framing = false; }}
    onclose={() => (framing = false)}
  />
{/if}

{#if cropping && chosen}
  <Crop
    item={chosen}
    ratios={presets.map((p) => p.preset.ratio ?? '').filter(Boolean)}
    onmade={(made) => {
      cropping = false;
      // The panel moves to the copy, which is how the client sees the original is still there.
      items = [{ ...made, tags: [], uses: [] }, ...items.filter((i) => i.id !== made.id)];
      chosen = items[0];
    }}
    onclose={() => (cropping = false)}
  />
{/if}

<!-- Not aria-modal: claiming a focus trap that is not there is worse than not claiming one. -->
{#if confirming && chosen}
  <div class="scrim">
    <div class="dialog" role="alertdialog" aria-labelledby="del-h" aria-describedby="del-d">
      <h2 id="del-h">Delete “{name(chosen)}” permanently?</h2>
      <div id="del-d">
        <p>Nothing on the site uses it. This removes the file from storage and cannot be undone.</p>
        <p>If you might want it back, archive it instead — an archived {kind === 'images' ? 'picture' : 'file'} costs nothing and never appears in the picker.</p>
      </div>
      <div class="actions">
        <button class="btn" type="button" bind:this={opening} onclick={closeDialog}>Cancel</button>
        <button class="btn btn-danger" type="button" onclick={remove}>Delete permanently</button>
      </div>
    </div>
  </div>
{/if}
