<script lang="ts">
import { entryName } from '@handover/core';

type Entry = { id: string; locales: Record<string, { title: string; path: string }> };
let { collection, onchanged }: { collection: string; onchanged: () => void } = $props();

let entries = $state<Entry[]>([]);
let loading = $state(true);
let dialog = $state<'' | 'new' | 'rename' | 'delete'>('');
let target = $state<Entry>();
let text = $state('');
let busy = $state(false);
let error = $state('');
let field = $state<HTMLInputElement>();

$effect(() => {
  load(collection);
});
$effect(() => {
  field?.focus();
});

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const singular = $derived(collection.replace(/s$/, ''));
const titleOf = (entry: Entry) => entry.locales.en?.title || entry.id;

// The same derivation the server runs on the same names, so the dialog can promise the file
// name before anything is written. A rename does not collide with the entry being renamed.
const preview = $derived(
  entryName(
    'default',
    text,
    entries.map((e) => e.id).filter((id) => dialog !== 'rename' || id !== target?.id),
  ),
);

async function load(name: string) {
  const res = await fetch(`/admin/api/entries/${name}`);
  if (res.ok) entries = ((await res.json()) as { entries: Entry[] }).entries;
  else error = `Could not load the list (${res.status})`;
  loading = false;
}

function open(kind: 'new' | 'rename' | 'delete', entry?: Entry) {
  dialog = kind;
  target = entry;
  text = kind === 'rename' ? (entry?.id ?? '') : '';
  error = '';
}
const close = () => {
  dialog = '';
  error = '';
};

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// A 409 is the server's own sentence — "publish this first", "someone else changed it" —
// and reads better than anything this component could say about it.
async function send(url: string, init: RequestInit) {
  busy = true;
  error = '';
  const res = await fetch(url, init);
  busy = false;
  if (res.ok) return res;
  error = res.status === 409 ? await res.text() : `That did not work (${res.status})`;
  return undefined;
}

async function create(event: Event) {
  event.preventDefault();
  const res = await send(`/admin/api/entries/${collection}`, json({ title: text }));
  if (!res) return;
  const { slug } = (await res.json()) as { slug: string };
  location.assign(`/admin/c/${collection}/${slug}`);
}

async function rename(event: Event) {
  event.preventDefault();
  const url = `/admin/api/entries/${collection}/${target?.id}/rename`;
  if (!(await send(url, json({ to: text })))) return;
  await done();
}

async function remove() {
  const url = `/admin/api/entries/${collection}/${target?.id}`;
  if (!(await send(url, { method: 'DELETE' }))) return;
  await done();
}

// The list and the unpublished-changes count both moved; neither is this component's to keep.
async function done() {
  close();
  await load(collection);
  onchanged();
}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<main class="main">
  <div class="list-toolbar">
    <h1>{capitalise(collection)} <span class="count">{entries.length}</span></h1>
    <span class="spacer"></span>
    <button class="btn btn-primary" type="button" onclick={() => open('new')}>New {singular}</button>
  </div>
  {#if error && !dialog}<p class="notice notice-danger" role="alert">{error}</p>{/if}
  {#if loading}
    <p class="placeholder">Loading…</p>
  {:else if entries.length}
    <div class="table cols-3" role="table" aria-label={capitalise(collection)}>
      <div class="th" role="columnheader">Title</div>
      <div class="th" role="columnheader">File name</div>
      <div class="th"><span class="visually-hidden">Actions</span></div>
      {#each entries as entry (entry.id)}
        <div class="row">
          <div class="td title">
            <a href="/admin/c/{collection}/{entry.id}">{titleOf(entry)}</a>
          </div>
          <div class="td num filename" data-label="File name">{entry.id}</div>
          <div class="td menu-cell">
            <button
              class="btn btn-sm"
              type="button"
              aria-label="Rename {titleOf(entry)}"
              onclick={() => open('rename', entry)}>Rename</button
            >
            <button
              class="btn btn-sm"
              type="button"
              aria-label="Delete {titleOf(entry)}"
              onclick={() => open('delete', entry)}>Delete</button
            >
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="empty">
      <div>
        <h2>No {collection} yet</h2>
        <p>Every {singular} is one file under <code>src/content/{collection}/</code>.</p>
        <button class="btn btn-primary" type="button" onclick={() => open('new')}>
          New {singular}
        </button>
      </div>
    </div>
  {/if}
</main>

<!-- Not aria-modal: the shell behind stays reachable until the design gate gives these the
     drawer's inert treatment, and claiming a trap that is not there is worse than not claiming it. -->
{#if dialog}
  <div class="scrim">
    <div class="dialog" role="dialog" aria-labelledby="entry-dialog-h">
      {#if dialog === 'delete'}
        <h2 id="entry-dialog-h">Delete {titleOf(target as Entry)}?</h2>
        <p>
          The file leaves the repository in one commit and its old address redirects to the
          {singular} list. Unpublished changes to it are dropped.
        </p>
        {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
        <div class="actions">
          <button class="btn" type="button" onclick={close}>Cancel</button>
          <button class="btn btn-danger" type="button" disabled={busy} onclick={remove}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      {:else if dialog === 'rename'}
        <h2 id="entry-dialog-h">Rename {titleOf(target as Entry)}</h2>
        <form onsubmit={rename}>
          <div class="field">
            <div class="label-row"><label for="rename-to">File name</label></div>
            <input
              class="input filename"
              id="rename-to"
              type="text"
              bind:value={text}
              bind:this={field}
              aria-describedby="rename-hint"
            />
            <p class="hint" id="rename-hint">
              Saved as <span class="filename">{preview}</span>. The old address redirects to the new
              one.
            </p>
          </div>
          {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
          <div class="actions">
            <button class="btn" type="button" onclick={close}>Cancel</button>
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Renaming…' : 'Rename'}
            </button>
          </div>
        </form>
      {:else}
        <h2 id="entry-dialog-h">New {singular}</h2>
        <form onsubmit={create}>
          <div class="field">
            <div class="label-row"><label for="new-title">Title</label></div>
            <input
              class="input"
              id="new-title"
              type="text"
              bind:value={text}
              bind:this={field}
              aria-describedby="new-hint"
            />
            <p class="hint" id="new-hint">
              Saved as <span class="filename">{preview}</span>. This becomes the web address.
            </p>
          </div>
          {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
          <div class="actions">
            <button class="btn" type="button" onclick={close}>Cancel</button>
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      {/if}
    </div>
  </div>
{/if}
