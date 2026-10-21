<script lang="ts">
import { type Labels, labelIn } from '@handover/core';
import type { Session } from './App.svelte';
import {
  capitalise,
  collectionName,
  formatRelativeTime,
  messageOptions,
  type UiLocale,
} from './i18n.js';
import * as m from './paraglide/messages.js';
import { sitePath } from './request.js';
import BuildPill from './shared/BuildPill.svelte';
import type { createShellStatus } from './shell-status.svelte';

const MANAGE = [
  { path: '/admin/media', icon: 'media', label: 'media', ownerOnly: false },
  { path: '/admin/activity', icon: 'activity', label: 'activity', ownerOnly: false },
  { path: '/admin/members', icon: 'members', label: 'members', ownerOnly: true },
  { path: '/admin/settings', icon: 'settings', label: 'settings', ownerOnly: true },
] as const;

let {
  session,
  status,
  uiLocale,
  path,
  menu,
  drawer,
  account = $bindable(),
  indicator = $bindable(),
  siteScreens,
  collections,
  collection,
  onreview,
  onrevert,
  onsignout,
}: {
  session: Session;
  status: ReturnType<typeof createShellStatus>;
  uiLocale: UiLocale;
  path: string;
  menu: boolean;
  drawer: boolean;
  account: boolean;
  indicator?: HTMLButtonElement;
  siteScreens: NonNullable<Session['screens']>;
  collections: string[];
  // The collection whose list or entry is open.
  collection: string | undefined;
  onreview: () => void;
  onrevert: (sha: string) => void;
  onsignout: () => void;
} = $props();
const options = $derived(messageOptions(uiLocale));
const manage = $derived(MANAGE.filter((item) => !item.ownerOnly || session.role === 'owner'));
const screenLabel = (screen: { key: string; label: string | Labels }) =>
  labelIn(screen.label, uiLocale) ?? screen.key;

const manageLabel = (label: (typeof MANAGE)[number]['label']) =>
  label === 'media'
    ? m.shell_media({}, options)
    : label === 'activity'
      ? m.shell_activity({}, options)
      : label === 'members'
        ? m.shell_members({}, options)
        : m.shell_settings({}, options);

// `oldest`, not "started": a draft row carries when it was last written, not when it began.
const oldest = $derived(Math.min(...status.pending.map((e) => e.updated_at)));
const held = $derived(status.pending.filter((e) => e.held_by).length);
const initial = $derived((session.user.name || session.user.email || '?').charAt(0).toUpperCase());
</script>

<aside
  class={['sidebar', { 'is-open': menu }]}
  aria-label={m.shell_main_navigation({}, options)}
  inert={drawer}
>
  <!-- Site-wide state heads the site's navigation rather than sitting among one entry's controls. -->
  <div class="sidebar-status">
    <!-- Always in the DOM so the first state is announced; the ticking clock stays out of it. -->
    <span class="build-status" role="status">
      {#if status.build}
        <BuildPill build={status.build} {uiLocale}>
          <!-- Only over the admin's own commit; otherwise the pill is the developer's deploy. -->
          {#if status.build.state === 'failed' && status.build.commit_sha}
            <span class="sep" aria-hidden="true">·</span>
            <button
              class="btn-link"
              type="button"
              onclick={() => onrevert(status.build?.commit_sha ?? '')}
            >
              {m.build_revert_last({}, options)}
            </button>
          {/if}
        </BuildPill>
      {/if}
    </span>
    {#if status.buildStatus === 'error'}
      <span class="build-read-error" role="alert">
        {status.build
          ? m.build_status_stale({}, options)
          : m.build_status_unavailable({}, options)}
        <button class="btn-link" type="button" onclick={status.loadBuild}
          >{m.common_retry({}, options)}</button
        >
      </span>
    {/if}
    <button
      class={['indicator', { 'is-lit': status.pending.length && status.pendingKnown }]}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={drawer}
      disabled={status.pendingStatus !== 'ready'}
      onclick={onreview}
      title={status.pendingStatus === 'loading' && !status.pendingKnown
        ? m.shell_pending_checking({}, options)
        : status.pendingStatus === 'error' && !status.pendingKnown
          ? m.shell_pending_unavailable({}, options)
          : status.pending.length
            ? m.shell_pending_count({ count: status.pending.length }, options)
            : m.shell_no_pending({}, options)}
      bind:this={indicator}
    >
      <span class="dot" aria-hidden="true"></span>
      {#if status.pendingStatus === 'loading' && !status.pendingKnown}
        {m.shell_pending_checking({}, options)}
      {:else if status.pendingStatus === 'error' && !status.pending.length}
        {m.shell_pending_unavailable({}, options)}
      {:else}
        <!-- Collapsed, the sidebar clips the words and shows the count alone. -->
        <span class="count" aria-hidden="true"
          >{status.pendingKnown ? status.pending.length : '…'}</span
        >
        <span class="nav-text"
          >{status.pending.length
            ? m.shell_pending_count({ count: status.pending.length }, options)
            : m.shell_no_pending({}, options)}</span
        >
      {/if}
      {#if status.pending.length && status.pendingKnown}
        <span class="detail">
          <span class="sep" aria-hidden="true">·</span>
          {m.shell_oldest({ when: formatRelativeTime(oldest, uiLocale) }, options)}
          {#if held}<span class="sep" aria-hidden="true">·</span>
            {m.shell_on_hold({ count: held }, options)}{/if}
        </span>
      {/if}
      <svg
        class="indicator-chevron"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"><path d="m8 5 5 5-5 5" /></svg
      >
    </button>
    {#if status.pendingStatus === 'error'}
      <span class="pending-read-error" role="alert">
        {status.pendingKnown
          ? m.shell_pending_stale({}, options)
          : m.shell_pending_failed({}, options)}
        <button class="btn-link" type="button" onclick={status.loadPending}
          >{m.common_retry({}, options)}</button
        >
      </span>
    {/if}
  </div>
  <nav class="nav">
    <div class="nav-group">
      <a
        href={sitePath(`/admin`)}
        data-icon="dashboard"
        aria-current={path === '/admin' ? 'page' : undefined}
        ><span class="nav-text">{m.dashboard_title({}, options)}</span></a
      >
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
        ><span class="nav-text">{m.shell_site_settings({}, options)}</span></a
      >
      {#each siteScreens as screen (screen.key)}
        <a
          href={sitePath(`/admin/x/${screen.key}`)}
          data-icon="screen"
          aria-current={path === `/admin/x/${screen.key}` ? 'page' : undefined}
          ><span class="nav-text">{screenLabel(screen)}</span></a
        >
      {/each}
    </div>
  </nav>
  <nav class="nav" aria-labelledby="nav-content">
    <div class="nav-label" id="nav-content">{m.shell_content({}, options)}</div>
    <div class="nav-group">
      {#each collections as name (name)}
        <a
          href={sitePath(`/admin/c/${name}`)}
          data-icon="collection"
          aria-current={collection === name ? 'page' : undefined}
          ><span class="nav-text">{capitalise(collectionName(name, uiLocale))}</span></a
        >
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
          ><span class="nav-text">{manageLabel(item.label)}</span></a
        >
      {/each}
    </div>
  </nav>
  <div class="sidebar-footer">
    {#if session.site}<a class="site-link" href={session.site} target="_blank" rel="noreferrer"
        ><span class="nav-text">{m.shell_view_website({}, options)}</span>
        <span aria-hidden="true">↗</span></a
      >{/if}
    <div class="user-menu">
      <button
        class="btn"
        type="button"
        aria-expanded={account}
        aria-label={m.shell_account_menu(
          {
            name: session.user.name || session.user.email,
            role:
              session.role === 'owner'
                ? m.account_role_owner({}, options)
                : m.account_role_editor({}, options),
          },
          options,
        )}
        onclick={() => (account = !account)}
      >
        <span class="avatar" aria-hidden="true">{initial}</span>
        <span class="label">
          <span class="name">{session.user.name || session.user.email}</span>
          <span class="role"
            >{session.role === 'owner'
              ? m.account_role_owner({}, options)
              : m.account_role_editor({}, options)}</span
          >
        </span>
      </button>
      {#if account}
        <div class="menu">
          <!-- Context, not actions: the role is changed on the members screen, never here. -->
          <div class="who">
            <span class="name">
              {session.user.name || session.user.email}
              <span class="badge"
                >{session.role === 'owner'
                  ? m.account_role_owner({}, options)
                  : m.account_role_editor({}, options)}</span
              >
            </span>
            <span class="email">{session.user.email}</span>
          </div>
          <a
            href={sitePath(`/admin/account`)}
            aria-current={path === '/admin/account' ? 'page' : undefined}
            >{m.account_title({}, options)}</a
          >
          <button type="button" onclick={onsignout}>{m.shell_sign_out({}, options)}</button>
        </div>
      {/if}
    </div>
  </div>
</aside>
