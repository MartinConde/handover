<script lang="ts">
import Editor from './Editor.svelte';
import EntryList from './EntryList.svelte';
import Login from './Login.svelte';
import Pending from './Pending.svelte';

export interface Session {
  collections: string[];
  user: { id: string; name: string; email: string };
  role: 'owner' | 'editor';
}

let { session: signedIn, path }: { session: Session | null; path: string } = $props();
// svelte-ignore state_referenced_locally -- the prop is the initial value on purpose; the
// shell reloads it itself after a sign-in or a sign-out
let session = $state(signedIn);

const entryRoute = $derived(path.match(/^\/admin\/c\/([\w-]+)\/([\w-]+)$/));
const listRoute = $derived(path.match(/^\/admin\/c\/([\w-]+)$/));

// Members and Settings are owner-only in the screen inventory, so an editor's sidebar has
// neither. The screens themselves land later; until then the shell names the route it is on
// rather than quietly showing the dashboard under a Manage heading.
const MANAGE = [
  { path: '/admin/media', icon: 'media', label: 'Media', ownerOnly: false },
  { path: '/admin/activity', icon: 'activity', label: 'Activity', ownerOnly: false },
  { path: '/admin/members', icon: 'members', label: 'Members', ownerOnly: true },
  { path: '/admin/settings', icon: 'settings', label: 'Settings', ownerOnly: true },
];
const manage = $derived(MANAGE.filter((item) => !item.ownerOnly || session?.role === 'owner'));
const managePage = $derived(manage.find((item) => item.path === path));

const collections = $derived(session?.collections ?? []);
let pending = $state<{ path: string; updated_at: number }[]>([]);
let indicator = $state<HTMLButtonElement>();
let drawer = $state(false);
// Bumped when a screen's data has moved under it — the screen is thrown away and made again.
let reload = $state(0);

$effect(() => {
  if (session) loadPending();
});

// Ping answers 401 until there is a session, so the shell's own data arrives after the login
// form hands over, not with the page.
async function loadSession() {
  const res = await fetch('/admin/api/ping');
  session = res.ok ? ((await res.json()) as Session) : null;
}

// The content type is load-bearing: without it Better Auth answers 415 and the session
// outlives the click, so the next person at this browser is still signed in.
async function signOut() {
  await fetch('/admin/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  session = null;
}

async function loadPending() {
  const res = await fetch('/admin/api/drafts');
  if (res.ok) pending = ((await res.json()) as { files: typeof pending }).files;
}

async function loadEntry(collection: string, slug: string) {
  const res = await fetch(`/admin/api/entries/${collection}/${slug}`);
  if (res.ok) return res.json();
  // A 503 is about the repository, not about this entry, so it is the server's own sentence.
  if (res.status === 503) throw new Error(await res.text());
  throw new Error(
    res.status === 404 ? 'No such entry' : `Could not load the entry (${res.status})`,
  );
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const initial = $derived(
  (session?.user.name || session?.user.email || '?').charAt(0).toUpperCase(),
);
</script>

{#if !session}
  <Login onlogin={loadSession} />
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
    <nav class="nav" aria-labelledby="nav-manage">
      <div class="nav-label" id="nav-manage">Manage</div>
      <div class="nav-group">
        {#each manage as item (item.path)}
          <a
            href={item.path}
            data-icon={item.icon}
            aria-current={path === item.path ? 'page' : undefined}
          >{item.label}</a>
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
      <div class="user-menu">
        <span class="avatar" aria-hidden="true">{initial}</span>
        <span class="label">
          <span class="name">{session.user.name || session.user.email}</span>
          <span class="role">{session.role === 'owner' ? 'Owner' : 'Editor'}</span>
        </span>
        <button class="btn" type="button" onclick={signOut}>Sign out</button>
      </div>
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
          onchanged={async () => {
            await loadPending();
            reload += 1;
          }}
        />
      {:catch error}
        <main class="main"><p class="notice notice-danger" role="alert">{error.message}</p></main>
      {/await}
    {:else if listRoute}
      <EntryList collection={listRoute[1] ?? ''} onchanged={loadPending} />
    {:else if managePage}
      <main class="main">
        <h1>{managePage.label}</h1>
        <p class="placeholder">This screen is not built yet.</p>
      </main>
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
