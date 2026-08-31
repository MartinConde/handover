<script lang="ts">
import type { Preset } from '@handover/core';
import Crop from './Crop.svelte';
import Focal from './Focal.svelte';
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

// The search is the table's: a name past the hundredth row is a match nobody could otherwise
// find. The wait is so a client typing a word does not spend a request per letter on it.
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
// A row the reconciliation job wrote: an object that was in the bucket with nothing to say
// what it is. A picture whose size nobody measured is the shape that takes.
const recovered = (item: LibraryItem) => kind === 'images' && !(item.width && item.height);
// Toggles over what is loaded: the list already carries the archived rows, and recovered and
// unused are things the row itself says. On together they narrow together.
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

function pick(item: LibraryItem) {
  chosen = item;
  tag = '';
  copied = '';
  closeDialog();
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

/**
 * The gate is the server's: this button is off while the count says the picture is used, and the
 * request is refused anyway if the count was a build behind what the repository holds.
 */
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
    // The row is read back out of the array: what is in there is the reactive proxy, and the
    // object that went in is not — writing to that one updates nothing on the screen.
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

<main class="main">
  <div class="list-toolbar">
    <h1>Media <span class="count">{heading}</span></h1>
    <span class="spacer"></span>
    <div class="filters">
      <button class="filter" class:is-on={only.archived} type="button" aria-pressed={only.archived} onclick={() => (only.archived = !only.archived)}>Archived</button>
      {#if kind === 'images'}
        <button class="filter" class:is-on={only.recovered} type="button" aria-pressed={only.recovered} onclick={() => (only.recovered = !only.recovered)}>Recovered</button>
      {/if}
      <button class="filter" class:is-on={only.unused} type="button" aria-pressed={only.unused} onclick={() => (only.unused = !only.unused)}>Unused</button>
    </div>
    <div class="field search">
      <label class="visually-hidden" for="lib-q">Search media</label>
      <input class="input" id="lib-q" type="search" placeholder="Search by file name or tag" bind:value={query} />
    </div>
    <button class="btn btn-primary" type="button" onclick={() => chooser?.click()}>Upload</button>
    <label class="visually-hidden" for="lib-file">Files to upload</label>
    <input class="visually-hidden" type="file" id="lib-file" multiple accept={kind === 'images' ? 'image/*' : 'application/pdf'} bind:this={chooser} onchange={(e) => { take(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = ''; }} />
  </div>
  <!-- Buttons rather than links: the kind is not an address of its own, and the grid under
       them is what changes. -->
  <div class="tabs lib-tabs" role="tablist" aria-label="Media kind">
    <button type="button" role="tab" aria-selected={kind === 'images'} onclick={() => show('images')}>Images</button>
    <button type="button" role="tab" aria-selected={kind === 'files'} onclick={() => show('files')}>Files</button>
  </div>
  {#if failure}<p class="notice notice-danger" role="alert">{failure}</p>{/if}
  <div class="lib-body">
    <div class="lib-main">
      <!-- svelte-ignore a11y_no_static_element_interactions -- the toolbar's Upload is the
           control; the zone is a drop target -->
      <div class="dropzone" class:is-big={!items.length} class:is-over={over} ondragover={(e) => { e.preventDefault(); over = true; }} ondragleave={() => (over = false)} ondrop={drop}>
        <span>Drop {kind === 'images' ? 'images' : 'files'} here to upload</span>
        <span class="hint">{kind === 'images' ? 'JPEG, PNG, WebP or HEIC' : 'PDF'} up to 10 MB</span>
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
                <img src={item.url} alt="" />
                {#if item.archived}<span class="badge flag">Archived</span>
                {:else if recovered(item)}<span class="badge badge-warn flag">Recovered</span>{/if}
              </span>
              <!-- The whole card opens the panel; the link is what a keyboard reaches. -->
              <button class="tile-link name" type="button" onclick={() => pick(item)}>{name(item)}</button>
              <span class="sub">
                <span>{item.width ? `${item.width} × ${item.height}` : fileSize(item.bytes)}</span>
                <span class="badge">{count(item)}</span>
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
    {#if !chosen}
      <aside class="lib-side" aria-label="Selected item">
        <p class="side-title">Nothing selected</p>
        <p class="empty-side">Choose {kind === 'images' ? 'an image' : 'a file'} to see where it is used and what it is called.</p>
      </aside>
    {:else}
      <aside class="lib-side" class:is-recovered={recovered(chosen)} aria-labelledby="lib-side-h">
        <p class="side-title" id="lib-side-h">{name(chosen)}</p>
        {#if kind === 'images'}
          <div class="preview">
            <img src={chosen.url} alt="" />
            <span class="focal" style="left: {dot(chosen)[0]}%; top: {dot(chosen)[1]}%" aria-hidden="true"></span>
          </div>
        {:else}
          <span class="file-icon is-big" aria-hidden="true">{extension(chosen)}</span>
        {/if}
        {#if recovered(chosen)}
          <p class="notice">Recovered: this file was found in storage without a record, probably from an interrupted upload.</p>
        {/if}
        <dl class="facts">
          <div>
            <dt>{kind === 'images' ? 'Image' : 'File'}</dt>
            <dd>{[chosen.width ? `${chosen.width} × ${chosen.height}` : '', fileSize(chosen.bytes), extension(chosen)].filter(Boolean).join(' · ')}</dd>
          </div>
          <div><dt>Stored as</dt><dd class="sub">{chosen.src}</dd></div>
          <div class="usage">
            <dt>Used</dt>
            <dd>
              {#if chosen.uses?.length}
                <details>
                  <summary><span class="badge">{count(chosen)}</span></summary>
                  <ul class="usage-list">
                    {#each chosen.uses as use (use.entry)}
                      <li><a href={use.href}>{use.title}</a><span class="where">{use.entry.split('/')[0]}</span></li>
                    {/each}
                  </ul>
                </details>
              {:else}
                <span class="badge">not used yet</span>
              {/if}
            </dd>
          </div>
          {#if chosen.createdAt}<div><dt>Uploaded</dt><dd>{when(chosen.createdAt)}</dd></div>{/if}
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
        {#if kind === 'images'}
          <p class="hint">The dot is this picture's default focal point. A page that set its own keeps it.</p>
        {/if}
        <div class="actions">
          {#if kind === 'images'}
            <button class="btn btn-sm" type="button" onclick={() => (framing = true)}>Set focal point</button>
            <!-- A picture nobody measured cannot be cropped: the region is in pixels the row
                 does not have. The reconciliation job's rows are the ones this is about. -->
            <button class="btn btn-sm" type="button" disabled={!(chosen.width && chosen.height)} onclick={() => (cropping = true)}>Crop</button>
          {/if}
          <button class="btn btn-sm archive" type="button" onclick={() => describe({ archived: !chosen?.archived })}>{chosen.archived ? 'Unarchive' : 'Archive'}</button>
          <button class="btn btn-sm" type="button" onclick={() => chosen && copyUrl(chosen)}>{copied === chosen.id ? 'Copied' : 'Copy URL'}</button>
          <button class="btn btn-ghost btn-quiet-danger delete" type="button" disabled={!!chosen.uses?.length} onclick={ask}>Delete</button>
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
      // The copy is a picture of its own: it goes to the front of the library and the panel
      // moves to it, which is also how the client sees that the original is still there.
      items = [{ ...made, tags: [], uses: [] }, ...items.filter((i) => i.id !== made.id)];
      chosen = items[0];
    }}
    onclose={() => (cropping = false)}
  />
{/if}

<!-- Not aria-modal: the shell behind stays reachable, as it does on Members and the entry
     list, and claiming a focus trap that is not there is worse than not claiming one. -->
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
