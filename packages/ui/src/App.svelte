<script lang="ts">
import type { Preset, UiLocale } from '@handover/core';
import Account from './account/Account.svelte';
import Activity from './account/Activity.svelte';
import Diagnostics from './account/Diagnostics.svelte';
import Login, { type LoginMethods } from './account/Login.svelte';
import Members from './account/Members.svelte';
import EntryList from './content/EntryList.svelte';
import Globals from './content/Globals.svelte';
import Redirects from './content/Redirects.svelte';
import { invalidateEntryDirectory } from './entry-directory.js';
import {
  formatRelativeTime,
  type UiLocale as InterfaceLocale,
  isUiLocale,
  messageOptions,
  readDeviceLocale,
  rememberUiLocale,
  resolveUiLocale,
  showUiLocale,
} from './i18n.js';
import Library from './media/Library.svelte';
import { coordinateEntryReplacement, flushNavigation, navigate } from './navigate';
import * as m from './paraglide/messages.js';
import Pending from './publishing/Pending.svelte';
import { request as fetch, localPath, sitePath, uncertainResponse } from './request.js';
import LanguageControl from './shared/LanguageControl.svelte';
import Modal from './shared/Modal.svelte';
import BuildPill, { type Build } from './shell/BuildPill.svelte';
import Dashboard from './shell/Dashboard.svelte';

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
  user: { id: string; name: string; email: string; uiLocale: UiLocale | null };
  role: 'owner' | 'editor';
}

let {
  session: signedIn,
  path: landedAt,
  query = '',
  methods = { emailLink: false, github: false },
  initialUiLocale = 'en',
}: {
  session?: Session | null;
  path: string;
  query?: string;
  methods?: LoginMethods;
  initialUiLocale?: InterfaceLocale;
} = $props();
// svelte-ignore state_referenced_locally -- the prop is only the initial value
let session = $state(signedIn);
let sessionBusy = $state(false);
// svelte-ignore state_referenced_locally -- bootstrap resolves this before the first mount
let uiLocale = $state(initialUiLocale);
let localeBusy = $state(false);
let localeError = $state(false);
const options = $derived(messageOptions(uiLocale));
type ShellMessage = {
  code:
    | 'SESSION_CHECK_FAILED'
    | 'SIGN_OUT_FAILED'
    | 'PUBLISHED_ENTRY'
    | 'PUBLISHED_CHANGES'
    | 'SAVED_TEMPLATE'
    | 'REVERTED_PUBLISH'
    | 'REVERT_SAVE_FAILED'
    | 'REVERT_UNCERTAIN'
    | 'REVERT_FAILED'
    | 'ENTRY_NOT_FOUND'
    | 'ENTRY_LOAD_FAILED';
  count?: number;
  detail?: string;
  name?: string;
  status?: number;
};
const text = (message: ShellMessage) => {
  switch (message.code) {
    case 'SESSION_CHECK_FAILED':
      return m.shell_session_check_failed({}, options);
    case 'SIGN_OUT_FAILED':
      return m.shell_sign_out_failed({}, options);
    case 'PUBLISHED_ENTRY':
      return m.shell_published_entry({ title: message.name ?? '' }, options);
    case 'PUBLISHED_CHANGES':
      return m.shell_published_changes({ count: message.count ?? 0 }, options);
    case 'SAVED_TEMPLATE':
      return m.shell_saved_template({ name: message.name ?? '' }, options);
    case 'REVERTED_PUBLISH':
      return m.shell_reverted_publish({}, options);
    case 'REVERT_SAVE_FAILED':
      return m.shell_revert_save_failed({}, options);
    case 'REVERT_UNCERTAIN':
      return m.shell_revert_uncertain({}, options);
    case 'REVERT_FAILED':
      return m.shell_revert_failed({ status: message.status ?? 0 }, options);
    case 'ENTRY_NOT_FOUND':
      return m.shell_entry_not_found({}, options);
    case 'ENTRY_LOAD_FAILED':
      return message.status
        ? m.shell_entry_load_failed_status({ status: message.status }, options)
        : m.shell_entry_load_failed({}, options);
  }
};
// svelte-ignore state_referenced_locally -- the prop is the result of the one bootstrap request
let sessionError = $state<ShellMessage | undefined>(
  signedIn === undefined ? { code: 'SESSION_CHECK_FAILED' } : undefined,
);
// svelte-ignore state_referenced_locally -- the prop is only where the page loaded
let path = $state(landedAt);

function useLocale(locale: InterfaceLocale, remember = false) {
  uiLocale = locale;
  showUiLocale(locale);
  if (remember) rememberUiLocale(locale);
}

function useDeviceLocale(locale: InterfaceLocale) {
  useLocale(locale, true);
}

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
  { path: '/admin/media', icon: 'media', label: 'media', ownerOnly: false },
  { path: '/admin/activity', icon: 'activity', label: 'activity', ownerOnly: false },
  { path: '/admin/members', icon: 'members', label: 'members', ownerOnly: true },
  { path: '/admin/settings', icon: 'settings', label: 'settings', ownerOnly: true },
] as const;
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
let revertError = $state<ShellMessage>();
let drawer = $state(false);
// Puts the sidebar back over the screen on a phone, where the narrow rule hides it.
let menu = $state(false);
// A disclosure, not role="menu": that role promises arrow keys and a roving tabindex.
let account = $state(false);
// Bumped when a screen's data has moved under it — the screen is thrown away and made again.
let reload = $state(0);
let editorMode = $state<'form' | 'split' | 'canvas'>('form');
// The container is always in the DOM, so a new notice is announced rather than missed.
let notices = $state<{ id: number; message: ShellMessage }[]>([]);
let noticeSeq = 0;
function notify(message: ShellMessage) {
  const id = ++noticeSeq;
  notices.push({ id, message });
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
    const next = (await res.json()) as Session;
    useLocale(resolveUiLocale(next.user.uiLocale, readDeviceLocale(), navigator.languages));
    session = next;
    sessionError = undefined;
    return;
  }
  if (res.status === 401) {
    session = null;
    sessionError = undefined;
    return;
  }
  if (!session) session = undefined;
  sessionError = { code: 'SESSION_CHECK_FAILED' };
}

async function saveLocale(next: InterfaceLocale) {
  if (!session || localeBusy || next === uiLocale) return;
  const userId = session.user.id;
  localeBusy = true;
  localeError = false;
  try {
    const res = await fetch('/admin/api/auth/update-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uiLocale: next }),
    });
    const confirmed =
      res.ok &&
      ((await res.json().catch(() => null)) as { status?: unknown } | null)?.status === true;
    if (confirmed && session?.user.id === userId) {
      session.user.uiLocale = next;
      useLocale(next, true);
    } else if (uncertainResponse(res)) {
      const ping = await fetch('/admin/api/ping');
      const body = ping.ok ? await ping.json().catch(() => undefined) : undefined;
      const user =
        body &&
        typeof body === 'object' &&
        'user' in body &&
        body.user &&
        typeof body.user === 'object'
          ? body.user
          : undefined;
      const reconciledId = user && 'id' in user ? user.id : undefined;
      const reconciledLocale = user && 'uiLocale' in user ? user.uiLocale : undefined;
      if (
        session?.user.id === userId &&
        reconciledId === userId &&
        (reconciledLocale === null || isUiLocale(reconciledLocale))
      ) {
        session.user.uiLocale = reconciledLocale;
        if (isUiLocale(reconciledLocale)) useLocale(reconciledLocale, true);
        localeError = reconciledLocale !== next;
      } else if (session?.user.id === userId) localeError = true;
    } else if (session?.user.id === userId) localeError = true;
  } catch {
    if (session?.user.id === userId) localeError = true;
  } finally {
    localeBusy = false;
  }
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
    notify({ code: 'SIGN_OUT_FAILED' });
    return;
  }
  session = null;
}

let pendingRequest = 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isPendingEnvelope = (
  value: unknown,
): value is { entries?: typeof pending; defaultLocale?: string } =>
  isRecord(value) &&
  (value.entries === undefined || Array.isArray(value.entries)) &&
  (value.defaultLocale === undefined || typeof value.defaultLocale === 'string');

async function loadPending() {
  const mine = ++pendingRequest;
  pendingStatus = 'loading';
  const res = await fetch('/admin/api/drafts');
  if (mine !== pendingRequest) return;
  if (!res.ok) {
    pendingStatus = 'error';
    return;
  }
  let body: unknown;
  try {
    body = (await res.json()) as typeof body;
  } catch {
    if (mine === pendingRequest) pendingStatus = 'error';
    return;
  }
  if (mine !== pendingRequest) return;
  if (!isPendingEnvelope(body)) {
    pendingStatus = 'error';
    return;
  }
  pending = body.entries ?? [];
  defaultLocale = body.defaultLocale ?? '';
  pendingKnown = true;
  pendingStatus = 'ready';
}

/** A publish redeploys the Worker, so this tab may be reloaded before the build finishes. */
let buildRequest = 0;
const isBuildEnvelope = (value: unknown): value is Partial<NonNullable<typeof build>> =>
  isRecord(value) &&
  (value.state === undefined ||
    value.state === 'building' ||
    value.state === 'live' ||
    value.state === 'failed');

async function loadBuild() {
  const mine = ++buildRequest;
  buildStatus = 'loading';
  const res = await fetch('/admin/api/build');
  if (mine !== buildRequest) return;
  if (!res.ok) {
    buildStatus = 'error';
    return;
  }
  let body: unknown;
  try {
    body = (await res.json()) as typeof body;
  } catch {
    if (mine === buildRequest) buildStatus = 'error';
    return;
  }
  if (mine !== buildRequest) return;
  if (!isBuildEnvelope(body)) {
    buildStatus = 'error';
    return;
  }
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
  revertError = undefined;
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
    revertError = { code: 'REVERT_SAVE_FAILED' };
    return;
  }
  if (!outcome.ok && (outcome.reason === 'uncertain' || outcome.reason === 'reload')) {
    revertError = { code: 'REVERT_UNCERTAIN' };
    return;
  }
  if (!outcome.ok) {
    if (!res) {
      revertError = { code: 'REVERT_UNCERTAIN' };
      return;
    }
    const body = await res.text();
    // A file that has moved on since is the server's own sentence, and it names the file.
    let detail: string | undefined;
    if (res.status === 409) {
      try {
        detail = (JSON.parse(body) as { error?: string }).error ?? body;
      } catch {
        detail = body;
      }
    }
    revertError = { code: 'REVERT_FAILED', status: res.status, ...(detail ? { detail } : {}) };
    return;
  }
  await commitChanged();
  notify({ code: 'REVERTED_PUBLISH' });
  // The drawer describes a commit just undone, so it goes with the publish it was about.
  drawerKey += 1;
}

async function loadEntry(collection: string, slug: string) {
  const res = await fetch(`/admin/api/entries/${collection}/${slug}`);
  if (res.ok) return res.json();
  // A 503 is about the repository, not about this entry, so it is the server's own sentence.
  if (res.status === 503)
    throw {
      code: 'ENTRY_LOAD_FAILED',
      status: res.status,
      detail: await res.text(),
    } satisfies ShellMessage;
  throw {
    code:
      res.headers.get('x-handover-error-code') === 'ENTRY_NOT_FOUND'
        ? 'ENTRY_NOT_FOUND'
        : 'ENTRY_LOAD_FAILED',
    status: res.status,
  } satisfies ShellMessage;
}

const entryFailure = (error: unknown): ShellMessage =>
  error &&
  typeof error === 'object' &&
  'code' in error &&
  (error.code === 'ENTRY_NOT_FOUND' || error.code === 'ENTRY_LOAD_FAILED')
    ? (error as ShellMessage)
    : {
        code: 'ENTRY_LOAD_FAILED',
        status: 0,
        ...(error instanceof Error ? { detail: error.message } : {}),
      };

const manageLabel = (label: (typeof MANAGE)[number]['label']) =>
  label === 'media'
    ? m.shell_media({}, options)
    : label === 'activity'
      ? m.shell_activity({}, options)
      : label === 'members'
        ? m.shell_members({}, options)
        : m.shell_settings({}, options);

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
    <p class="notice notice-danger" role="alert">{sessionError ? text(sessionError) : ''}</p>
    <button class="btn" type="button" disabled={sessionBusy} onclick={loadSession}>
      {sessionBusy ? m.shell_checking_session({}, options) : m.common_retry({}, options)}
    </button>
  </main>
{:else if !session}
  <Login {methods} {path} {query} {uiLocale} onlocale={useDeviceLocale} onlogin={loadSession} />
{:else}
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -- nested links handle keyboard input -->
<div class="shell" class:is-canvas={Boolean(editing) && editorMode === 'canvas'} onclick={follow}>
  <a class="skip-link" href="#workspace" onclick={(event) => { event.preventDefault(); document.getElementById('workspace')?.focus(); }}>{m.shell_skip_to_content({}, options)}</a>
  <!-- A banner, not a toast, since it outlives a page load; the pill is the live region. -->
  {#if building}
    <div class="banner banner-info">
      {m.build_publishing_banner({}, options)}
    </div>
  {/if}
  {#if revertError}
    <div class="banner banner-warn" role="alert">{text(revertError)}{#if revertError.detail}<span class="technical-detail">{m.common_technical_detail({ detail: revertError.detail }, options)}</span>{/if}</div>
  {/if}
  <aside class="sidebar" class:is-open={menu} aria-label={m.shell_main_navigation({}, options)} inert={drawer}>
    <a class="site-name" href={sitePath(`/admin`)}><span class="site-mark" aria-hidden="true">H</span><span>Handover<span class="workspace-label">{m.shell_content_workspace({}, options)}</span></span></a>
    <nav class="nav">
      <div class="nav-group">
        <a href={sitePath(`/admin`)} data-icon="dashboard" aria-current={path === '/admin' ? 'page' : undefined}>{m.dashboard_title({}, options)}</a>
      </div>
    </nav>
    <!-- Always there, even with no globals: every site has redirects, listed on that screen. -->
    <nav class="nav" aria-labelledby="nav-site">
      <div class="nav-label" id="nav-site">{m.shell_site({}, options)}</div>
      <div class="nav-group">
        <a
          href={sitePath(`/admin/site`)}
          data-icon="site"
          aria-current={path.startsWith('/admin/site') ? 'page' : undefined}
        >{m.shell_site_settings({}, options)}</a>
      </div>
    </nav>
    <nav class="nav" aria-labelledby="nav-content">
      <div class="nav-label" id="nav-content">{m.shell_content({}, options)}</div>
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
      <div class="nav-label" id="nav-manage">{m.shell_manage({}, options)}</div>
      <div class="nav-group">
        {#each manage as item (item.path)}
          <a
            href={sitePath(item.path)}
            data-icon={item.icon}
            aria-current={path === item.path ? 'page' : undefined}
          >{manageLabel(item.label)}</a>
        {/each}
      </div>
    </nav>
    {#if session.site}
      <div class="sidebar-footer"><a class="site-link" href={session.site} target="_blank" rel="noreferrer">{m.shell_view_website({}, options)} <span aria-hidden="true">↗</span></a></div>
    {/if}
  </aside>
  <div class="shell-body" id="workspace" tabindex="-1" inert={drawer}>
    <header class="topbar">
      <!-- Only on a phone, where the narrow rule has taken the sidebar away. -->
      <button
        class="btn btn-ghost menu-button"
        type="button"
        aria-label={m.shell_open_menu({}, options)}
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
          {m.shell_pending_checking({}, options)}
        {:else if pendingStatus === 'error' && !pending.length}
          {m.shell_pending_unavailable({}, options)}
        {:else}
          {pending.length ? m.shell_pending_count({ count: pending.length }, options) : m.shell_no_pending({}, options)}
        {/if}
        {#if pending.length && pendingKnown}
          <span class="detail">
            <span class="sep" aria-hidden="true">·</span>
            {m.shell_oldest({ when: formatRelativeTime(oldest, uiLocale) }, options)}
            {#if held}<span class="sep" aria-hidden="true">·</span> {m.shell_on_hold({ count: held }, options)}{/if}
          </span>
        {/if}
      </button>
      {#if pendingStatus === 'error'}
        <span class="pending-read-error" role="alert">
          {pendingKnown ? m.shell_pending_stale({}, options) : m.shell_pending_failed({}, options)}
          <button class="btn-link" type="button" onclick={loadPending}>{m.common_retry({}, options)}</button>
        </span>
      {/if}
      <span class="spacer"></span>
      <!-- Always in the DOM so the first state is announced; the ticking clock stays out of it. -->
      <span class="build-status" role="status">
        {#if build}
          <BuildPill {build} {uiLocale}>
            <!-- Only over the admin's own commit; otherwise the pill is the developer's deploy. -->
            {#if build.state === 'failed' && build.commit_sha}
              <span class="sep" aria-hidden="true">·</span>
              <button class="btn-link" type="button" onclick={() => askRevert(build?.commit_sha ?? '')}>
                {m.build_revert_last({}, options)}
              </button>
            {/if}
          </BuildPill>
        {/if}
      </span>
      {#if buildStatus === 'error'}
        <span class="build-read-error" role="alert">
          {build ? m.build_status_stale({}, options) : m.build_status_unavailable({}, options)}
          <button class="btn-link" type="button" onclick={loadBuild}>{m.common_retry({}, options)}</button>
        </span>
      {/if}
      <div class="user-menu">
        <button
          class="btn"
          type="button"
          aria-expanded={account}
          aria-label={m.shell_account_menu({ name: session.user.name || session.user.email, role: session.role === 'owner' ? m.account_role_owner({}, options) : m.account_role_editor({}, options) }, options)}
          onclick={() => (account = !account)}
        >
          <span class="avatar" aria-hidden="true">{initial}</span>
          <span class="label">
            <span class="name">{session.user.name || session.user.email}</span>
            <span class="role">{session.role === 'owner' ? m.account_role_owner({}, options) : m.account_role_editor({}, options)}</span>
          </span>
        </button>
        {#if account}
          <div class="menu">
            <!-- Context, not actions: the role is changed on the members screen, never here. -->
            <div class="who">
              <span class="name">
                {session.user.name || session.user.email}
                <span class="badge">{session.role === 'owner' ? m.account_role_owner({}, options) : m.account_role_editor({}, options)}</span>
              </span>
              <span class="email">{session.user.email}</span>
            </div>
            <a href={sitePath(`/admin/account`)} aria-current={path === '/admin/account' ? 'page' : undefined}
              >{m.account_title({}, options)}</a
            >
            <LanguageControl locale={uiLocale} disabled={localeBusy} onlocale={saveLocale} />
            {#if localeError}<span class="error locale-error" role="alert">{m.account_language_save_failed({}, messageOptions(uiLocale))}</span>{/if}
            <button type="button" onclick={signOut}>{m.shell_sign_out({}, options)}</button>
          </div>
        {/if}
      </div>
    </header>
    <!-- Keyed on the entry rather than on the address, for the reason `editingAt` gives. -->
    {#key `${editingAt || path}#${reload}`}
    {#if editing}
      {#await Promise.all([openEntry, import('./editor/Editor.svelte')])}
        <main class="main"><p class="placeholder">{m.common_loading({}, options)}</p></main>
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
            notify({ code: 'PUBLISHED_ENTRY', name: title });
            await commitChanged();
          }}
          onrestored={(date) => (restored = { entry: editingAt, date })}
          restored={restored?.entry === editingAt ? restored.date : undefined}
          onmode={(mode) => (editorMode = mode)}
        />
      {:catch error}
        {@const failure = entryFailure(error)}
        <main class="main"><p class="notice notice-danger" role="alert">{text(failure)}{#if failure.detail}<span class="technical-detail">{m.common_technical_detail({ detail: failure.detail }, options)}</span>{/if}</p></main>
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
        onsaved={(name) => notify({ code: 'SAVED_TEMPLATE', name })}
      />
    {:else if redirectRoute}
      <Redirects oncommitted={commitChanged} />
    {:else if path === '/admin/site'}
      <Globals />
    {:else if path === '/admin/media'}
      <Library base={session?.mediaBase ?? ''} presets={session?.presets ?? []} />
    {:else if path === '/admin/account'}
      <Account
        user={session.user}
        role={session.role}
        {uiLocale}
        {localeBusy}
        {localeError}
        onlocale={saveLocale}
        onname={loadSession}
      />
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
        {uiLocale}
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
        notify({ code: 'PUBLISHED_CHANGES', count });
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
        <div class="body">{text(notice.message)}</div>
        <button class="close" type="button" aria-label={m.shell_dismiss({}, options)} onclick={() => dismiss(notice.id)}>×</button>
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
        <h2 id="revert-h">{m.build_revert_question({}, options)}</h2>
        <p id="revert-p">
          {m.build_revert_explanation({}, options)}
        </p>
        <div class="actions">
          <button class="btn" type="button" disabled={reverting} onclick={closeRevert}>{m.common_cancel({}, options)}</button>
          <button class="btn btn-danger" type="button" disabled={reverting} onclick={revert}>
            {reverting ? m.build_reverting({}, options) : m.build_revert({}, options)}
          </button>
        </div>
    </Modal>
  {/if}
</div>
{/if}
