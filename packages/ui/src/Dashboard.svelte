<script lang="ts">
import type { ActivityEvent } from '@handover/core';
import { activityGroupOf } from '@handover/core';
import { EXACT, initials, said, when } from './activity-line';
import BuildPill, { type Build } from './BuildPill.svelte';
import NewEntry, { nameOf } from './NewEntry.svelte';

type Recent = {
  key: string;
  title: string;
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
  locales: { locale: string; missing: number; stale: number; where?: string[] }[];
};

// The two big tiles are the shell's own indicators at tile size, so they are handed over rather
// than asked for again: two answers about the same drafts is how a count and a drawer disagree.
let {
  pending,
  build,
  collections,
  onreview,
  onrevert,
}: {
  pending: {
    key: string;
    updated_at: number;
    held_by?: { id: string; name: string | null } | null;
  }[];
  build: Build | null;
  collections: string[];
  onreview: () => void;
  onrevert: (sha: string) => void;
} = $props();

// The collection whose New entry dialog is open — the list's own dialog, opened from here.
let creating = $state('');

let recent = $state<Recent[]>([]);
let health = $state<Health | null>(null);
let published = $state<{ at: number; by: string | null } | null>(null);
let events = $state<ActivityEvent[]>([]);
let loading = $state(true);

$effect(() => {
  load();
});

async function load() {
  const [own, log] = await Promise.all([
    fetch('/admin/api/dashboard'),
    // The log's own endpoint, cut to ten here: the tile is the top of that list and not a
    // different reading of it, so there is nothing else for a route of its own to answer.
    fetch('/admin/api/activity'),
  ]);
  // Every read falls back to nothing rather than to undefined: this is the landing page, and a
  // route answering something unexpected must leave a tile empty, not an admin that will not draw.
  if (own.ok) {
    const body = (await own.json()) as {
      recent?: Recent[];
      published?: typeof published;
      translations?: Health | null;
    };
    recent = body.recent ?? [];
    published = body.published ?? null;
    health = body.translations ?? null;
  }
  if (log.ok)
    events = (((await log.json()) as { events?: ActivityEvent[] }).events ?? []).slice(0, 10);
  loading = false;
}

const held = $derived(pending.filter((entry) => entry.held_by).length);
// The drawer's own rows, so the age is of the changes waiting and not of the eight this screen
// happens to draw.
const oldest = $derived(Math.min(...pending.map((entry) => entry.updated_at)));
</script>

<main class="main">
  <h1>Dashboard</h1>
  <p class="list-note">What changed, and what is waiting to go out.</p>
  {#if collections.length}
    <div class="quick">
      {#each collections as name (name)}
        <button class="btn" type="button" onclick={() => (creating = name)}>New {nameOf(name)}</button>
      {/each}
    </div>
  {/if}
  <div class="dash">
    <section class="dtile" class:is-lit={pending.length} aria-labelledby="d-pending">
      <header><h2 id="d-pending">Unpublished changes</h2></header>
      {#if pending.length}
        <p class="big">{pending.length} <small>{pending.length === 1 ? 'change' : 'changes'}</small></p>
        <p class="line">
          {#if held}{`${held} on hold · `}{/if}{`oldest ${when(oldest).toLowerCase()}`}
        </p>
        <div class="tile-actions">
          <button class="btn btn-primary" type="button" onclick={onreview}>Review and publish</button>
        </div>
      {:else}
        <p class="big is-quiet">Everything is published</p>
        <p class="line">Nothing waiting. Changes you make appear here until you publish them.</p>
      {/if}
    </section>

    <section
      class="dtile span-2"
      class:is-live={build?.state === 'live'}
      class:is-building={build?.state === 'building'}
      class:is-failed={build?.state === 'failed'}
      aria-labelledby="d-build"
    >
      <header>
        <h2 id="d-build">Build status</h2>
        <a href="/admin/activity">Activity</a>
      </header>
      {#if build}
        <p class="big"><BuildPill {build} /></p>
        {#if published}
          <p class="line">
            Last published{#if published.by}{' by '}<b>{published.by}</b>{/if}{' '}<time
              datetime={new Date(published.at).toISOString()}
              title={EXACT.format(published.at)}>{when(published.at).toLowerCase()}</time
            >
          </p>
        {/if}
        <!-- Offered over any publish the admin made, which is what this tile is for; the top
             bar's pill offers it only on a failed build, where it is the way out of one. -->
        {#if build.commit_sha && published}
          <div class="tile-actions">
            <button class="btn-link" type="button" onclick={() => onrevert(build?.commit_sha ?? '')}>
              Revert this publish
            </button>
          </div>
        {/if}
      {:else}
        <p class="big is-quiet">No build status</p>
        <p class="line">
          This site has published nothing yet, or its Cloudflare token cannot read the builds.
        </p>
      {/if}
    </section>

    <section class="dtile span-2" aria-labelledby="d-recent">
      <header><h2 id="d-recent">Recently edited</h2></header>
      {#if loading}
        <p class="line">Loading…</p>
      {:else if recent.length}
        <ul class="recent">
          {#each recent as row (row.key)}
            <li>
              <a href={row.href}>{row.title}</a>
              <span class="badge">{row.collection}</span>
              {#if row.editing}
                <span class="lock">{row.editing.name || 'Somebody'} is editing</span>
              {/if}
              <span class="sub">
                {row.kind === 'edit' ? 'Edited' : 'Published'}{#if row.by}{` by ${row.by}`}{/if}{' · '}<time
                  datetime={new Date(row.at).toISOString()}
                  title={EXACT.format(row.at)}>{when(row.at).toLowerCase()}</time
                >
              </span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="line">Nothing has been edited yet. Pages you change appear here.</p>
      {/if}
    </section>

    <!-- Absent on a one-language site: every site has a locale folder, and a site with one has
         nothing to report about it. -->
    {#if health}
      <section class="dtile" aria-labelledby="d-tr">
        <header><h2 id="d-tr">Translation health</h2></header>
        <div class="locales">
          {#each health.locales as row (row.locale)}
            {@const where = row.where ?? []}
            <div class="locale-line">
              <span class="chip" class:chip-missing={row.missing}>{row.locale.toUpperCase()}</span>
              {#if row.locale === health.defaultLocale && !row.missing && !row.stale}
                <span class="ok">Source language</span>
              {:else if !row.missing && !row.stale}
                <span class="ok">Up to date</span>
              {:else}
                <span
                  >{#if row.missing}<b>{`${row.missing} missing`}</b>{/if}{row.missing && row.stale
                    ? ' · '
                    : ''}{row.stale ? `${row.stale} stale` : ''}</span
                >
              {/if}
              <!-- One list is *Show*; several are named, since a list is one collection's. -->
              {#if where.length}
                <span class="show">
                  {#each where as name (name)}
                    <a href="/admin/c/{name}?locale={row.locale}">Show{where.length > 1 ? ` ${name}` : ''}</a>
                  {/each}
                </span>
              {/if}
            </div>
          {/each}
        </div>
        <p class="line">
          Stale means the language it was translated from has changed since. The count is the last
          build's, so a translation you have fixed but not published is still in it.
        </p>
      </section>
    {/if}

    <section class="dtile span-2" aria-labelledby="d-act">
      <header>
        <h2 id="d-act">Recent activity</h2>
        <a href="/admin/activity">All activity</a>
      </header>
      {#if loading}
        <p class="line">Loading…</p>
      {:else if events.length}
        <ul class="activity">
          {#each events as event (event.id)}
            {@const line = said(event)}
            <li>
              <div class="activity-row">
                <span class="avatar avatar-sm" class:is-system={!event.user} aria-hidden="true"
                  >{event.user ? initials(event) || '?' : '⚙'}</span
                >
                <p class="said">
                  {line.lead}{#if line.link}<a href={line.link.href}>{line.link.label}</a>
                    <span class="sub">{line.link.locale.toUpperCase()}</span>{/if}
                </p>
                <span class="meta">
                  {#if activityGroupOf(event.kind)}
                    <span class="badge">{activityGroupOf(event.kind)}</span>
                  {/if}
                  <time class="when" datetime={new Date(event.at).toISOString()} title={EXACT.format(event.at)}
                    >{when(event.at)}</time
                  >
                </span>
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="line">Nothing has been recorded yet.</p>
      {/if}
    </section>
  </div>
</main>

{#if creating}
  <NewEntry collection={creating} onclose={() => (creating = '')} />
{/if}
