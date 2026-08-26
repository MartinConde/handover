<script lang="ts">
import Account from './Account.svelte';
import Activity from './Activity.svelte';
import BuildPill, { type Build } from './BuildPill.svelte';
import Editor from './Editor.svelte';
import EntryList from './EntryList.svelte';
import Login, { type LoginMethods } from './Login.svelte';
import Members from './Members.svelte';
import Pending from './Pending.svelte';

export interface Session {
  collections: string[];
  /** Where a stored media key is served from, so a widget can draw what a content file names. */
  mediaBase?: string;
  user: { id: string; name: string; email: string };
  role: 'owner' | 'editor';
}

let {
  session: signedIn,
  path,
  query = '',
  methods = { emailLink: false, github: false },
}: {
  session: Session | null;
  path: string;
  query?: string;
  methods?: LoginMethods;
} = $props();
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
let pending = $state<
  {
    key: string;
    title: string;
    collection: string;
    locales: string[];
    files: string[];
    redirects?: number;
    updated_at: number;
    held_by?: { id: string; name: string | null } | null;
  }[]
>([]);
let indicator = $state<HTMLButtonElement>();
/** Where the site's newest commit has got to; null on a site with no build status. */
let build = $state<Build | null>(null);
/** Bumped after a revert: the drawer's account of the publish it undid has to go with it. */
let drawerKey = $state(0);
/** The commit whose revert is waiting to be confirmed, and where to put focus back. */
let confirmRevert = $state<string>();
let returnTo: HTMLElement | undefined;
let revertPanel = $state<HTMLElement>();
let reverting = $state(false);
let revertError = $state('');
let drawer = $state(false);
// Bumped when a screen's data has moved under it — the screen is thrown away and made again.
let reload = $state(0);

$effect(() => {
  if (session) {
    loadPending();
    loadBuild();
  }
});

// A boolean rather than the object: an effect that read `build` would be torn down and rebuilt
// by every poll, and the interval it had just made would never fire again.
const building = $derived(build?.state === 'building');
// Only worth asking again while something is happening — a build that has finished does not
// start on its own, and the next publish loads it.
$effect(() => {
  if (!building) return;
  const poll = setInterval(() => void loadBuild(), 10_000);
  return () => clearInterval(poll);
});
$effect(() => {
  if (confirmRevert) revertPanel?.focus();
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
  if (res.ok) pending = ((await res.json()) as { entries: typeof pending }).entries;
}

/**
 * Build status is the server's: a publish redeploys the Worker serving this page, so the tab
 * that pressed Publish may be reloaded before the build finishes. `{}` is a site that has
 * committed nothing yet or has no Cloudflare token — no pill at all rather than an empty one.
 */
async function loadBuild() {
  const res = await fetch('/admin/api/build');
  if (!res.ok) return;
  const body = (await res.json()) as Partial<NonNullable<typeof build>>;
  // No `commit_sha` is a site that has published nothing yet: the pill is then reporting the
  // worker's newest build, which is still what the site is serving.
  build = body.state ? { ...body, state: body.state } : null;
}

function askRevert(sha: string) {
  returnTo = document.activeElement as HTMLElement;
  revertError = '';
  confirmRevert = sha;
}

function closeRevert() {
  confirmRevert = undefined;
  returnTo?.focus();
}

// One button for both the pill's *Revert last publish* and the drawer's *Revert this publish*:
// it is the same inverse commit either way, over whichever commit the caller names.
async function revert() {
  const sha = confirmRevert;
  if (!sha) return;
  reverting = true;
  const res = await fetch('/admin/api/revert', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commit_sha: sha }),
  });
  reverting = false;
  closeRevert();
  if (!res.ok) {
    const body = await res.text();
    // A file that has moved on since is the server's own sentence, and it names the file.
    revertError =
      res.status === 409
        ? ((JSON.parse(body.startsWith('{') ? body : '{}') as { error?: string }).error ?? body)
        : `That publish was not reverted (${res.status}). Nothing was changed.`;
    return;
  }
  await Promise.all([loadPending(), loadBuild()]);
  // The drawer's "Published 1 change" describes a commit that has just been undone, and its
  // Revert would now be refused. It goes with the publish it was about.
  drawerKey += 1;
  reload += 1;
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
  <Login {methods} {path} {query} onlogin={loadSession} />
{:else}
<div class="shell">
  <!-- The reload note outlives a page load, so it is a banner and not a toast. It does not
       announce: the pill beside it is the live region, and two of them would talk over
       each other about the same thing. -->
  {#if building}
    <div class="banner banner-info">
      Publishing — the admin may reload briefly while the site deploys. Your place is kept.
    </div>
  {/if}
  {#if revertError}
    <div class="banner banner-warn" role="alert">{revertError}</div>
  {/if}
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
      <!-- The live region is in the DOM whether there is a build or not, so the first state to
           arrive is announced rather than missed. The elapsed time is hidden from it: it ticks
           every second and would say the whole pill again each time. -->
      <span class="build-status" role="status">
        {#if build}
          <BuildPill {build}>
            <!-- Only over a commit the admin itself made: with none, this pill is reporting the
                 developer's own deploy and there is nothing here to take back. -->
            {#if build.state === 'failed' && build.commit_sha}
              <span class="sep" aria-hidden="true">·</span>
              <button class="btn-link" type="button" onclick={() => askRevert(build?.commit_sha ?? '')}>
                Revert last publish
              </button>
            {/if}
          </BuildPill>
        {/if}
      </span>
      <div class="user-menu">
        <a class="btn" href="/admin/account" aria-current={path === '/admin/account' ? 'page' : undefined}>
          <span class="avatar" aria-hidden="true">{initial}</span>
          <span class="label">
            <span class="name">{session.user.name || session.user.email}</span>
            <span class="role">{session.role === 'owner' ? 'Owner' : 'Editor'}</span>
          </span>
        </a>
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
          mediaBase={session?.mediaBase ?? ''}
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
    {:else if path === '/admin/account'}
      <Account user={session.user} role={session.role} onname={loadSession} />
    {:else if path === '/admin/members' && session.role === 'owner'}
      <Members user={session.user} />
    {:else if path === '/admin/activity'}
      <!-- No role condition: the log is an editor's screen as much as an owner's, and which
           events they see is the server's filter rather than this branch's. -->
      <Activity role={session.role} />
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
    {#key drawerKey}
    <Pending
      entries={pending}
      {build}
      onrevert={askRevert}
      onclose={() => {
        drawer = false;
        indicator?.focus();
      }}
      onpublished={async () => {
        await Promise.all([loadPending(), loadBuild()]);
      }}
      ondiscarded={async () => {
        await loadPending();
        reload += 1;
      }}
    />
    {/key}
  {/if}
  <!-- Not aria-modal: the drawer under it stays where it is, and claiming a trap that is not
       there is worse than not claiming it. Escape is stopped here so it does not also reach
       the drawer's own handler and close two things with one press. -->
  {#if confirmRevert}
    <div class="scrim">
      <div
        class="dialog"
        role="dialog"
        aria-labelledby="revert-h"
        aria-describedby="revert-p"
        tabindex="-1"
        bind:this={revertPanel}
        onkeydown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          closeRevert();
        }}
      >
        <h2 id="revert-h">Revert this publish?</h2>
        <p id="revert-p">
          The site goes back to how it was before that commit. The changes it carried stay as
          unpublished changes, so you can fix them and publish again.
        </p>
        <div class="actions">
          <button class="btn" type="button" onclick={closeRevert}>Cancel</button>
          <button class="btn btn-danger" type="button" disabled={reverting} onclick={revert}>
            {reverting ? 'Reverting…' : 'Revert'}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>
{/if}
