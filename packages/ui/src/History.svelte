<script lang="ts">
import type { DiffGroup } from '@handover/core';
import Diff from './Diff.svelte';

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
}

let {
  collection,
  slug,
  locales = [],
}: {
  collection: string;
  slug: string;
  /** The languages the site declares; with one there is nothing to filter by. */
  locales?: string[];
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

$effect(() => {
  load(1);
});

async function load(want: number) {
  loading = true;
  const res = await fetch(`/admin/api/history/${collection}/${slug}?page=${want}`);
  loading = false;
  if (!res.ok) {
    // A repository out of reach is the server's own sentence and names the installation; a
    // rate limit is GitHub refusing this site for a few minutes, which is nobody's mistake.
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

/**
 * What the chosen version says that another does not. With one version the other side is what
 * is live now, so the fields marked are the ones restoring it would change; with two it is the
 * older of them, so they read as what happened in between.
 */
async function readDiff(to: string, from?: string) {
  reading = true;
  diffError = '';
  const query = new URLSearchParams({ to, ...(from ? { from } : {}) });
  const res = await fetch(`/admin/api/history/${collection}/${slug}/diff?${query}`);
  reading = false;
  if (!res.ok) {
    groups = [];
    diffError = 'Those versions could not be read from GitHub.';
    return;
  }
  groups = ((await res.json()) as { groups?: DiffGroup[] }).groups ?? [];
}

function open(version: Version) {
  selected = version;
  chosen = [];
  readDiff(version.sha);
}

function compare(version: Version, on: boolean) {
  chosen = on ? [...chosen, version] : chosen.filter((v) => v.sha !== version.sha);
  selected = undefined;
  if (chosen.length !== 2) {
    groups = [];
    return;
  }
  const [older, newer] = [...chosen].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (older && newer) readDiff(newer.sha, older.sha);
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

// The activity log's own scale, and for the same reason: past a week a distance stops being an
// answer and the date is what somebody is actually looking for.
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

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
</script>

<div class="history">
  <div class="history-list">
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
        <span role="status">{chosen.length} of 2 chosen to compare</span>
      {/if}
    </div>
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
              <span class="skeleton is-round"></span>
              <span class="skeleton w-60"></span>
              <span class="skeleton w-40"></span>
            </div>
          </li>
        {/each}
      </ul>
    {:else if versions.length === 0}
      <!-- Not an error and not an empty search: the tab is reachable so the client learns
           where history will be, and the sentence says what it is waiting for. -->
      <div class="empty">
        <div>
          <h2>Nothing published yet</h2>
          <p>
            This entry exists only as unpublished changes. Its first version appears here when it
            is published.
          </p>
          <a class="btn" href="/admin/c/{collection}/{slug}">Back to Content</a>
        </div>
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
              {#if version.author}
                <span class="avatar avatar-sm" aria-hidden="true">{initials(version.author)}</span>
              {/if}
              <!-- The commit is a tooltip at most: this is an editor's history, not a git
                   client, and a sha is not something a client has any use for. -->
              <button
                class="summary"
                type="button"
                title="Commit {version.sha.slice(0, 7)}"
                aria-current={selected?.sha === version.sha ? 'true' : undefined}
                onclick={() => open(version)}
              >{version.summary}</button>
              <span class="sub">
                <span>{when(version.date)}{version.author ? ` · ${version.author}` : ''}</span>
                <!-- A bare span may not carry an aria-label, so the word is in the sentence.
                     The seven other screens still label the wrapper; that is one fix for all
                     of them, not this row's. -->
                <span class="visually-hidden">Languages:</span>
                <span class="chips">
                  {#each version.locales as of (of)}
                    <span class="chip">{of.toUpperCase()}</span>
                  {/each}
                </span>
              </span>
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
  <div class="version-view">
    {#if diffError}
      <p class="notice notice-danger" role="alert">{diffError}</p>
    {:else if reading}
      <p class="placeholder" role="status">Reading that version…</p>
    {:else if selected}
      <div class="version-head">
        <h2>Version from {when(selected.date)}</h2>
        <p class="by">
          {selected.author ? `Published by ${selected.author}, ` : ''}{EXACT.format(
            Date.parse(selected.date),
          )} · <em>{selected.summary}</em> · compared with what is live now
        </p>
      </div>
      <Diff {groups} />
    {:else if chosen.length === 2}
      {@const pair = [...chosen].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))}
      <div class="version-head">
        <h2>Two versions compared</h2>
        <!-- Named by what each says rather than by when it happened: two versions of the same
             afternoon both read "6 days ago", which tells nobody which pair this is. -->
        <p class="by">
          From <em>{pair[0]?.summary}</em>, {when(pair[0]?.date ?? '')}, to
          <em>{pair[1]?.summary}</em>, {when(pair[1]?.date ?? '')}
        </p>
      </div>
      <Diff {groups} />
    {:else if versions.length}
      <div class="form-placeholder">
        <span>
          <strong>Choose a version</strong>Its changes against what is live now appear here.
        </span>
      </div>
    {/if}
  </div>
</div>
