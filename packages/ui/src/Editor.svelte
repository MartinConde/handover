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
  entry: { fields: readonly Field[]; data: Data; head_sha: string };
} = $props();

// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let data = $state<Data>(structuredClone(entry.data));
// What the page currently holds on the live branch; moves forward on every publish.
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let live = $state({ data: JSON.stringify(entry.data), sha: entry.head_sha });
let busy = $state(false);
let error = $state('');
let published = $state('');

const title = $derived(typeof data.title === 'string' && data.title ? data.title : slug);
const dirty = $derived(JSON.stringify(data) !== live.data);

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
    live = { data: JSON.stringify(data), sha: commit_sha };
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
      <span class="autosave" class:is-saving={busy} class:is-new={!busy && !published}>
        {#if busy}Publishing…{:else if dirty}{published ? 'Unpublished changes' : 'Not saved'}{:else if published}Published {published}{:else}Not saved{/if}
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
      <Fields fields={entry.fields} bind:root={data} />
    </form>
    <aside class="pane" aria-label="Right pane">
      <div><strong>Right pane</strong>Preview or a second language, later.</div>
    </aside>
  </div>
</main>
