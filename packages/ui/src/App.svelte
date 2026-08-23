<script lang="ts">
import Editor from './Editor.svelte';
import EntryList from './EntryList.svelte';
import Login from './Login.svelte';
import Pending from './Pending.svelte';

let { authed, path }: { authed: boolean; path: string } = $props();
// svelte-ignore state_referenced_locally -- the prop is the initial value on purpose
let loggedIn = $state(authed);

const entryRoute = $derived(path.match(/^\/admin\/c\/([\w-]+)\/([\w-]+)$/));
const listRoute = $derived(path.match(/^\/admin\/c\/([\w-]+)$/));

let collections = $state<string[]>([]);
let pending = $state<{ path: string; updated_at: number }[]>([]);
let indicator = $state<HTMLButtonElement>();
let drawer = $state(false);
// Bumped when a screen's data has moved under it — the screen is thrown away and made again.
let reload = $state(0);

$effect(() => {
  if (!loggedIn) return;
  loadPending();
  loadCollections();
});

// Ping answers 401 until there is a session, so the collections arrive after the login form
// hands over, not with the page.
async function loadCollections() {
  const res = await fetch('/admin/api/ping');
  if (res.ok) collections = ((await res.json()) as { collections: string[] }).collections;
}

async function loadPending() {
  const res = await fetch('/admin/api/drafts');
  if (res.ok) pending = ((await res.json()) as { files: typeof pending }).files;
}

async function loadEntry(collection: string, slug: string) {
  const res = await fetch(`/admin/api/entries/${collection}/${slug}`);
  if (!res.ok)
    throw new Error(
      res.status === 404 ? 'No such entry' : `Could not load the entry (${res.status})`,
    );
  return res.json();
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
</script>

{#if !loggedIn}
  <Login onlogin={() => (loggedIn = true)} />
{:else}
<div class="shell">
  <aside class="sidebar" aria-label="Main" inert={drawer}>
    <div class="site-name"><span class="site-mark" aria-hidden="true">H</span> Handover</div>
    <nav class="nav">
      <div class="nav-group">
        <a href="/admin" data-icon="dashboard" aria-current={path === '/admin' ? 'page' : undefined}>Dashboard</a>
      </div>
    </nav>
    <nav class="nav" aria-labelledby="nav-content">
      <div class="nav-label" id="nav-content">Content</div>
      <div class="nav-group">
        {#each collections as name (name)}
          <a
            href="/admin/c/{name}"
            data-icon={name}
            aria-current={(listRoute ?? entryRoute)?.[1] === name ? 'page' : undefined}
          >{capitalise(name)}</a>
        {/each}
      </div>
    </nav>
  </aside>
  <div class="shell-body" inert={drawer}>
    <header class="topbar">
      <button
        class="indicator"
        class:is-lit={pending.length}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={drawer}
        onclick={() => (drawer = true)}
        bind:this={indicator}
      >
        <span class="dot" aria-hidden="true"></span>
        {pending.length ? `${pending.length} unpublished change${pending.length === 1 ? '' : 's'}` : 'No unpublished changes'}
      </button>
      <span class="spacer"></span>
      <span class="pill pill-live"><span class="dot" aria-hidden="true"></span> Live</span>
      <div class="user-menu"></div>
    </header>
    {#key reload}
    {#if entryRoute}
      {#await loadEntry(entryRoute[1] ?? '', entryRoute[2] ?? '')}
        <main class="main"><p class="placeholder">Loading…</p></main>
      {:then entry}
        <Editor
          collection={entryRoute[1] ?? ''}
          slug={entryRoute[2] ?? ''}
          {entry}
          onpublish={async () => {
            await loadPending();
            drawer = true;
          }}
        />
      {:catch error}
        <main class="main"><p class="notice notice-danger" role="alert">{error.message}</p></main>
      {/await}
    {:else if listRoute}
      <EntryList collection={listRoute[1] ?? ''} onchanged={loadPending} />
    {:else}
      <main class="main">
        <h1>Dashboard</h1>
      </main>
    {/if}
    {/key}
  </div>
  {#if drawer}
    <Pending
      files={pending}
      onclose={() => {
        drawer = false;
        indicator?.focus();
      }}
      onpublished={loadPending}
      ondiscarded={async () => {
        await loadPending();
        reload += 1;
      }}
    />
  {/if}
</div>
{/if}
