<script lang="ts">
import type { Field } from '@handover/core';
import Fields from './Fields.svelte';

type Data = Record<string, unknown>;
let {
  collection,
  slug,
  entry,
}: {
  collection: string;
  slug: string;
  entry: {
    fields: readonly Field[];
    blocks: Record<string, Field[]>;
    data: Data;
    /** The draft the data came from is ahead of the file in git. */
    pending: boolean;
    head_sha: string;
  };
} = $props();

// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let data = $state<Data>(structuredClone(entry.data));
// What the page currently holds on the live branch; moves forward on every publish.
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let live = $state({ data: JSON.stringify(entry.data), sha: entry.head_sha });
// The last shape the draft row holds; the loaded data is already in it, hence no write on open.
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let saved = $state(JSON.stringify(entry.data));
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let drafted = $state(entry.pending);
let saving = $state(false);
let saveFailed = $state(false);
let busy = $state(false);
let error = $state('');
let published = $state('');

const json = $derived(JSON.stringify(data));
const title = $derived(typeof data.title === 'string' && data.title ? data.title : slug);
const dirty = $derived(drafted || json !== live.data);

// Autosave. The wait restarts on every keystroke, so a burst of typing is one write.
$effect(() => {
  if (json === saved) return;
  const timer = setTimeout(autosave, 2000);
  return () => clearTimeout(timer);
});

async function autosave() {
  const sent = json;
  saving = true;
  const res = await fetch(`/admin/api/drafts/${collection}/${slug}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  saving = false;
  saveFailed = !res.ok;
  if (res.ok) {
    saved = sent;
    // Whether the stored draft differs from the file in git is the server's answer, not ours.
    drafted = ((await res.json()) as { pending: boolean }).pending;
  }
}

async function publish() {
  busy = true;
  error = '';
  const res = await fetch(`/admin/api/entries/${collection}/${slug}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data, base_sha: live.sha }),
  });
  busy = false;
  if (res.ok) {
    const { commit_sha } = (await res.json()) as { commit_sha: string };
    live = { data: json, sha: commit_sha };
    saved = json;
    drafted = false;
    published = commit_sha.slice(0, 7);
  } else if (res.status === 409) {
    error = 'Someone else published this entry since you opened it. Reload to see their version.';
  } else {
    error = `Publish failed (${res.status})`;
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
</script>

<main class="main main-editor">
  <header class="entry-header">
    <div class="crumbs">
      <span>{capitalise(collection)}</span><span class="sep" aria-hidden="true">/</span><span>{title}</span>
      <span class="autosave" class:is-saving={busy || saving} class:is-offline={saveFailed}>
        {#if busy}Publishing…{:else if saving}Saving…{:else if saveFailed}Not saved{:else if json !== saved}Unsaved changes{:else if published}Published {published}{:else}Saved{/if}
      </span>
    </div>
    <div class="title-row">
      <h1>{title}</h1>
      <div class="meta">
        <span class="status"><span class="dot" aria-hidden="true"></span> Live</span>
      </div>
      <div class="actions">
        <div class="seg" role="group" aria-label="Language">
          <button type="button" aria-pressed="true">EN</button>
          <button type="button" aria-pressed="false" disabled title="Only English is configured">DE</button>
        </div>
        <button class="btn btn-preview" type="button" disabled title="Preview is not available yet">Preview</button>
        <button class="btn btn-primary" type="button" disabled={!dirty || busy} onclick={publish}>Publish this entry</button>
        <button class="btn btn-ghost" type="button" disabled aria-label="More actions">⋯</button>
      </div>
    </div>
    <div class="tabs" role="tablist" aria-label="Entry sections">
      <button type="button" role="tab" aria-selected="true">Content</button>
      <button type="button" role="tab" aria-selected="false" disabled>SEO</button>
      <button type="button" role="tab" aria-selected="false" disabled>History</button>
    </div>
  </header>
  <div class="entry-body has-pane">
    <form class="form" onsubmit={(e) => e.preventDefault()}>
      {#if error}<p class="notice notice-danger" role="alert">{error}</p>{/if}
      <Fields fields={entry.fields} blocks={entry.blocks} bind:root={data} />
    </form>
    <aside class="pane" aria-label="Right pane">
      <div><strong>Right pane</strong>Preview or a second language, later.</div>
    </aside>
  </div>
</main>
