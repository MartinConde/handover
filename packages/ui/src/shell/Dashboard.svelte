<script lang="ts">
import type { ActivityEvent, Labels } from '@handover/core';
import NewEntry from '../content/NewEntry.svelte';
import {
  collectionName,
  formatExactTime,
  formatRelativeTime,
  messageOptions,
  type UiLocale,
} from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, sitePath } from '../request.js';
import { activityGroupLabel, initials, said } from '../shared/activity-line';
import BuildPill, { type Build } from './BuildPill.svelte';
import SourceLanguagesTile from './SourceLanguagesTile.svelte';

type Recent = {
  key: string;
  title: string;
  labels?: Labels;
  collection: string;
  href: string;
  at: number;
  by: string | null;
  kind: 'edit' | 'publish';
  editing?: { id: string; name: string | null };
};
type Health = {
  defaultLocale: string;
  /** `where` is the collections owing the language, in config order — the lists *Show* opens. */
  locales: {
    locale: string;
    missing: number;
    stale: number;
    unfinished?: number;
    machine?: number;
    where?: string[];
  }[];
};

// The two big tiles are handed the shell's own counts, so a count and the drawer never disagree.
let {
  pending,
  pendingStatus = 'ready',
  build,
  buildStatus = 'ready',
  collections,
  uiLocale = 'en',
  role,
  onreview,
  onrevert,
  onretryPending = () => {},
  onretryBuild = () => {},
  oncommitted,
}: {
  pending: {
    key: string;
    updated_at: number;
    held_by?: { id: string; name: string | null } | null;
  }[];
  pendingStatus?: 'loading' | 'ready' | 'error';
  build: Build | null;
  buildStatus?: 'loading' | 'ready' | 'error';
  collections: string[];
  uiLocale?: UiLocale;
  role?: 'owner' | 'editor';
  onreview: () => void;
  onrevert: (sha: string) => void;
  onretryPending?: () => void;
  onretryBuild?: () => void;
  oncommitted?: () => void | Promise<void>;
} = $props();
const options = $derived(messageOptions(uiLocale));

// The collection whose New entry dialog is open — the list's own dialog, opened from here.
let creating = $state('');

let recent = $state.raw<Recent[]>([]);
let health = $state<Health | null>(null);
let published = $state<{ at: number; by: string | null } | null>(null);
let events = $state<ActivityEvent[]>([]);
let dashboardLoading = $state(true);
let activityLoading = $state(true);
let dashboardKnown = $state(false);
let activityKnown = $state(false);
let dashboardError = $state(false);
let activityError = $state(false);

$effect(() => {
  load();
});

async function load() {
  await Promise.all([loadDashboard(), loadActivity()]);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isDashboardEnvelope = (
  value: unknown,
): value is { recent?: Recent[]; published?: typeof published; translations?: Health | null } =>
  isRecord(value) &&
  (value.recent === undefined || Array.isArray(value.recent)) &&
  (value.published === undefined || value.published === null || isRecord(value.published)) &&
  (value.translations === undefined ||
    value.translations === null ||
    (isRecord(value.translations) && Array.isArray(value.translations.locales)));
const isActivityEnvelope = (value: unknown): value is { events?: ActivityEvent[] } =>
  isRecord(value) && (value.events === undefined || Array.isArray(value.events));

let dashboardRequest = 0;
async function loadDashboard() {
  const mine = ++dashboardRequest;
  dashboardLoading = true;
  dashboardError = false;
  const own = await fetch('/admin/api/dashboard');
  if (mine !== dashboardRequest) return;
  dashboardLoading = false;
  if (own.ok) {
    let body: unknown;
    try {
      body = (await own.json()) as typeof body;
    } catch {
      dashboardError = true;
      return;
    }
    if (mine !== dashboardRequest) return;
    if (!isDashboardEnvelope(body)) {
      dashboardError = true;
      return;
    }
    recent = body.recent ?? [];
    published = body.published ?? null;
    health = body.translations ?? null;
    dashboardKnown = true;
    return;
  }
  dashboardError = true;
}

let activityRequest = 0;
async function loadActivity() {
  const mine = ++activityRequest;
  activityLoading = true;
  activityError = false;
  // The log's own endpoint, cut to ten here: the tile is the top of that list.
  const log = await fetch('/admin/api/activity');
  if (mine !== activityRequest) return;
  activityLoading = false;
  if (log.ok) {
    let body: unknown;
    try {
      body = await log.json();
    } catch {
      activityError = true;
      return;
    }
    if (mine !== activityRequest) return;
    if (!isActivityEnvelope(body)) {
      activityError = true;
      return;
    }
    events = (body.events ?? []).slice(0, 10);
    activityKnown = true;
    return;
  }
  activityError = true;
}

const held = $derived(pending.filter((entry) => entry.held_by).length);
// The drawer's own rows, so the age is of every change waiting, not the eight drawn here.
const oldest = $derived(Math.min(...pending.map((entry) => entry.updated_at)));
</script>

<main class="main dashboard-page">
  <div class="dashboard-heading">
    <div>
      <h1>{m.dashboard_title({}, options)}</h1>
      <p class="list-note">{m.dashboard_intro({}, options)}</p>
    </div>
    {#if collections.length}
      <div class="quick">
        {#each collections as name (name)}
          <button class="btn" type="button" onclick={() => (creating = name)}>{m.dashboard_new_collection({ collection: collectionName(name, uiLocale, 'singular') }, options)}</button>
        {/each}
      </div>
    {/if}
  </div>
  <div class="dash">
    <section class={['dtile summary-tile pending-tile', { 'is-lit': pending.length }]} aria-labelledby="d-pending">
      <header><h2 id="d-pending">{m.shell_unpublished_changes({}, options)}</h2></header>
      {#if pendingStatus === 'loading'}
        <p class="line">{m.shell_pending_checking({}, options)}</p>
      {:else if pendingStatus === 'error'}
        <div class="notice notice-danger pending-read-error" role="alert">
          {pending.length ? m.shell_pending_failed_known({ count: pending.length }, options) : m.shell_pending_failed({}, options)}
          <button class="btn-link" type="button" onclick={onretryPending}>{m.common_retry({}, options)}</button>
        </div>
      {:else if pending.length}
        <p class="big">{m.shell_change_count({ count: pending.length }, options)}</p>
        <p class="line">
          {#if held}{m.shell_on_hold({ count: held }, options)} ·{' '}{/if}{m.shell_oldest({ when: formatRelativeTime(oldest, uiLocale) }, options)}
        </p>
        <div class="tile-actions">
          <button class="btn btn-primary" type="button" onclick={onreview}>{m.dashboard_review_publish({}, options)}</button>
        </div>
      {:else}
        <p class="big is-quiet">{m.dashboard_everything_published({}, options)}</p>
        <p class="line">{m.dashboard_nothing_waiting({}, options)}</p>
      {/if}
    </section>

    <section
      class={[
        'dtile summary-tile build-tile',
        {
          'is-live': build?.state === 'live',
          'is-building': build?.state === 'building',
          'is-failed': build?.state === 'failed',
        },
      ]}
      aria-labelledby="d-build"
    >
      <header>
        <h2 id="d-build">{m.build_status({}, options)}</h2>
        <a href={sitePath(`/admin/activity`)}>{m.shell_activity({}, options)}</a>
      </header>
      {#if buildStatus === 'loading'}
        <p class="line">{m.build_checking({}, options)}</p>
      {:else if buildStatus === 'error'}
        <div class="notice notice-danger build-read-error" role="alert">
          {build ? m.build_check_failed_known({}, options) : m.build_check_failed({}, options)}
          <button class="btn-link" type="button" onclick={onretryBuild}>{m.common_retry({}, options)}</button>
        </div>
      {:else if build}
        <p class="big"><BuildPill {build} {uiLocale} /></p>
        {#if published}
          <p class="line">
            {#if published.by}{m.dashboard_last_published_by({ name: published.by }, options)}{:else}{m.dashboard_last_published({}, options)}{/if}{' '}<time
              datetime={new Date(published.at).toISOString()}
              title={formatExactTime(published.at, uiLocale)}>{formatRelativeTime(published.at, uiLocale)}</time
            >
          </p>
        {/if}
        <!-- Offered on any publish here; the top bar's pill offers it only on a failed build. -->
        {#if build.commit_sha && published}
          <div class="tile-actions">
            <button class="btn-link" type="button" onclick={() => onrevert(build?.commit_sha ?? '')}>
              {m.build_revert_this({}, options)}
            </button>
          </div>
        {/if}
      {:else}
        <p class="big is-quiet">{m.build_no_status({}, options)}</p>
        <p class="line">{m.build_no_status_hint({}, options)}</p>
      {/if}
    </section>

    <!-- Absent on a one-language site, which has nothing to report. -->
    {#if health}
      <section class="dtile summary-tile translation-tile" aria-labelledby="d-tr">
        <header><h2 id="d-tr">{m.dashboard_translation_health({}, options)}</h2></header>
        <div class="locales">
          {#each health.locales as row (row.locale)}
            {@const where = row.where ?? []}
            {@const rest = [
              row.unfinished ? m.dashboard_unfinished_count({ count: row.unfinished }, options) : '',
              row.stale ? m.dashboard_stale_count({ count: row.stale }, options) : '',
              row.machine ? m.dashboard_machine_count({ count: row.machine }, options) : '',
            ].filter(Boolean)}
            <div class="locale-line">
              <span class={['chip', { 'chip-missing': row.missing }]}>{row.locale.toUpperCase()}</span>
              <!-- Machine translated is not owed, so alone it leaves a language up to date. -->
              {#if !row.missing && !row.stale && !row.unfinished}
                <span
                  ><span class="ok"
                    >{m.dashboard_up_to_date({}, options)}</span
                  >{#if row.machine}{' · '}{rest[0]}{/if}</span
                >
              {:else}
                <span
                  >{#if row.missing}<b>{m.dashboard_missing_count({ count: row.missing }, options)}</b>{rest.length ? ' · ' : ''}{/if}{rest.join(' · ')}</span
                >
              {/if}
              <!-- One list is *Show*; several are named, since a list is one collection's. -->
              {#if where.length}
                <span class="show">
                  {#each where as name (name)}
                    <a href={sitePath(`/admin/c/${name}?locale=${row.locale}`)}>{where.length > 1 ? m.dashboard_show_collection({ collection: collectionName(name, uiLocale) }, options) : m.dashboard_show({}, options)}</a>
                  {/each}
                </span>
              {/if}
            </div>
          {/each}
        </div>
        <p class="line">
          {m.dashboard_translation_hint({}, options)}
        </p>
      </section>
    {/if}

    <!-- Owners only: recording commits, and an editor's dashboard does not even ask. -->
    {#if role === 'owner'}
      <SourceLanguagesTile {uiLocale} {oncommitted} />
    {/if}

    <section class="dtile feed-tile recent-tile" aria-labelledby="d-recent">
      <header><h2 id="d-recent">{m.dashboard_recently_edited({}, options)}</h2></header>
      {#if dashboardLoading && !dashboardKnown}
        <p class="line">{m.common_loading({}, options)}</p>
      {:else if dashboardError}
        <div class="notice notice-danger dashboard-read-error" role="alert">
          {m.dashboard_recent_failed({}, options)}
          <button class="btn-link" type="button" onclick={loadDashboard}>{m.common_retry({}, options)}</button>
        </div>
        {#if recent.length}
          <ul class="recent">
            {#each recent as row (row.key)}
              <li><a href={sitePath(row.href)}>{row.labels?.[uiLocale] ?? row.title}</a> <span class="badge">{collectionName(row.collection, uiLocale)}</span></li>
            {/each}
          </ul>
        {/if}
      {:else if recent.length}
        <ul class="recent">
          {#each recent as row (row.key)}
            <li>
              <a href={sitePath(row.href)}>{row.labels?.[uiLocale] ?? row.title}</a>
              <span class="badge">{collectionName(row.collection, uiLocale)}</span>
              {#if row.editing}
                <span class="lock">{m.dashboard_is_editing({ name: row.editing.name || m.dashboard_somebody({}, options) }, options)}</span>
              {/if}
              <span class="sub">
                {row.kind === 'edit' ? (row.by ? m.dashboard_edited_by({ name: row.by }, options) : m.dashboard_edited({}, options)) : (row.by ? m.dashboard_published_by({ name: row.by }, options) : m.dashboard_published({}, options))}{' · '}<time
                  datetime={new Date(row.at).toISOString()}
                  title={formatExactTime(row.at, uiLocale)}>{formatRelativeTime(row.at, uiLocale)}</time
                >
              </span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="line">{m.dashboard_recent_empty({}, options)}</p>
      {/if}
    </section>

    <section class="dtile feed-tile activity-tile" aria-labelledby="d-act">
      <header>
        <h2 id="d-act">{m.dashboard_recent_activity({}, options)}</h2>
        <a href={sitePath(`/admin/activity`)}>{m.dashboard_all_activity({}, options)}</a>
      </header>
      {#if activityLoading && !activityKnown}
        <p class="line">{m.common_loading({}, options)}</p>
      {:else if activityError}
        <div class="notice notice-danger activity-read-error" role="alert">
          {m.dashboard_activity_failed({}, options)}
          <button class="btn-link" type="button" onclick={loadActivity}>{m.common_retry({}, options)}</button>
        </div>
        {#if events.length}
          <p class="line">{m.dashboard_activity_stale({}, options)}</p>
        {/if}
      {:else if events.length}
        <ul class="activity">
          {#each events as event (event.id)}
            {@const line = said(event, [], uiLocale)}
            <li>
              <div class="activity-row">
                <span class={['avatar avatar-sm', { 'is-system': !event.user }]} aria-hidden="true"
                  >{event.user ? initials(event) || '?' : '⚙'}</span
                >
                <p class="said">
                  {line.lead}{#if line.link}<a href={sitePath(line.link.href)}>{line.link.label}</a>{' '}<span class="sub">{line.link.locale.toUpperCase()}</span>{line.tail ?? ''}{/if}
                </p>
                <span class="meta">
                  {#if activityGroupLabel(event.kind, uiLocale)}
                    <span class="badge">{activityGroupLabel(event.kind, uiLocale)}</span>
                  {/if}
                  <time class="when" datetime={new Date(event.at).toISOString()} title={formatExactTime(event.at, uiLocale)}
                    >{formatRelativeTime(event.at, uiLocale)}</time
                  >
                </span>
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="line">{m.dashboard_activity_empty({}, options)}</p>
      {/if}
    </section>
  </div>
</main>

{#if creating}
  <NewEntry collection={creating} {uiLocale} onclose={() => (creating = '')} />
{/if}
