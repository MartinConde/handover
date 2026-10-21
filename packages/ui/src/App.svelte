<script lang="ts">
import { type Labels, labelIn, type Preset, type UiLocale } from '@handover/core';
import { type Component, type Snippet, untrack } from 'svelte';
import { on } from 'svelte/events';
import Account from './account/Account.svelte';
import Login, { type LoginMethods } from './account/Login.svelte';
import EntryList from './content/EntryList.svelte';
import Globals from './content/Globals.svelte';
import Redirects from './content/Redirects.svelte';
import Dashboard from './dashboard/Dashboard.svelte';
import type { CreatedAll } from './editor/Editor.svelte';
import type { EditorEntry } from './editor/entry-payload';
import SourceRecovery, { type SourceProblem } from './editor/SourceRecovery.svelte';
import { invalidateEntryDirectory } from './entry-directory.js';
import { messageDetail } from './errors.js';
import {
  type CollectionLabels,
  capitalise,
  collectionName,
  type UiLocale as InterfaceLocale,
  isUiLocale,
  messageOptions,
  readDeviceLocale,
  rememberUiLocale,
  resolveUiLocale,
  showUiLocale,
  useCollectionLabels,
} from './i18n.js';
import { createLocaleSaver } from './locale-save.svelte';
import Activity from './manage/Activity.svelte';
import Diagnostics from './manage/Diagnostics.svelte';
import Members from './manage/Members.svelte';
import Library from './media/Library.svelte';
import { flushNavigation, navigate } from './navigate';
import * as m from './paraglide/messages.js';
import Pending from './publishing/Pending.svelte';
import RevertDialog from './publishing/RevertDialog.svelte';
import { request as fetch, localPath, postJson, sitePath, uncertainResponse } from './request.js';
import Sidebar from './Sidebar.svelte';
import type { ScreenProps } from './screen.js';
import Skeleton from './shared/Skeleton.svelte';
import { createShellStatus } from './shell-status.svelte';

export interface Session {
  collections: string[];
  collectionLabels?: CollectionLabels;
  // Where a stored media key is served from, so a widget can draw what a content file names.
  mediaBase?: string;
  // Every shape this site crops a picture to, which is what the focal picker previews.
  presets?: { label: string; labels?: Labels; preset: Preset }[];
  // This build serves `/_preview`, so the editor can offer to show the page before it is live.
  preview?: boolean;
  // `site` from astro.config, which the SEO previews print each language's address under.
  site?: string;
  // The site's own screens, as ping listed them: the sidebar is drawn before any screen loads.
  screens?: { key: string; label: string | Labels; roles?: readonly ('owner' | 'editor')[] }[];
  user: { id: string; name: string; email: string; uiLocale: UiLocale | null };
  role: 'owner' | 'editor';
}

let {
  session: signedIn,
  path: landedAt,
  query = '',
  methods = { emailLink: false, github: false },
  initialUiLocale = 'en',
  screens = {},
}: {
  session?: Session | null;
  path: string;
  query?: string;
  methods?: LoginMethods;
  initialUiLocale?: InterfaceLocale;
  // What the site's build compiled in, by key; empty in the bundle the package ships.
  screens?: Record<string, Component<ScreenProps>>;
} = $props();
let session = $state(untrack(() => signedIn));
// The ping below sets them again with a new session.
useCollectionLabels(untrack(() => signedIn?.collectionLabels));
let sessionBusy = $state(false);
// Bootstrap resolves this before the first mount.
let uiLocale = $state(untrack(() => initialUiLocale));
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
    | 'REVERT_CONFLICT'
    | 'ENTRY_NOT_FOUND'
    | 'ENTRY_LOAD_FAILED';
  count?: number;
  detail?: string;
  name?: string;
  paths?: string[];
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
    case 'REVERT_CONFLICT':
      return m.revert_conflict(
        { count: message.paths?.length ?? 0, files: (message.paths ?? []).join(', ') },
        options,
      );
    case 'ENTRY_NOT_FOUND':
      return m.shell_entry_not_found({}, options);
    case 'ENTRY_LOAD_FAILED':
      return message.status
        ? m.shell_entry_load_failed_status({ status: message.status }, options)
        : m.shell_entry_load_failed({}, options);
  }
};
let sessionError = $state<ShellMessage | undefined>(
  untrack(() => (signedIn === undefined ? { code: 'SESSION_CHECK_FAILED' } : undefined)),
);
let path = $state(untrack(() => landedAt));

function useLocale(locale: InterfaceLocale, remember = false) {
  uiLocale = locale;
  showUiLocale(locale);
  if (remember) rememberUiLocale(locale);
}

function useDeviceLocale(locale: InterfaceLocale) {
  useLocale(locale, true);
}
const locale = createLocaleSaver(
  () => session,
  () => uiLocale,
  useLocale,
);

const entryRoute = $derived(path.match(/^\/admin\/c\/([\w-]+)\/([\w-]+)(?:\/(history|seo))?$/));
const listRoute = $derived(path.match(/^\/admin\/c\/([\w-]+)$/));
// Redirects are taken out first, or a global called `redirects` would reach neither screen.
const redirectRoute = $derived(path === '/admin/site/redirects');
const globalRoute = $derived(redirectRoute ? null : path.match(/^\/admin\/site\/([\w-]+)$/));
const screenRoute = $derived(path.match(/^\/admin\/x\/([a-z][a-z0-9-]*)$/));
const editing = $derived(
  globalRoute
    ? { collection: 'globals', slug: globalRoute[1] ?? '' }
    : entryRoute
      ? { collection: entryRoute[1] ?? '', slug: entryRoute[2] ?? '', section: entryRoute[3] ?? '' }
      : undefined,
);
// A tab click must not reread the entry, and `editing` is a new object on every address.
const editingAt = $derived(editing ? `${editing.collection}/${editing.slug}` : '');
// Kept here because the reload after a restore remounts the editor.
let restored = $state<{ entry: string; date: string }>();
// Kept here too: the language an entry was just made to be written in.
let sourceChanged = $state<{ entry: string; locale: string }>();
// Kept here too: what the last Create all did, which its reload would otherwise take with it.
let createdAll = $state<{ entry: string; report: CreatedAll }>();
// An authoritative action reads the replacement before retiring the editor that can retry it.
let preparedEntry:
  | {
      entry: string;
      reload: number;
      outcome:
        | { value: Awaited<ReturnType<typeof loadEntry>>; error?: never }
        | { value?: never; error: { source: SourceProblem } };
    }
  | undefined;
const openEntry = $derived.by(() => {
  // Read on purpose: a reload means the entry's files moved under it.
  const at = reload;
  if (!editingAt) return undefined;
  if (preparedEntry?.entry === editingAt && preparedEntry.reload === at) {
    const outcome = preparedEntry.outcome;
    return outcome.error ? Promise.reject(outcome.error) : Promise.resolve(outcome.value);
  }
  const [collection = '', slug = ''] = editingAt.split('/');
  return loadEntry(collection, slug);
});

const screenLabel = (screen: { key: string; label: string | Labels }) =>
  labelIn(screen.label, uiLocale) ?? screen.key;
// A role that is not listed is not shown the link and is not served the address either.
const siteScreens = $derived(
  (session?.screens ?? []).filter(
    (screen) => !screen.roles || (session && screen.roles.includes(session.role)),
  ),
);
// The compiled bundle can outlive the config that named a screen, so ping's list decides.
const openScreen = $derived.by(() => {
  const key = screenRoute?.[1];
  const listed = key ? siteScreens.find((screen) => screen.key === key) : undefined;
  const component = key ? screens[key] : undefined;
  if (!listed || !component || !session) return undefined;
  // Its own object, so a screen's effects do not re-run every time the shell polls something.
  return {
    component,
    label: screenLabel(listed),
    session: { user: session.user, role: session.role },
  };
});

const collections = $derived(session?.collections ?? []);
const status = createShellStatus();
let indicator = $state<HTMLButtonElement>();
// Bumped after a revert: the drawer's account of the publish it undid has to go with it.
let drawerKey = $state(0);
let confirmRevert = $state<string>();
let revertError = $state<ShellMessage>();
let drawer = $state(false);
// Puts the sidebar back over the screen on a phone, where the narrow rule hides it.
let menu = $state(false);
// Read before the first paint so a collapsed sidebar does not open wide and then shrink.
let collapsed = $state(readCollapsed());
function readCollapsed() {
  try {
    return localStorage.getItem('handover:sidebar-collapsed') === '1';
  } catch {
    return false;
  }
}
function toggleSidebar() {
  collapsed = !collapsed;
  try {
    if (collapsed) localStorage.setItem('handover:sidebar-collapsed', '1');
    else localStorage.removeItem('handover:sidebar-collapsed');
  } catch {
    // Unavailable storage only means the choice is not remembered.
  }
}
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
    status.loadPending();
    status.loadBuild();
  }
});

// A plain click on an admin route swaps the screen in place; anything else is the browser's.
const moved = () => {
  // Reload only ever counts up, so leaving the entry is the one way back to a prepared pair.
  preparedEntry = undefined;
  path = localPath(location.pathname);
  if (session) status.loadPending();
};
const back = async () => {
  const to = location.href;
  if (!(await flushNavigation())) {
    history.pushState({}, '', sitePath(path));
    return;
  }
  if (location.href === to) moved();
};
// svelte:window has no typed attribute for a custom event, unlike popstate.
$effect(() => on(window, 'handover:navigate', moved));

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

// Ping answers 401 until there is a session, so the shell's data arrives after the login form.
async function loadSession() {
  sessionBusy = true;
  const res = await fetch('/admin/api/ping');
  sessionBusy = false;
  if (res.ok) {
    const next = (await res.json()) as Session;
    useCollectionLabels(next.collectionLabels);
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

// Without the content type Better Auth answers 415 and the session outlives the click.
async function signOut() {
  if (!(await flushNavigation())) return;
  const res = await postJson('/admin/api/auth/sign-out', {});
  if (!res.ok) {
    notify({ code: 'SIGN_OUT_FAILED' });
    return;
  }
  session = null;
}

// Every repository commit refreshes the shell-owned views that can move because of it.
async function commitChanged() {
  invalidateEntryDirectory();
  await Promise.all([status.loadPending(), status.loadBuild()]);
}

function askRevert(sha: string) {
  revertError = undefined;
  confirmRevert = sha;
}

async function loadEntry(collection: string, slug: string): Promise<EditorEntry> {
  const res = await fetch(`/admin/api/entries/${collection}/${slug}`);
  if (res.ok) return (await res.json()) as EditorEntry;
  // Not a failure to load: the entry is there and needs somebody to say what it is written in.
  if (res.status === 409 && res.headers.get('x-handover-error-code')?.startsWith('ENTRY_SOURCE_'))
    throw { source: (await res.json()) as SourceProblem };
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

// Read first: on failure the closed editor remains mounted and can offer a safe retry.
async function reloadEntry() {
  if (!editing || !editingAt) return;
  const at = editingAt;
  const collection = editing.collection;
  const slug = editing.slug;
  invalidateEntryDirectory();
  await status.loadPending();
  let outcome: NonNullable<typeof preparedEntry>['outcome'];
  try {
    outcome = { value: await loadEntry(collection, slug) };
  } catch (error) {
    if (!error || typeof error !== 'object' || !('source' in error)) throw error;
    outcome = { error: error as { source: SourceProblem } };
  }
  if (editingAt !== at) return;
  preparedEntry = { entry: at, reload: reload + 1, outcome };
  reload += 1;
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

// The editor's title getter, tied to its entry so the next one never shows the last name.
let titled = $state<{ entry: string; read: () => string }>();
// The open entry's address and actions, drawn in the top bar while that entry is open.
let entryBar = $state.raw<{ entry: string; lead: Snippet; actions: Snippet }>();
const bar = $derived(entryBar?.entry === editingAt ? entryBar : undefined);
let topbarHeight = $state(0);
const crumb = $derived(
  openScreen
    ? { href: '/admin', parent: m.dashboard_title({}, options), current: openScreen.label }
    : redirectRoute
      ? {
          href: '/admin/site',
          parent: m.globals_title({}, options),
          current: m.redirect_title({}, options),
        }
      : editing
        ? {
            href:
              editing.collection === 'globals' ? '/admin/site' : `/admin/c/${editing.collection}`,
            parent:
              editing.collection === 'globals'
                ? m.shell_site_settings({}, options)
                : capitalise(collectionName(editing.collection, uiLocale)),
            current: titled?.entry === editingAt ? titled.read() : '',
          }
        : undefined,
);
</script>

<svelte:window
  onkeydown={(e) => e.key === 'Escape' && ((account = false), (menu = false))}
  onpopstate={back}
/>

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
  <div
    class={[
      'shell',
      { 'is-canvas': Boolean(editing) && editorMode === 'canvas', 'is-collapsed': collapsed },
    ]}
    onclick={follow}
  >
    <a
      class="skip-link"
      href="#workspace"
      onclick={(event) => {
        event.preventDefault();
        document.getElementById('workspace')?.focus();
      }}>{m.shell_skip_to_content({}, options)}</a
    >
    <!-- A banner, not a toast, since it outlives a page load; the pill is the live region. -->
    {#if status.building}
      <div class="banner banner-info">
        {m.build_publishing_banner({}, options)}
      </div>
    {/if}
    {#if revertError}
      <div class="banner banner-warn" role="alert">
        {text(revertError)}{#if revertError.detail}<span class="technical-detail"
            >{messageDetail(revertError, uiLocale)}</span
          >{/if}
      </div>
    {/if}
    <Sidebar
      {session}
      {status}
      {uiLocale}
      {path}
      {menu}
      {drawer}
      bind:account
      bind:indicator
      {siteScreens}
      {collections}
      collection={(listRoute ?? entryRoute)?.[1]}
      onreview={() => (drawer = true)}
      onrevert={askRevert}
      onsignout={signOut}
    />
    <div
      class="shell-body"
      id="workspace"
      tabindex="-1"
      inert={drawer}
      style:--topbar-stuck={bar ? `${topbarHeight}px` : undefined}
    >
      <header class={['topbar', { 'is-entry': bar }]} bind:offsetHeight={topbarHeight}>
        <!-- Only on a phone, where the narrow rule has taken the sidebar away. -->
        <button
          class="btn btn-ghost menu-button"
          type="button"
          aria-label={m.shell_open_menu({}, options)}
          aria-expanded={menu}
          onclick={() => (menu = !menu)}>☰</button
        >
        <!-- Only beside the sidebar; on a phone the menu button above stands in for it. -->
        <button
          class="btn btn-ghost sidebar-toggle"
          type="button"
          aria-label={collapsed
            ? m.shell_expand_sidebar({}, options)
            : m.shell_collapse_sidebar({}, options)}
          aria-expanded={!collapsed}
          onclick={toggleSidebar}
          ><svg viewBox="0 0 24 24" aria-hidden="true"
            ><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg
          ></button
        >
        {#if crumb}
          <div class="crumbs">
            <a href={sitePath(crumb.href)}>{crumb.parent}</a>{#if crumb.current}<span
                class="sep"
                aria-hidden="true">/</span
              ><span class="current">{crumb.current}</span>{/if}
          </div>
        {/if}
        {#if bar}<div class="entry-lead">{@render bar.lead()}</div>{/if}
        <span class="spacer"></span>
        {#if bar}<div class="entry-actions">{@render bar.actions()}</div>{/if}
      </header>
      <!-- Keyed on the entry rather than on the address, for the reason `editingAt` gives. -->
      {#key `${editingAt || path}#${reload}`}
        {#if editing}
          {#await Promise.all([openEntry, import('./editor/Editor.svelte')])}
            <main class="main">
              <Skeleton label={m.common_loading({}, options)} shape="form" />
            </main>
          {:then [entry, { default: Editor }]}
            <Editor
              collection={editing.collection}
              slug={editing.slug}
              section={editing.section ?? ''}
              entry={entry as EditorEntry}
              mediaBase={session?.mediaBase ?? ''}
              preview={session?.preview ?? false}
              site={session?.site}
              {uiLocale}
              userId={session?.user.id}
              onchanged={async () => {
                invalidateEntryDirectory();
                await status.loadPending();
                if (await flushNavigation()) reload += 1;
              }}
              onreload={async () => {
                // Restore/reconciliation already closed the old session. The read happens before
                // remounting so a failure leaves that session's reload-only recovery control visible.
                await reloadEntry();
              }}
              onpending={status.loadPending}
              onconflict={() =>
                (status.conflicted = [...new Set([...status.conflicted, editingAt])])}
              oncommitted={commitChanged}
              onpublished={async (title) => {
                notify({ code: 'PUBLISHED_ENTRY', name: title });
                await commitChanged();
              }}
              onrestored={(date) => (restored = { entry: editingAt, date })}
              restored={restored?.entry === editingAt ? restored.date : undefined}
              onsourcechanged={(locale) => (sourceChanged = { entry: editingAt, locale })}
              sourceChanged={sourceChanged?.entry === editingAt ? sourceChanged.locale : undefined}
              oncreatedall={(report) => (createdAll = report && { entry: editingAt, report })}
              createdAll={createdAll?.entry === editingAt ? createdAll.report : undefined}
              onmode={(mode) => (editorMode = mode)}
              ontitle={(read) => (titled = { entry: editingAt, read })}
              ontopbar={(parts) => {
                entryBar = { entry: editingAt, ...parts };
                return () => (entryBar = undefined);
              }}
            />
          {:catch error}
            {#if error && typeof error === 'object' && 'source' in error}
              <main class="main main-editor">
                <SourceRecovery
                  problem={error.source as SourceProblem}
                  collection={editing.collection}
                  slug={editing.slug}
                  {uiLocale}
                  onchosen={async (locale) => {
                    sourceChanged = { entry: editingAt, locale };
                    invalidateEntryDirectory();
                    await status.loadPending();
                    reload += 1;
                  }}
                  onreload={() => (reload += 1)}
                />
              </main>
            {:else}
              {@const failure = entryFailure(error)}
              <!-- A missing entry stays missing, so only a failed read is worth another go. -->
              <main class="main">
                <p class="notice notice-danger" role="alert">
                  {text(failure)}{#if failure.detail}<span class="technical-detail"
                      >{messageDetail(failure, uiLocale)}</span
                    >{/if}{#if failure.code === 'ENTRY_LOAD_FAILED'}{' '}<button
                      class="btn-link"
                      type="button"
                      onclick={() => (reload += 1)}>{m.common_retry({}, options)}</button
                    >{/if}
                </p>
              </main>
            {/if}
          {/await}
        {:else if listRoute}
          <EntryList
            collection={listRoute[1] ?? ''}
            role={session.role}
            {uiLocale}
            onchanged={() => {
              invalidateEntryDirectory();
              return status.loadPending();
            }}
            oncommitted={commitChanged}
            onsaved={(name) => notify({ code: 'SAVED_TEMPLATE', name })}
          />
        {:else if redirectRoute}
          <Redirects {uiLocale} oncommitted={commitChanged} />
        {:else if openScreen}
          {@const Screen = openScreen.component}
          <!-- The shell owns the landmark, so a site's screen is only its own content. -->
          <main class="main">
            <Screen session={openScreen.session} request={fetch} {navigate} {uiLocale} />
          </main>
        {:else if path === '/admin/site'}
          <Globals {uiLocale} />
        {:else if path === '/admin/media'}
          <Library base={session?.mediaBase ?? ''} presets={session?.presets ?? []} {uiLocale} />
        {:else if path === '/admin/account'}
          <Account
            user={session.user}
            role={session.role}
            {query}
            {uiLocale}
            localeBusy={locale.busy}
            localeError={locale.error}
            onlocale={locale.save}
            onname={loadSession}
          />
        {:else if path === '/admin/members' && session.role === 'owner'}
          <Members user={session.user} {uiLocale} />
        {:else if path === '/admin/activity'}
          <!-- No role condition: which events an editor sees is the server's filter. -->
          <Activity
            role={session.role}
            mediaBase={session.mediaBase ?? ''}
            {uiLocale}
            oncommitted={commitChanged}
          />
        {:else if path === '/admin/settings' && session.role === 'owner'}
          <Diagnostics {uiLocale} oncommitted={commitChanged} />
        {:else}
          <Dashboard
            pending={status.pending}
            pendingStatus={status.pendingStatus}
            build={status.build}
            buildStatus={status.buildStatus}
            {collections}
            {uiLocale}
            role={session.role}
            onreview={() => (drawer = true)}
            onrevert={askRevert}
            onretryPending={status.loadPending}
            onretryBuild={status.loadBuild}
            oncommitted={commitChanged}
          />
        {/if}
      {/key}
    </div>
    {#if drawer}
      {#key drawerKey}
        <Pending
          entries={status.pending}
          defaultLocale={status.defaultLocale}
          {uiLocale}
          mediaBase={session?.mediaBase ?? ''}
          build={status.build}
          conflicted={status.conflicted}
          onrevert={askRevert}
          onclose={() => {
            drawer = false;
            indicator?.focus();
          }}
          onpublished={async (count) => {
            notify({ code: 'PUBLISHED_CHANGES', count });
            await commitChanged();
          }}
          onrefused={(keys) => (status.conflicted = [...new Set([...status.conflicted, ...keys])])}
          ondiscarded={async (key) => {
            status.conflicted = status.conflicted.filter((k) => k !== key);
            invalidateEntryDirectory();
            await status.loadPending();
          }}
        />
      {/key}
    {/if}
    <div class="toasts" aria-live="polite">
      {#each notices as notice (notice.id)}
        <div class="toast">
          <div class="body">{text(notice.message)}</div>
          <button
            class="close"
            type="button"
            aria-label={m.shell_dismiss({}, options)}
            onclick={() => dismiss(notice.id)}>×</button
          >
        </div>
      {/each}
    </div>
    <RevertDialog
      bind:sha={confirmRevert}
      {uiLocale}
      onfailed={(failure) => (revertError = failure)}
      onreverted={async () => {
        await commitChanged();
        notify({ code: 'REVERTED_PUBLISH' });
        // The drawer describes a commit just undone, so it goes with the publish it was about.
        drawerKey += 1;
      }}
    />
  </div>
{/if}
