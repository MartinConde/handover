<script lang="ts">
import type { Field } from '@handover/core';
import Fields from './Fields.svelte';

type Data = Record<string, unknown>;
type Problem = { path: string; message: string };
const byPath = (problems: Problem[]) =>
  Object.fromEntries(problems.map((p) => [p.path, p.message]));
let {
  collection,
  slug,
  entry,
  onpublish,
}: {
  collection: string;
  slug: string;
  entry: {
    fields: readonly Field[];
    blocks: Record<string, Field[]>;
    data: Data;
    /** The draft the data came from is ahead of the file in git. */
    pending: boolean;
    /** What the collection schema will not accept yet, by field path. */
    problems: { path: string; message: string }[];
  };
  /** Open the pending-changes drawer, which is where publishing happens. */
  onpublish: () => void;
} = $props();

// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let data = $state<Data>(structuredClone(entry.data));
// The last shape the draft row holds; the loaded data is already in it, hence no write on open.
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let saved = $state(JSON.stringify(entry.data));
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let drafted = $state(entry.pending);
let saving = $state(false);
let saveFailed = $state(false);
// A draft stores whatever was typed, so what the schema still wants is the server's answer to
// every save rather than a reason to refuse one; the publish is where it blocks.
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let problems = $state(byPath(entry.problems));

const json = $derived(JSON.stringify(data));
const missing = $derived(Object.keys(problems));
const title = $derived(typeof data.title === 'string' && data.title ? data.title : slug);
const dirty = $derived(drafted || json !== saved);

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
    const body = (await res.json()) as { pending: boolean; problems: Problem[] };
    drafted = body.pending;
    problems = byPath(body.problems);
  }
}

// Scrolling there is not enough on its own: the count is a button, so it has to land somewhere.
function goToFirst() {
  const field = document.getElementById(`f-${missing[0]}`);
  field?.scrollIntoView({ block: 'center' });
  field?.focus();
}

// Publishing is the drawer's job, over every draft at once; the entry's own edit only has
// to be in D1 before it opens, so a click inside the autosave window is not lost.
async function openDrawer() {
  if (json !== saved) await autosave();
  if (!saveFailed) onpublish();
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
</script>

<main class="main main-editor">
  <header class="entry-header">
    <div class="crumbs">
      <span>{capitalise(collection)}</span><span class="sep" aria-hidden="true">/</span><span>{title}</span>
      <span class="autosave" class:is-saving={saving} class:is-offline={saveFailed}>
        {#if saving}Saving…{:else if saveFailed}Not saved{:else if json !== saved}Unsaved changes{:else}Saved{/if}
      </span>
    </div>
    <div class="title-row">
      <h1>{title}</h1>
      <div class="meta">
        <span class="status"><span class="dot" aria-hidden="true"></span> Live</span>
        {#if missing.length}
          <button class="problems" type="button" onclick={goToFirst}>
            {missing.length} problem{missing.length === 1 ? '' : 's'}
          </button>
        {/if}
      </div>
      <div class="actions">
        <div class="seg" role="group" aria-label="Language">
          <button type="button" aria-pressed="true">EN</button>
          <button type="button" aria-pressed="false" disabled title="Only English is configured">DE</button>
        </div>
        <button class="btn btn-preview" type="button" disabled title="Preview is not available yet">Preview</button>
        <button
          class="btn btn-primary"
          type="button"
          disabled={!dirty || saving || missing.length > 0}
          title={missing.length ? 'Fill in what is missing before publishing this entry' : undefined}
          onclick={openDrawer}
        >Publish…</button>
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
      <Fields fields={entry.fields} blocks={entry.blocks} {problems} bind:root={data} />
    </form>
    <aside class="pane" aria-label="Right pane">
      <div><strong>Right pane</strong>Preview or a second language, later.</div>
    </aside>
  </div>
</main>
