<script lang="ts">
import Editor from './Editor.svelte';
import Login from './Login.svelte';
import Pending from './Pending.svelte';

let { authed, path }: { authed: boolean; path: string } = $props();
// svelte-ignore state_referenced_locally -- the prop is the initial value on purpose
let loggedIn = $state(authed);

const entryRoute = $derived(path.match(/^\/admin\/c\/([\w-]+)\/([\w-]+)$/));

let pending = $state<{ path: string; updated_at: number }[]>([]);
let indicator = $state<HTMLButtonElement>();
let drawer = $state(false);

$effect(() => {
  if (loggedIn) loadPending();
});

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
</script>

{#if !loggedIn}
  <Login onlogin={() => (loggedIn = true)} />
{:else}
<div class="shell">
  <aside class="sidebar" aria-label="Main" inert={drawer}>
    <div class="site-name"><span class="site-mark" aria-hidden="true">H</span> Handover</div>
    <nav class="nav">
      <div class="nav-group">
        <a href="/admin" data-icon="dashboard" aria-current={entryRoute ? undefined : 'page'}>Dashboard</a>
      </div>
    </nav>
    <nav class="nav" aria-labelledby="nav-content">
      <div class="nav-label" id="nav-content">Content</div>
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
    {:else}
      <main class="main">
        <h1>Dashboard</h1>
      </main>
    {/if}
  </div>
  {#if drawer}
    <Pending
      files={pending}
      onclose={() => {
        drawer = false;
        indicator?.focus();
      }}
      onpublished={loadPending}
    />
  {/if}
</div>
{/if}
