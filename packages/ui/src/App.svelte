<script lang="ts">
import type { Preset } from '@handover/core';
import Account from './Account.svelte';
import Activity from './Activity.svelte';
import { when } from './activity-line';
import BuildPill, { type Build } from './BuildPill.svelte';
import Dashboard from './Dashboard.svelte';
import Diagnostics from './Diagnostics.svelte';
import EntryList from './EntryList.svelte';
import { invalidateEntryDirectory } from './entry-directory.js';
import Globals from './Globals.svelte';
import Library from './Library.svelte';
import Login, { type LoginMethods } from './Login.svelte';
import Members from './Members.svelte';
import Modal from './Modal.svelte';
import { coordinateEntryReplacement, flushNavigation, navigate } from './navigate';
import Pending from './Pending.svelte';
import Redirects from './Redirects.svelte';
import { request as fetch, localPath, sitePath, uncertainResponse } from './request.js';

export interface Session {
  collections: string[];
  /** Where a stored media key is served from, so a widget can draw what a content file names. */
  mediaBase?: string;
  /** Every shape this site crops a picture to, which is what the focal picker previews. */
  presets?: { label: string; preset: Preset }[];
  /** This build serves `/_preview`, so the editor can offer to show the page before it is live. */
  preview?: boolean;
  /** `site` from astro.config, which the SEO previews print each language's address under. */
  site?: string;
  user: { id: string; name: string; email: string };
  role: 'owner' | 'editor';
}

let {
  session: signedIn,
  path: landedAt,
  query = '',
  methods = { emailLink: false, github: false },
}: {
  session?: Session | null;
  path: string;
  query?: string;
  methods?: LoginMethods;
} = $props();
// svelte-ignore state_referenced_locally -- the prop is only the initial value
let session = $state(signedIn);
let sessionBusy = $state(false);
// svelte-ignore state_referenced_locally -- the prop is the result of the one bootstrap request
let sessionError = $state(
  signedIn === undefined ? 'Could not check whether you are signed in.' : '',
);
// svelte-ignore state_referenced_locally -- the prop is only where the page loaded
let path = $state(landedAt);

const entryRoute = $derived(path.match(/^\/admin\/c\/([\w-]+)\/([\w-]+)(?:\/(history|seo))?$/));
const listRoute = $derived(path.match(/^\/admin\/c\/([\w-]+)$/));
// Redirects are taken out first, or a global called `redirects` would reach neither screen.
const redirectRoute = $derived(path === '/admin/site/redirects');
const globalRoute = $derived(redirectRoute ? null : path.match(/^\/admin\/site\/([\w-]+)$/));
const editing = $derived(
  globalRoute
    ? { collection: 'globals', slug: globalRoute[1] ?? '' }
    : entryRoute
      ? { collection: entryRoute[1] ?? '', slug: entryRoute[2] ?? '', section: entryRoute[3] ?? '' }
      : undefined,
);
/** A tab click must not reread the entry, and `editing` is a new object on every address. */
const editingAt = $derived(editing ? `${editing.collection}/${editing.slug}` : '');
/** Kept here because the reload after a restore remounts the editor. */
let restored = $state<{ entry: string; date: string }>();
const openEntry = $derived.by(() => {
  // Read on purpose: a reload means the entry's files moved under it.
  void reload;
  if (!editingAt) return undefined;
  const [collection = '', slug = ''] = editingAt.split('/');
  return loadEntry(collection, slug);
});

const MANAGE = [
  { path: '/admin/media', icon: 'media', label: 'Media', ownerOnly: false },
  { path: '/admin/activity', icon: 'activity', label: 'Activity', ownerOnly: false },
  { path: '/admin/members', icon: 'members', label: 'Members', ownerOnly: true },
  { path: '/admin/settings', icon: 'settings', label: 'Settings', ownerOnly: true },
];
const manage = $derived(MANAGE.filter((item) => !item.ownerOnly || session?.role === 'owner'));

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
let defaultLocale = $state('');
let pendingStatus = $state<'loading' | 'ready' | 'error'>('loading');
let pendingKnown = $state(false);
let indicator = $state<HTMLButtonElement>();
/** Where the site's newest commit has got to; null on a site with no build status. */
let build = $state<Build | null>(null);
let buildStatus = $state<'loading' | 'ready' | 'error'>('loading');
/** Bumped after a revert: the drawer's account of the publish it undid has to go with it. */
let drawerKey = $state(0);
/** The commit whose revert is waiting to be confirmed. */
let confirmRevert = $state<string>();
let reverting = $state(false);
let revertError = $state('');
let drawer = $state(false);
// Puts the sidebar back over the screen on a phone, where the narrow rule hides it.
let menu = $state(false);
// A disclosure, not role="menu": that role promises arrow keys and a roving tabindex.
let account = $state(false);
// Bumped when a screen's data has moved under it — the screen is thrown away and made again.
let reload = $state(0);
let editorMode = $state<'form' | 'split' | 'canvas'>('form');
// The container is always in the DOM, so a new notice is announced rather than missed.
let notices = $state<{ id: number; text: string }[]>([]);
let noticeSeq = 0;
function notify(text: string) {
  const id = ++noticeSeq;
  notices.push({ id, text });
  setTimeout(() => dismiss(id), 8_000);
}
function dismiss(id: number) {
  notices = notices.filter((n) => n.id !== id);
}

$effect(() => {
  if (session) {
    loadPending();
    loadBuild();
  }
});

// A plain click on an admin route swaps the screen in place; anything else is the browser's.
$effect(() => {
  const moved = () => {
    path = localPath(location.pathname);
    if (session) loadPending();
  };
  const back = async () => {
    const to = location.href;
    if (!(await flushNavigation())) {
      history.pushState({}, '', sitePath(path));
      return;
    }
    if (location.href === to) moved();
  };
  addEventListener('popstate', back);
  addEventListener('handover:navigate', moved);
  return () => {
    removeEventListener('popstate', back);
    removeEventListener('handover:navigate', moved);
  };
});

function follow(event: MouseEvent) {
  // Runs before the toggle: the menu and drawer both re-open from the button that was pressed.
  const inside = (event.target as Element).closest('.user-menu, .sidebar, .menu-button');
  if (!inside) {
    account = false;
    menu = false;
  }
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const a = (event.target as Element).closest('a');
  if (!a || a.target || a.origin !== location.origin) return;
  if (!/^\/admin(\/(?!api\/)|$)/.test(localPath(a.pathname))) return;
  event.preventDefault();
  // A link inside the drawer is what the drawer was opened for.
  menu = false;
  account = false;
  navigate(a.pathname + a.search);
}

// A boolean, not the object: an effect reading `build` would be rebuilt by every poll.
const building = $derived(build?.state === 'building');
// A finished build does not start on its own, and the next publish loads it.
$effect(() => {
  if (!building) return;
  const poll = setInterval(() => void loadBuild(), 10_000);
  return () => clearInterval(poll);
});
// Ping answers 401 until there is a session, so the shell's data arrives after the login form.
async function loadSession() {
  sessionBusy = true;
  const res = await fetch('/admin/api/ping');
  sessionBusy = false;
  if (res.ok) {
    session = (await res.json()) as Session;
    sessionError = '';
    return;
  }
  if (res.status === 401) {
    session = null;
    sessionError = '';
    return;
  }
  if (!session) session = undefined;
  sessionError = 'Could not check whether you are signed in. Check the connection and try again.';
}

// Without the content type Better Auth answers 415 and the session outlives the click.
async function signOut() {
  if (!(await flushNavigation())) return;
  const res = await fetch('/admin/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    notify('Could not sign out. Please try again.');
    return;
  }
  session = null;
}

let pendingRequest = 0;
async function loadPending() {
  const mine = ++pendingRequest;
  pendingStatus = 'loading';
  const res = await fetch('/admin/api/drafts');
  if (mine !== pendingRequest) return;
  if (!res.ok) {
    pendingStatus = 'error';
    return;
  }
  const body = (await res.json()) as { entries?: typeof pending; defaultLocale?: string };
  if (mine !== pendingRequest) return;
  pending = body.entries ?? [];
  defaultLocale = body.defaultLocale ?? '';
  pendingKnown = true;
  pendingStatus = 'ready';
}

/** A publish redeploys the Worker, so this tab may be reloaded before the build finishes. */
let buildRequest = 0;
async function loadBuild() {
  const mine = ++buildRequest;
  buildStatus = 'loading';
  const res = await fetch('/admin/api/build');
  if (mine !== buildRequest) return;
  if (!res.ok) {
    buildStatus = 'error';
    return;
  }
  const body = (await res.json()) as Partial<NonNullable<typeof build>>;
  if (mine !== buildRequest) return;
  // Without `commit_sha` nothing was published yet and the pill reports the worker's own build.
  build = body.state ? { ...body, state: body.state } : null;
  buildStatus = 'ready';
}

/** Every repository commit refreshes the shell-owned views that can move because of it. */
async function commitChanged() {
  invalidateEntryDirectory();
  await Promise.all([loadPending(), loadBuild()]);
}

function askRevert(sha: string) {
  revertError = '';
  confirmRevert = sha;
}

function closeRevert() {
  confirmRevert = undefined;
}

// The pill's and the drawer's Revert are the same inverse commit over whichever sha is named.
async function revert() {
  const sha = confirmRevert;
  if (!sha) return;
  reverting = true;
  let res: Response | undefined;
  const outcome = await coordinateEntryReplacement(undefined, async () => {
    res = await fetch('/admin/api/revert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commit_sha: sha }),
    });
    if (uncertainResponse(res)) throw new TypeError('The revert response was not confirmed.');
    return res.ok;
  });
  reverting = false;
  closeRevert();
  if (!outcome.ok && outcome.reason === 'save') {
    revertError = 'That publish was not reverted because the open entry could not finish saving.';
    return;
  }
  if (!outcome.ok && (outcome.reason === 'uncertain' || outcome.reason === 'reload')) {
    revertError = 'The revert result could not be confirmed. Reload the page before continuing.';
    return;
  }
  if (!outcome.ok) {
    if (!res) {
      revertError = 'The revert result could not be confirmed. Reload the page before continuing.';
      return;
    }
    const body = await res.text();
    // A file that has moved on since is the server's own sentence, and it names the file.
    revertError =
      res.status === 409
        ? ((JSON.parse(body.startsWith('{') ? body : '{}') as { error?: string }).error ?? body)
        : `That publish was not reverted (${res.status}). Nothing was changed.`;
    return;
  }
  await commitChanged();
  notify('Reverted that publish — building');
  // The drawer describes a commit just undone, so it goes with the publish it was about.
  drawerKey += 1;
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

// `oldest`, not "started": a draft row carries when it was last written, not when it began.
const oldest = $derived(Math.min(...pending.map((e) => e.updated_at)));
const held = $derived(pending.filter((e) => e.held_by).length);

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const initial = $derived(
  (session?.user.name || session?.user.email || '?').charAt(0).toUpperCase(),
);
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && ((account = false), (menu = false))} />

{#if session === undefined}
  <main class="main session-unavailable">
    <p class="notice notice-danger" role="alert">{sessionError}</p>
    <button class="btn" type="button" disabled={sessionBusy} onclick={loadSession}>
      {sessionBusy ? 'Checking…' : 'Retry'}
    </button>
  </main>
{:else if !session}
  <Login {methods} {path} {query} onlogin={loadSession} />
{:else}
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -- nested links handle keyboard input -->
<div class="shell" class:is-canvas={Boolean(editing) && editorMode === 'canvas'} onclick={follow}>
  <a class="skip-link" href="#workspace" onclick={(event) => { event.preventDefault(); document.getElementById('workspace')?.focus(); }}>Skip to content</a>
  <!-- A banner, not a toast, since it outlives a page load; the pill is the live region. -->
  {#if building}
    <div class="banner banner-info">
      Publishing — the admin may reload briefly while the site deploys. Your place is kept.
    </div>
  {/if}
  {#if revertError}
    <div class="banner banner-warn" role="alert">{revertError}</div>
  {/if}
  <aside class="sidebar" class:is-open={menu} aria-label="Main" inert={drawer}>
    <a class="site-name" href={sitePath(`/admin`)}><span class="site-mark" aria-hidden="true">H</span><span>Handover<span class="workspace-label">Content workspace</span></span></a>
    <nav class="nav">
      <div class="nav-group">
        <a href={sitePath(`/admin`)} data-icon="dashboard" aria-current={path === '/admin' ? 'page' : undefined}>Dashboard</a>
      </div>
    </nav>
    <!-- Always there, even with no globals: every site has redirects, listed on that screen. -->
    <nav class="nav" aria-labelledby="nav-site">
      <div class="nav-label" id="nav-site">Site</div>
      <div class="nav-group">
        <a
          href={sitePath(`/admin/site`)}
          data-icon="site"
          aria-current={path.startsWith('/admin/site') ? 'page' : undefined}
        >Site settings</a>
      </div>
    </nav>
    <nav class="nav" aria-labelledby="nav-content">
      <div class="nav-label" id="nav-content">Content</div>
      <div class="nav-group">
        {#each collections as name (name)}
          <a
            href={sitePath(`/admin/c/${name}`)}
            data-icon={['listings', 'pages', 'team', 'blog'].includes(name) ? name : 'collection'}
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
            href={sitePath(item.path)}
            data-icon={item.icon}
            aria-current={path === item.path ? 'page' : undefined}
          >{item.label}</a>
        {/each}
      </div>
    </nav>
    {#if session.site}
      <div class="sidebar-footer"><a class="site-link" href={session.site} target="_blank" rel="noreferrer">View website <span aria-hidden="true">↗</span></a></div>
    {/if}
  </aside>
  <div class="shell-body" id="workspace" tabindex="-1" inert={drawer}>
    <header class="topbar">
      <!-- Only on a phone, where the narrow rule has taken the sidebar away. -->
      <button
        class="btn btn-ghost menu-button"
        type="button"
        aria-label="Open menu"
        aria-expanded={menu}
        onclick={() => (menu = !menu)}>☰</button
      >
      <button
        class="indicator"
        class:is-lit={pending.length && pendingKnown}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={drawer}
        disabled={pendingStatus !== 'ready'}
        onclick={() => (drawer = true)}
        bind:this={indicator}
      >
        <span class="dot" aria-hidden="true"></span>
        {#if pendingStatus === 'loading' && !pendingKnown}
          Checking unpublished changes…
        {:else if pendingStatus === 'error' && !pending.length}
          Unpublished changes unavailable
        {:else}
          {pending.length ? `${pending.length} unpublished change${pending.length === 1 ? '' : 's'}` : 'No unpublished changes'}
        {/if}
        {#if pending.length && pendingKnown}
          <span class="detail">
            <span class="sep" aria-hidden="true">·</span>
            oldest {when(oldest).toLowerCase()}
            {#if held}<span class="sep" aria-hidden="true">·</span> {held} on hold{/if}
          </span>
        {/if}
      </button>
      {#if pendingStatus === 'error'}
        <span class="pending-read-error" role="alert">
          {pendingKnown ? 'Count may be out of date.' : 'Could not check unpublished changes.'}
          <button class="btn-link" type="button" onclick={loadPending}>Retry</button>
        </span>
      {/if}
      <span class="spacer"></span>
      <!-- Always in the DOM so the first state is announced; the ticking clock stays out of it. -->
      <span class="build-status" role="status">
        {#if build}
          <BuildPill {build}>
            <!-- Only over the admin's own commit; otherwise the pill is the developer's deploy. -->
            {#if build.state === 'failed' && build.commit_sha}
              <span class="sep" aria-hidden="true">·</span>
              <button class="btn-link" type="button" onclick={() => askRevert(build?.commit_sha ?? '')}>
                Revert last publish
              </button>
            {/if}
          </BuildPill>
        {/if}
      </span>
      {#if buildStatus === 'error'}
        <span class="build-read-error" role="alert">
          {build ? 'Build status may be out of date.' : 'Build status is unavailable.'}
          <button class="btn-link" type="button" onclick={loadBuild}>Retry</button>
        </span>
      {/if}
      <div class="user-menu">
        <button
          class="btn"
          type="button"
          aria-expanded={account}
          aria-label="{session.user.name || session.user.email}, {session.role === 'owner' ? 'Owner' : 'Editor'} — account menu"
          onclick={() => (account = !account)}
        >
          <span class="avatar" aria-hidden="true">{initial}</span>
          <span class="label">
            <span class="name">{session.user.name || session.user.email}</span>
            <span class="role">{session.role === 'owner' ? 'Owner' : 'Editor'}</span>
          </span>
        </button>
        {#if account}
          <div class="menu">
            <!-- Context, not actions: the role is changed on the members screen, never here. -->
            <div class="who">
              <span class="name">
                {session.user.name || session.user.email}
                <span class="badge">{session.role === 'owner' ? 'Owner' : 'Editor'}</span>
              </span>
              <span class="email">{session.user.email}</span>
            </div>
            <a href={sitePath(`/admin/account`)} aria-current={path === '/admin/account' ? 'page' : undefined}
              >Account</a
            >
            <button type="button" onclick={signOut}>Sign out</button>
          </div>
        {/if}
      </div>
    </header>
    <!-- Keyed on the entry rather than on the address, for the reason `editingAt` gives. -->
    {#key `${editingAt || path}#${reload}`}
    {#if editing}
      {#await Promise.all([openEntry, import('./editor/Editor.svelte')])}
        <main class="main"><p class="placeholder">Loading…</p></main>
      {:then [entry, { default: Editor }]}
        <Editor
          collection={editing.collection}
          slug={editing.slug}
          section={editing.section ?? ''}
          {entry}
          mediaBase={session?.mediaBase ?? ''}
          preview={session?.preview ?? false}
          site={session?.site}
          userId={session?.user.id}
          onchanged={async () => {
            invalidateEntryDirectory();
            await loadPending();
            if (await flushNavigation()) reload += 1;
          }}
          onreload={async () => {
            invalidateEntryDirectory();
            await loadPending();
            // Restore/reconciliation already closed the old session. A fresh entry read is what
            // establishes the next save epoch, so it must not ask that closed session to flush.
            reload += 1;
          }}
          onpending={loadPending}
          oncommitted={commitChanged}
          onpublished={async (title) => {
            notify(`Published ${title} — building`);
            await commitChanged();
          }}
          onrestored={(date) => (restored = { entry: editingAt, date })}
          restored={restored?.entry === editingAt ? restored.date : undefined}
          onmode={(mode) => (editorMode = mode)}
        />
      {:catch error}
        <main class="main"><p class="notice notice-danger" role="alert">{error.message}</p></main>
      {/await}
    {:else if listRoute}
      <EntryList
        collection={listRoute[1] ?? ''}
        role={session.role}
        onchanged={() => {
          invalidateEntryDirectory();
          return loadPending();
        }}
        oncommitted={commitChanged}
        onsaved={(name) => notify(`Saved the template ${name}`)}
      />
    {:else if redirectRoute}
      <Redirects oncommitted={commitChanged} />
    {:else if path === '/admin/site'}
      <Globals />
    {:else if path === '/admin/media'}
      <Library base={session?.mediaBase ?? ''} presets={session?.presets ?? []} />
    {:else if path === '/admin/account'}
      <Account user={session.user} role={session.role} onname={loadSession} />
    {:else if path === '/admin/members' && session.role === 'owner'}
      <Members user={session.user} />
    {:else if path === '/admin/activity'}
      <!-- No role condition: which events an editor sees is the server's filter. -->
      <Activity
        role={session.role}
        mediaBase={session.mediaBase ?? ''}
        oncommitted={commitChanged}
      />
    {:else if path === '/admin/settings' && session.role === 'owner'}
      <Diagnostics oncommitted={commitChanged} />
    {:else}
      <Dashboard
        {pending}
        {pendingStatus}
        {build}
        {buildStatus}
        {collections}
        onreview={() => (drawer = true)}
        onrevert={askRevert}
        onretryPending={loadPending}
        onretryBuild={loadBuild}
      />
    {/if}
    {/key}
  </div>
  {#if drawer}
    {#key drawerKey}
    <Pending
      entries={pending}
      {defaultLocale}
      mediaBase={session?.mediaBase ?? ''}
      {build}
      onrevert={askRevert}
      onclose={() => {
        drawer = false;
        indicator?.focus();
      }}
      onpublished={async (count) => {
        notify(`Published ${count} change${count === 1 ? '' : 's'} — building`);
        await commitChanged();
      }}
      ondiscarded={async () => {
        invalidateEntryDirectory();
        await loadPending();
      }}
    />
    {/key}
  {/if}
  <div class="toasts" aria-live="polite">
    {#each notices as notice (notice.id)}
      <div class="toast">
        <div class="body">{notice.text}</div>
        <button class="close" type="button" aria-label="Dismiss" onclick={() => dismiss(notice.id)}>×</button>
      </div>
    {/each}
  </div>
  {#if confirmRevert}
    <Modal
      labelledby="revert-h"
      describedby="revert-p"
      dismissible={!reverting}
      onclose={closeRevert}
    >
        <h2 id="revert-h">Revert this publish?</h2>
        <p id="revert-p">
          The site goes back to how it was before that commit. The changes it carried stay as
          unpublished changes, so you can fix them and publish again.
        </p>
        <div class="actions">
          <button class="btn" type="button" disabled={reverting} onclick={closeRevert}>Cancel</button>
          <button class="btn btn-danger" type="button" disabled={reverting} onclick={revert}>
            {reverting ? 'Reverting…' : 'Revert'}
          </button>
        </div>
    </Modal>
  {/if}
</div>
{/if}
