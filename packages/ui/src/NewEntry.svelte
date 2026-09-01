<script lang="ts" module>
/** `listings` → `listing`: what the buttons, the heading and the empty state call one of them. */
export const nameOf = (collection: string) => collection.replace(/s$/, '');
</script>

<script lang="ts">
import { entryName } from '@handover/core';
import { navigate } from './navigate';

let { collection, onclose }: { collection: string; onclose: () => void } = $props();

// Read when the dialog opens rather than handed in, so the dashboard opens it exactly as the
// list does: the names already taken, for the file-name promise, and the starters beside Blank.
let taken = $state<string[]>([]);
let templates = $state<string[]>([]);
let text = $state('');
let starter = $state('');
let busy = $state(false);
let error = $state('');
let field = $state<HTMLInputElement>();

$effect(() => {
  field?.focus();
});
$effect(() => {
  load(collection);
});

async function load(name: string) {
  const res = await fetch(`/admin/api/entries/${name}`);
  if (!res.ok) return;
  const body = (await res.json()) as { entries?: { id: string }[]; templates?: string[] };
  taken = (body.entries ?? []).map((entry) => entry.id);
  templates = body.templates ?? [];
}

const singular = $derived(nameOf(collection));
// The same derivation the server runs on the same names, so the dialog can promise the file
// name before anything is written.
const preview = $derived(entryName('default', text, taken));
// `flat-by-the-sea` → `Flat by the sea`, which is all a file name has to say to be picked.
const starterLabel = (name: string) => {
  const words = name.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// A 409 or a 503 is the server's own sentence and reads better than anything said here.
async function create(event: Event) {
  event.preventDefault();
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
  navigate(`/admin/c/${collection}/${slug}`);
}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<!-- Not aria-modal: the shell behind stays reachable until the design gate gives these the
     drawer's inert treatment, and claiming a trap that is not there is worse than not claiming it. -->
<div class="scrim">
  <div class="dialog" role="dialog" aria-labelledby="new-entry-h">
    <h2 id="new-entry-h">New {singular}</h2>
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
        <button class="btn" type="button" onclick={onclose}>Cancel</button>
        <button class="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  </div>
</div>
