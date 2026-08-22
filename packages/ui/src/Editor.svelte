<script lang="ts">
import type { Field } from '@handover/core';

type Data = Record<string, unknown>;
let {
  collection,
  slug,
  entry,
}: { collection: string; slug: string; entry: { fields: readonly Field[]; data: Data } } = $props();

// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let data = $state<Data>(structuredClone(entry.data));

const title = $derived(typeof data.title === 'string' && data.title ? data.title : slug);

function read(path: readonly string[]): string {
  const value = path.reduce<unknown>((node, key) => (node as Data | undefined)?.[key], data);
  return typeof value === 'string' ? value : '';
}

function write(path: readonly string[], value: string) {
  let node = data;
  for (const key of path.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Data;
  }
  node[path[path.length - 1] as string] = value;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const label = (path: readonly string[]) => path.map(capitalise).join(' · ');
</script>

<main class="main main-editor">
  <header class="entry-header">
    <div class="crumbs">
      <span>{capitalise(collection)}</span><span class="sep" aria-hidden="true">/</span><span>{title}</span>
      <span class="autosave is-new">Not saved</span>
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
        <button class="btn btn-primary" type="button" disabled title="Publishing is not available yet">Publish this entry</button>
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
      {#each entry.fields as field (field.path.join('.'))}
        {@const id = `f-${field.path.join('.')}`}
        <div class="field">
          {#if field.type === 'text'}
            <label for={id}>{label(field.path)}{#if field.required}<span class="req" aria-hidden="true">*</span>{/if}</label>
            {#if read(field.path).length > 80}
              <textarea class="input textarea" {id} value={read(field.path)} oninput={(e) => write(field.path, e.currentTarget.value)}></textarea>
            {:else}
              <input class="input" {id} type="text" value={read(field.path)} oninput={(e) => write(field.path, e.currentTarget.value)} />
            {/if}
          {:else}
            <label for={id}>{label(field.path)}</label>
            <p class="hint" {id}>Not editable here yet</p>
          {/if}
        </div>
      {/each}
    </form>
    <aside class="pane" aria-label="Right pane">
      <div><strong>Right pane</strong>Preview or a second language, later.</div>
    </aside>
  </div>
</main>
