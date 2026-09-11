<script lang="ts">
import type { DiffGroup } from '@handover/core';
import Diff from './Diff.svelte';
import type { HistoricalRestoreResponse, HistoricalRestoreResult } from './entry-session.svelte';
import { request as fetch, sitePath, uncertainResponse } from './request.js';

/** One version as `/admin/api/history/:collection/:slug` answers it. */
interface Version {
  sha: string;
  /** ISO 8601, as git wrote it. */
  date: string;
  summary: string;
  /** The languages of the entry this commit touched. */
  locales: string[];
  /** Nobody, where the commit is the App's and the log no longer has the row. */
  author?: string;
  /** The name the entry's files had at this commit, where a rename has moved them since. */
  name?: string;
}

let {
  collection,
  slug,
  locales = [],
  drafted = false,
  mediaBase = '',
  onrestored,
  onrestore,
}: {
  collection: string;
  slug: string;
  /** Where a stored media key is served from, for a replaced picture's thumbnails. */
  mediaBase?: string;
  /** The languages the site declares; with one there is nothing to filter by. */
  locales?: string[];
  /** Whether the entry has unpublished changes a restore would write over. */
  drafted?: boolean;
  /** The version is in the drafts now: the editor reloads and the Content tab takes over. */
  onrestored: (date: string, outcome: 'restored' | 'uncertain') => void | Promise<void>;
  /** The entry session reserves autosave and owns the restore through authoritative reload. */
  onrestore: (
    request: () => Promise<HistoricalRestoreResponse>,
    reload: (outcome: 'restored' | 'uncertain') => void | Promise<void>,
  ) => Promise<HistoricalRestoreResult>;
} = $props();

let versions = $state<Version[]>([]);
let loading = $state(true);
let error = $state('');
let more = $state(false);
let page = $state(1);
/** Which language's commits are shown; empty is all of them. */
let only = $state('');
/** The version being read, and the pair being compared — one or the other, never both. */
let selected = $state<Version>();
let chosen = $state<Version[]>([]);
let groups = $state<DiffGroup[]>([]);
let reading = $state(false);
let diffError = $state('');
/** The version the confirmation is about, and Cancel, which is where the answer is no. */
let confirming = $state<Version>();
let opening = $state<HTMLElement>();
let restoreButton = $state<HTMLElement>();
let restoring = $state(false);
let restoreError = $state('');

$effect(() => {
  opening?.focus();
});

$effect(() => {
  load(1);
});

async function load(want: number) {
  loading = true;
  const res = await fetch(`/admin/api/history/${collection}/${slug}?page=${want}`);
  loading = false;
  if (!res.ok) {
    // A 503 is the server's own sentence; anything else is GitHub refusing for a few minutes.
    error =
      res.status === 503
        ? await res.text()
        : 'GitHub would not answer just now. Try again in a few minutes.';
    return;
  }
  error = '';
  page = want;
  const body = (await res.json()) as { versions?: Version[]; more?: boolean };
  versions = body.versions ?? [];
  more = body.more === true;
}

/** With one version the other side is what is live now; with two it is the older of them. */
async function readDiff(to: Version, from?: Version) {
  reading = true;
  diffError = '';
  // A version from before a rename has its files under the name the entry had then.
  const query = new URLSearchParams({
    to: to.sha,
    ...(to.name ? { name: to.name } : {}),
    ...(from ? { from: from.sha } : {}),
    ...(from?.name ? { fromName: from.name } : {}),
  });
  const res = await fetch(`/admin/api/history/${collection}/${slug}/diff?${query}`);
  reading = false;
  if (!res.ok) {
    groups = [];
    diffError = 'Those versions could not be read from GitHub.';
    return;
  }
  groups = ((await res.json()) as { groups?: DiffGroup[] }).groups ?? [];
}

function closeConfirm() {
  confirming = undefined;
  restoreError = '';
  restoreButton?.focus();
}

/** Into the drafts, never a rewrite of git: publishing it is the ordinary forward commit. */
async function restore() {
  if (!confirming) return;
  restoring = true;
  const version = confirming;
  const result = await onrestore(
    async () => {
      const res = await fetch(`/admin/api/history/${collection}/${slug}/restore`, {
        method: 'POST',
        body: JSON.stringify({
          commit_sha: version.sha,
          ...(version.name ? { name: version.name } : {}),
        }),
      });
      if (uncertainResponse(res)) throw new TypeError('The restore response was not confirmed.');
      if (res.ok) return { ok: true };
      return {
        ok: false,
        // The server's own sentence: somebody holding the entry, or a version it cannot read.
        error: (await res.text()) || 'That version could not be restored.',
      };
    },
    (outcome) => onrestored(version.date, outcome),
  );
  restoring = false;
  if (!result.ok) {
    restoreError =
      result.error ??
      (result.reason === 'save'
        ? 'Your changes could not be saved, so the version was not restored.'
        : result.reason === 'uncertain'
          ? 'The restore was not confirmed. The entry is being reloaded before editing can continue.'
          : result.reason === 'reload'
            ? 'The version was restored, but the entry could not be reloaded. Reload the page before editing.'
            : 'That version could not be restored.');
    return;
  }
  confirming = undefined;
  restoreError = '';
}

function open(version: Version) {
  selected = version;
  chosen = [];
  readDiff(version);
}

function compare(version: Version, on: boolean) {
  chosen = on ? [...chosen, version] : chosen.filter((v) => v.sha !== version.sha);
  selected = undefined;
  if (chosen.length !== 2) {
    groups = [];
    return;
  }
  const [older, newer] = [...chosen].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (older && newer) readDiff(newer, older);
}

const shown = $derived(only ? versions.filter((v) => v.locales.includes(only)) : versions);

const LANGUAGES = new Intl.DisplayNames(['en'], { type: 'language' });
const language = (of: string) => {
  try {
    return LANGUAGES.of(of) ?? of.toUpperCase();
  } catch {
    return of.toUpperCase();
  }
};

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const EXACT = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short' });
const midnight = (at: number) => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

// Past a week a distance stops being an answer, so the date is shown, as in the activity log.
function when(iso: string): string {
  const at = Date.parse(iso);
  if (!at) return '';
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round((midnight(Date.now()) - midnight(at)) / 86_400_000);
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return DATE.format(at);
}

/** Which languages a version writes, where the entry has more than the one. */
const spoken = (of: string[]) => (of.length > 1 ? `, in ${of.map(language).join(' and ')}` : '');

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
</script>

<div class="history">
  <div class="history-list">
    <div class="history-list-head">
      <div>
        <h2>Version history</h2>
        <p>
          {#if loading && versions.length === 0}
            Fetching published versions…
          {:else}
            {shown.length} {shown.length === 1 ? 'version' : 'versions'}
          {/if}
        </p>
      </div>
      <span class="compare-guide" class:is-active={chosen.length > 0}>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M6.5 4.5h-2v11h2M13.5 4.5h2v11h-2M8.5 7.5h3M8.5 12.5h3" />
        </svg>
        {chosen.length ? `${chosen.length} of 2 selected` : 'Select 2 to compare'}
      </span>
    </div>
    {#if locales.length > 1 || loading || chosen.length}
      <div class="version-tools">
        {#if locales.length > 1}
          <div class="seg" role="group" aria-label="Language">
            <button type="button" aria-pressed={only === ''} onclick={() => (only = '')}>All</button>
            {#each locales as of (of)}
              <button type="button" aria-pressed={only === of} onclick={() => (only = of)}>
                {of.toUpperCase()}<span class="visually-hidden"> — {language(of)}</span>
              </button>
            {/each}
          </div>
        {/if}
        <span class="spacer"></span>
        {#if loading}
          <span role="status">Loading history from GitHub…</span>
        {:else if chosen.length}
          <span class="visually-hidden" role="status">{chosen.length} of 2 chosen to compare</span>
        {/if}
      </div>
    {/if}
    {#if error}
      <div class="notice notice-danger" role="alert">
        <b>Couldn't load history right now</b> — {error}
        <button class="btn btn-sm" type="button" onclick={() => load(page)}>Try again</button>
      </div>
    {:else if loading && versions.length === 0}
      <ul class="version-list">
        {#each [0, 1, 2, 3, 4, 5] as row (row)}
          <li>
            <div class="version-row is-skeleton" aria-hidden="true">
              <span class="skeleton is-box"></span>
              <span class="version-main">
                <span class="skeleton is-round"></span>
                <span class="version-copy">
                  <span class="skeleton w-80"></span>
                  <span class="skeleton w-60"></span>
                </span>
              </span>
            </div>
          </li>
        {/each}
      </ul>
    {:else if versions.length === 0}
      <!-- Not an error: the tab is reachable so the client learns where history will be. -->
      <div class="empty">
        <div>
          <h2>Nothing published yet</h2>
          <p>
            This entry exists only as unpublished changes. Its first version appears here when it
            is published.
          </p>
          <a class="btn" href={sitePath(`/admin/c/${collection}/${slug}`)}>Back to Content</a>
        </div>
      </div>
    {:else if shown.length === 0}
      <div class="history-filter-empty">
        <strong>No versions in {language(only)}</strong>
        <span>Try another language or show the full history.</span>
        <button class="btn btn-sm" type="button" onclick={() => (only = '')}>Show all versions</button>
      </div>
    {:else}
      <ul class="version-list">
        {#each shown as version (version.sha)}
          <li>
            <div class="version-row" class:is-current={selected?.sha === version.sha}>
              <input
                type="checkbox"
                checked={chosen.some((v) => v.sha === version.sha)}
                disabled={chosen.length === 2 && !chosen.some((v) => v.sha === version.sha)}
                aria-label="Compare the version from {when(version.date)}, {version.summary}"
                onchange={(e) => compare(version, e.currentTarget.checked)}
              />
              <div class="version-main">
                {#if version.author}
                  <span class="avatar avatar-sm" aria-hidden="true">{initials(version.author)}</span>
                {:else}
                  <span class="version-mark" aria-hidden="true">
                    <svg viewBox="0 0 20 20"><path d="M10 5.5v4.8l3.2 1.9M17 10a7 7 0 1 1-2.1-5" /><path d="M14.5 2.5v3h3" /></svg>
                  </span>
                {/if}
                <span class="version-copy">
                  <!-- A sha is a tooltip at most: a client has no use for it. -->
                  <button
                    class="summary"
                    type="button"
                    title="Commit {version.sha.slice(0, 7)}"
                    aria-current={selected?.sha === version.sha ? 'true' : undefined}
                    onclick={() => open(version)}
                  >{version.summary}</button>
                  <span class="sub">
                    <span>{when(version.date)}{version.author ? ` · ${version.author}` : ''}{version.name ? ` · as ${version.name}` : ''}</span>
                    <!-- A bare span may not carry an aria-label, so the word is in the sentence. -->
                    <span class="visually-hidden">Languages:</span>
                    <span class="chips">
                      {#each version.locales as of (of)}
                        <span class="chip">{of.toUpperCase()}</span>
                      {/each}
                    </span>
                  </span>
                </span>
              </div>
              <svg class="version-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5" /></svg>
            </div>
          </li>
        {/each}
      </ul>
      {#if more}
        <div class="load-more">
          <button class="btn btn-sm" type="button" disabled={loading} onclick={() => load(page + 1)}>
            {loading ? 'Loading…' : 'Show older versions'}
          </button>
        </div>
      {/if}
    {/if}
  </div>
  <div class="version-view" class:has-version={selected || chosen.length === 2}>
    {#if diffError}
      <p class="notice notice-danger" role="alert">{diffError}</p>
    {:else if reading}
      <p class="placeholder" role="status">Reading that version…</p>
    {:else if selected}
      <div class="version-head">
        <div class="version-title">
          <span class="version-kicker">Published version</span>
          <h2>Version from {when(selected.date)}</h2>
        </div>
        <div class="actions">
          <button
            class="btn btn-primary"
            type="button"
            bind:this={restoreButton}
            onclick={() => (confirming = selected)}
          >Restore this version</button>
        </div>
        <p class="by">
          {selected.author ? `Published by ${selected.author}, ` : ''}{EXACT.format(
            Date.parse(selected.date),
          )} · <em>{selected.summary}</em> · compared with what is live now
        </p>
      </div>
      <Diff {groups} {mediaBase} />
    <!-- No Restore for a pair: it restores the version being looked at, which a pair is not. -->
    {:else if chosen.length === 2}
      {@const pair = [...chosen].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))}
      <div class="version-head">
        <div class="version-title">
          <span class="version-kicker">Comparison</span>
          <h2>Two versions compared</h2>
        </div>
        <!-- Named by what each says: two versions of one afternoon both read "6 days ago". -->
        <p class="by">
          From <em>{pair[0]?.summary}</em>, {when(pair[0]?.date ?? '')}, to
          <em>{pair[1]?.summary}</em>, {when(pair[1]?.date ?? '')}
        </p>
      </div>
      <Diff {groups} {mediaBase} />
    {:else if versions.length}
      <div class="form-placeholder">
        <span class="history-placeholder-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 7v5l3 2M20 12a8 8 0 1 1-2.3-5.7" /><path d="M17 3v4h4" /></svg>
        </span>
        <span>
          <strong>Choose a version to inspect</strong>
          Review what changed against the live entry, or select two versions to compare.
        </span>
      </div>
    {/if}
  </div>
</div>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && confirming) closeConfirm(); }} />

<!-- Not aria-modal: the shell behind stays reachable, so claiming a focus trap would be false. -->
{#if confirming}
  <div class="scrim">
    <div class="dialog is-slim" role="dialog" aria-labelledby="rs-h" aria-describedby="rs-d">
      <h2 id="rs-h">Restore the version from {when(confirming.date)}?</h2>
      <div id="rs-d">
        <p>
          {drafted
            ? 'This replaces your unpublished changes to this entry with'
            : 'This puts, as unpublished changes,'}
          what {confirming.author ?? 'somebody'} published on {EXACT.format(
            Date.parse(confirming.date),
          )}{spoken(confirming.locales)}. Nothing is published until you publish.
        </p>
        <p>The version you have now stays in this list — restoring is a step forward, never a rewind.</p>
      </div>
      {#if restoreError}<p class="notice notice-danger" role="alert">{restoreError}</p>{/if}
      <div class="actions">
        <button class="btn" type="button" bind:this={opening} onclick={closeConfirm}>Cancel</button>
        <button class="btn btn-primary" type="button" disabled={restoring} onclick={restore}>
          {restoring ? 'Restoring…' : 'Restore as unpublished changes'}
        </button>
      </div>
    </div>
  </div>
{/if}
