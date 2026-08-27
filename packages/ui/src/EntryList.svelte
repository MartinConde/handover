<script lang="ts">
import { entryName } from '@handover/core';
import HideDialog, { type Target } from './Hide.svelte';

type Entry = {
  id: string;
  locales: Record<string, { title: string; path: string; status?: 'hidden' }>;
  /** The languages it is offered in, absent when that is every language the site declares. */
  offered?: string[];
};
let { collection, onchanged }: { collection: string; onchanged: () => void } = $props();

let entries = $state<Entry[]>([]);
// The languages the site declares, in its own order. One and the column is not drawn at all.
let locales = $state<string[]>([]);
// The page above this collection, which is where a hidden entry's readers go by default.
let index = $state<string>();
let loading = $state(true);
let dialog = $state<'' | 'new' | 'rename' | 'delete'>('');
// The rows the bulk bar is about; checking any one of them reveals the column for all.
let chosen = $state<string[]>([]);
// Which entries the hide dialog is open over — one from a row menu, or the whole selection.
let hiding = $state<string[]>([]);
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
// The first language the entry is written in, in the site's own order: an entry that exists
// in German alone is listed by its German title rather than by its file name.
const titleOf = (entry: Entry) =>
  locales.map((l) => entry.locales[l]?.title).find(Boolean) ||
  Object.values(entry.locales)[0]?.title ||
  entry.id;
const many = $derived(locales.length > 1);
// A language turned off for the entry gets no file, so it is not one still to write.
const offered = (entry: Entry, locale: string) => entry.offered?.includes(locale) ?? true;
// `_status` is the entry's rather than one language's, so any file of it saying so is the answer.
const isHidden = (entry: Entry) => Object.values(entry.locales).some((l) => l.status === 'hidden');
const named = (ids: string[]) =>
  ids.length === 1 ? (entries.find((e) => e.id === ids[0]) ?? undefined) : undefined;

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
  if (res.ok) {
    const body = (await res.json()) as { entries: Entry[]; locales?: string[]; index?: string };
    entries = body.entries;
    locales = body.locales ?? [];
    index = body.index;
  } else error = `Could not load the list (${res.status})`;
  loading = false;
}

// Showing an entry again has no question to ask; hiding one always does.
async function status(ids: string[], hidden: boolean, redirect?: Target) {
  const res = await send(
    `/admin/api/status/${collection}`,
    json({ entries: ids, hidden, redirect }),
  );
  if (!res) return;
  hiding = [];
  chosen = [];
  await done();
}

function open(kind: 'new' | 'rename' | 'delete', entry?: Entry) {
  dialog = kind;
  target = entry;
  text = kind === 'rename' ? (entry?.id ?? '') : '';
  error = '';
}
const close = () => {
  dialog = '';
  hiding = [];
  error = '';
};

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// A 409 is the server's own sentence — "publish this first", "someone else changed it" —
// and reads better than anything this component could say about it. So is the 503 that says
// the App cannot see the repository.
async function send(url: string, init: RequestInit) {
  busy = true;
  error = '';
  const res = await fetch(url, init);
  busy = false;
  if (res.ok) return res;
  error =
    res.status === 409 || res.status === 503
      ? await res.text()
      : `That did not work (${res.status})`;
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
    <div class="table has-select" class:cols-3={!many} class:cols-4={many} role="table" aria-label={capitalise(collection)}>
      <!-- The header cells need a row of their own, and every cell a role: `role="table"`
           with `columnheader` children and nothing between them is aria-required-parent. Both
           wrappers are `display: contents`, so the grid is unchanged. -->
      <div class="row-head" role="row">
        <div class="th" role="columnheader">
          <input
            type="checkbox"
            aria-label="Select all"
            checked={chosen.length === entries.length && entries.length > 0}
            onchange={(e) => (chosen = e.currentTarget.checked ? entries.map((x) => x.id) : [])}
          />
        </div>
        <div class="th" role="columnheader">Title</div>
        {#if many}<div class="th" role="columnheader">Languages</div>{/if}
        <div class="th" role="columnheader">File name</div>
        <div class="th" role="columnheader"><span class="visually-hidden">Actions</span></div>
      </div>
      {#each entries as entry (entry.id)}
        <div class="row" role="row" class:is-selected={chosen.includes(entry.id)}>
          <div class="td" role="cell">
            <input
              type="checkbox"
              aria-label="Select {titleOf(entry)}"
              checked={chosen.includes(entry.id)}
              onchange={(e) =>
                (chosen = e.currentTarget.checked
                  ? [...chosen, entry.id]
                  : chosen.filter((id) => id !== entry.id))}
            />
          </div>
          <div class="td title" role="cell">
            <a href="/admin/c/{collection}/{entry.id}">{titleOf(entry)}</a>
            {#if isHidden(entry)}<span class="badge">Hidden</span>{/if}
          </div>
          {#if many}
            <div class="td" role="cell" data-label="Languages">
              <span class="chips" aria-label="Languages">
                {#each locales as locale (locale)}
                  <span
                    class="chip"
                    class:chip-missing={!entry.locales[locale] && offered(entry, locale)}
                    class:chip-disabled={!offered(entry, locale)}
                    title="{locale}: {offered(entry, locale)
                      ? entry.locales[locale]
                        ? 'written'
                        : 'not written yet'
                      : 'turned off for this entry'}"
                  >{locale.toUpperCase()}</span>
                {/each}
              </span>
            </div>
          {/if}
          <div class="td num filename" role="cell" data-label="File name">{entry.id}</div>
          <div class="td menu-cell" role="cell">
            <button
              class="btn btn-sm"
              type="button"
              disabled={busy}
              aria-label="{isHidden(entry) ? 'Show' : 'Hide'} {titleOf(entry)}"
              onclick={() =>
                isHidden(entry) ? status([entry.id], false) : (hiding = [entry.id])}
              >{isHidden(entry) ? 'Show' : 'Hide'}</button
            >
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
    {#if chosen.length}
      <div class="bulk-bar" role="region" aria-label="Bulk actions">
        {chosen.length} selected
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" type="button" onclick={() => (chosen = [])}>Clear</button>
        <button class="btn btn-sm" type="button" disabled={busy} onclick={() => (hiding = chosen)}>
          Hide {chosen.length} {chosen.length === 1 ? singular : collection}
        </button>
      </div>
    {/if}
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

{#if hiding.length}
  <HideDialog
    what={named(hiding) ? titleOf(named(hiding) as Entry) : `${hiding.length} ${collection}`}
    many={hiding.length > 1}
    {collection}
    {index}
    {busy}
    {error}
    onhide={(target) => status(hiding, true, target)}
    onclose={close}
  />
{/if}

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
