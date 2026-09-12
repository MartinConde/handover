<script lang="ts" module>
/** `listings` → `listing`: what the buttons, the heading and the empty state call one of them. */
export const nameOf = (collection: string) => collection.replace(/s$/, '');
</script>

<script lang="ts">
import { request as fetch } from './request.js';

import { entryName } from '@handover/core';
import { invalidateEntryDirectory } from './entry-directory.js';
import Modal from './Modal.svelte';
import { navigate } from './navigate';

let { collection, onclose }: { collection: string; onclose: () => void } = $props();

// Read when the dialog opens, so the dashboard opens it exactly as the list does.
let taken = $state<string[]>([]);
let templates = $state<string[]>([]);
let text = $state('');
let starter = $state('');
let busy = $state(false);
let error = $state('');
let directoryLoading = $state(true);
let directoryCurrent = $state(false);
let directoryError = $state('');
let loadRequest = 0;

$effect(() => {
  load(collection);
});

async function load(name: string) {
  const mine = ++loadRequest;
  directoryLoading = true;
  directoryError = '';
  const res = await fetch(`/admin/api/entries/${name}`);
  if (mine !== loadRequest) return;
  directoryLoading = false;
  if (!res.ok) {
    directoryCurrent = false;
    directoryError = `Could not check existing ${name}. Check the connection and try again.`;
    return;
  }
  const body = (await res.json()) as { entries?: { id: string }[]; templates?: string[] };
  if (mine !== loadRequest) return;
  taken = (body.entries ?? []).map((entry) => entry.id);
  templates = body.templates ?? [];
  directoryCurrent = true;
}

const singular = $derived(nameOf(collection));
// The same derivation the server runs, so the dialog can promise the file name.
const preview = $derived(entryName('default', text, taken));
// `flat-by-the-sea` → `Flat by the sea`, which is all a file name has to say to be picked.
const starterLabel = (name: string) => {
  const words = name.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// A 409 or a 503 is the server's own sentence and reads better than anything said here.
async function create(event: Event) {
  event.preventDefault();
  if (!directoryCurrent) return;
  busy = true;
  error = '';
  const res = await fetch(`/admin/api/entries/${collection}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: text, ...(starter ? { template: starter } : {}) }),
  });
  busy = false;
  if (!res.ok) {
    error =
      res.status === 409 || res.status === 503
        ? await res.text()
        : `That did not work (${res.status})`;
    return;
  }
  const { slug } = (await res.json()) as { slug: string };
  invalidateEntryDirectory();
  navigate(`/admin/c/${collection}/${slug}`);
}
</script>

<Modal labelledby="new-entry-h" initialFocus="#new-title" dismissible={!busy} {onclose}>
    <h2 id="new-entry-h">New {singular}</h2>
    <form onsubmit={create}>
      <div class="field">
        <div class="label-row"><label for="new-title">Title</label></div>
        <input
          class="input"
          id="new-title"
          type="text"
          bind:value={text}
          aria-describedby="new-hint"
        />
        <p class="hint" id="new-hint">
          {#if directoryCurrent}
            Saved as <span class="filename">{preview}</span>. This becomes the web address.
          {:else if directoryLoading}
            Checking the available file name…
          {:else}
            The available file name could not be checked.
          {/if}
        </p>
      </div>
      {#if directoryError}
        <div class="notice notice-danger entry-read-error" role="alert">
          {directoryError}
          <button class="btn-link" type="button" onclick={() => load(collection)}>Retry</button>
        </div>
      {/if}
      {#if templates.length}
        <fieldset>
          <legend>Start from</legend>
          <label class="choice">
            <input type="radio" name="starter" value="" bind:group={starter} /> Blank
          </label>
          {#each templates as name (name)}
            <label class="choice">
              <input type="radio" name="starter" value={name} bind:group={starter} />
              {starterLabel(name)} <span class="desc">template</span>
            </label>
          {/each}
        </fieldset>
      {/if}
      {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
      <div class="actions">
        <button class="btn" type="button" disabled={busy} onclick={onclose}>Cancel</button>
        <button class="btn btn-primary" type="submit" disabled={busy || !directoryCurrent}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
</Modal>
