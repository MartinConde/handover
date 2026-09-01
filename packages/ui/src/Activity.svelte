<script lang="ts">
import {
  ACTIVITY_GROUPS,
  type ActivityEvent,
  activityGroupOf,
  type DiffGroup,
} from '@handover/core';
import { ENTRY, EXACT, initials, type Person, said, when } from './activity-line';
import Diff from './Diff.svelte';

let {
  role,
  mediaBase = '',
}: {
  role: 'owner' | 'editor';
  /** Where a stored media key is served from, for a replaced picture's thumbnails. */
  mediaBase?: string;
} = $props();

let events = $state<ActivityEvent[]>([]);
let cursor = $state<string | null>(null);
let loading = $state(true);
let more = $state(false);
let failure = $state('');
let people = $state<Person[]>([]);

/** What the list is filtered by. The typed box is separate, so it is applied on change and not
    on every keystroke. */
let group = $state('');
let person = $state('');
let entry = $state('');
let typed = $state('');
const filtered = $derived(Boolean(group || person || entry));
/** Changing a filter replaces the list in place, which is a change nobody is otherwise told
    about. The element is always in the document, or its first content would not be announced. */
const status = $derived(
  loading
    ? ''
    : events.length
      ? `${events.length} event${events.length === 1 ? '' : 's'} shown`
      : filtered
        ? 'No activity matches these filters'
        : 'Nothing has been recorded yet',
);

/** A page that is no longer the one being asked for must not land in the list. */
let asked = 0;
/** The removal being put back, and what the server said if it would not be. */
let putting = $state('');
let refused = $state('');
/** Which row is open — one at a time, the way the log reads. */
let why = $state('');
/** What each publish row's commit changed, read from the server the first time it is opened. */
type Changed = { entries: { key: string; groups: DiffGroup[] }[]; more: number };
let diffs = $state<Record<string, Changed | 'loading' | 'failed'>>({});

/** A publish that made a commit opens on the commit's diff; a refused one opens on its reason. */
const opens = (event: ActivityEvent, reason: string | undefined) =>
  Boolean(reason) || (event.kind === 'publish' && Boolean(event.commitSha));

async function toggle(event: ActivityEvent) {
  why = why === event.id ? '' : event.id;
  if (why !== event.id || event.kind !== 'publish' || event.id in diffs) return;
  diffs[event.id] = 'loading';
  const res = await fetch(`/admin/api/activity/diff?sha=${event.commitSha}`);
  diffs[event.id] = res.ok ? ((await res.json()) as Changed) : 'failed';
}

/** Where an entry key opens: a global at its own address, everything else under its collection. */
const hrefOf = (key: string) => {
  const [collection = '', name = ''] = key.split('/');
  return collection === 'globals' ? `/admin/site/${name}` : `/admin/c/${collection}/${name}`;
};

$effect(() => {
  load();
});
// An editor may not call the members route at all, and needs neither of the things it answers:
// the person filter is not offered, and a role change is never one of their own events.
$effect(() => {
  if (role === 'owner') loadPeople();
});

async function loadPeople() {
  const res = await fetch('/admin/api/members');
  if (res.ok) people = ((await res.json()) as { members: typeof people }).members;
}

async function load(next?: string | null) {
  const mine = ++asked;
  const query = new URLSearchParams();
  if (group) query.set('group', group);
  if (person) query.set('user', person);
  if (entry) query.set('entry', entry);
  if (next) query.set('cursor', next);
  if (next) more = true;
  const res = await fetch(`/admin/api/activity?${query}`);
  if (mine !== asked) return;
  more = false;
  loading = false;
  if (!res.ok) {
    failure = `Could not load the activity (${res.status}).`;
    return;
  }
  failure = '';
  const page = (await res.json()) as { events: ActivityEvent[]; cursor: string | null };
  events = next ? [...events, ...page.events] : page.events;
  cursor = page.cursor;
}

/**
 * The delete on this row undone. No confirmation, unlike the entry list's own Restore and unlike
 * a revert: this only ever puts files back, and the one case where it would write over something
 * is refused by the server rather than done — so there is nothing here to be sorry about.
 */
async function putBack(event: ActivityEvent) {
  putting = event.id;
  refused = '';
  const res = await fetch('/admin/api/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commit_sha: event.commitSha }),
  });
  putting = '';
  if (!res.ok) {
    const body = await res.text();
    // A file that has moved on since is the server's own sentence, and it names the file.
    refused =
      res.status === 409
        ? ((JSON.parse(body.startsWith('{') ? body : '{}') as { error?: string }).error ?? body)
        : `That was not restored (${res.status}). Nothing was changed.`;
    return;
  }
  await load();
}

function clear() {
  group = '';
  person = '';
  entry = '';
  typed = '';
}

/** The kinds a restore is offered over, which are the two commits that take a file away. */
const RESTORABLE = ['entry-delete', 'locale-off'];
</script>

<main class="main">
  <div class="list-toolbar">
    <h1>Activity</h1>
    <span class="spacer"></span>
    <div class="filters">
      <!-- Native controls wearing the chip. A select brings its own keyboard, its typeahead and
           the platform's picker on a phone; the mockup's ▾ button is a drawing of what one of
           these already does. -->
      <label class="visually-hidden" for="activity-group">Kind</label>
      <select class="filter" class:is-on={group} id="activity-group" bind:value={group}>
        <option value="">All kinds</option>
        {#each Object.keys(ACTIVITY_GROUPS) as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
      {#if role === 'owner'}
        <label class="visually-hidden" for="activity-person">Person</label>
        <select class="filter" class:is-on={person} id="activity-person" bind:value={person}>
          <option value="">Everyone</option>
          {#each people as member (member.id)}
            <option value={member.id}>{member.name || member.email}</option>
          {/each}
        </select>
      {/if}
      <!-- The server matches `subject` exactly, and a subject is a file path, so the box takes
           one. The list suggests the paths on screen; anything older is typed or pasted. -->
      <label class="visually-hidden" for="activity-entry">Entry</label>
      <input
        class="input filter-text"
        id="activity-entry"
        type="text"
        list="activity-entries"
        placeholder="All pages"
        bind:value={typed}
        onchange={() => (entry = typed.trim())}
      />
      <datalist id="activity-entries">
        {#each [...new Set(events.map((e) => e.subject).filter((s) => s && ENTRY.test(s)))] as path (path)}
          <option value={path}></option>
        {/each}
      </datalist>
      {#if filtered}
        <button class="btn btn-sm" type="button" onclick={clear}>Clear filters</button>
      {/if}
    </div>
  </div>
  <p class="visually-hidden" role="status">{status}</p>
  {#if role !== 'owner'}
    <p class="list-note">Showing your own activity. Owners see everyone's.</p>
  {/if}
  {#if failure}<p class="notice notice-danger" role="alert">{failure}</p>{/if}
  {#if refused}<p class="notice notice-warn" role="alert">{refused}</p>{/if}
  {#if loading}
    <p class="placeholder">Loading…</p>
  {:else if events.length === 0}
    <div class="empty">
      <div>
        {#if filtered}
          <h2>No activity matches these filters</h2>
          <p>Nothing in the last 180 days. Anything older is removed automatically.</p>
          <button class="btn" type="button" onclick={clear}>Clear filters</button>
        {:else}
          <h2>Nothing has been recorded yet</h2>
          <p>Sign-ins, invites and publishes appear here as they happen.</p>
        {/if}
      </div>
    </div>
  {:else}
    <ol class="activity">
      {#each events as event (event.id)}
        {@const line = said(event, people)}
        <li>
          <div class="activity-row">
            <span
              class="avatar avatar-sm"
              class:is-system={!event.user}
              class:is-gone={event.user && !event.user.name && !event.user.email}
              aria-hidden="true">{event.user ? initials(event) || '?' : '⚙'}</span
            >
            <p class="said">
              {line.lead}{#if line.link}<a href={line.link.href}>{line.link.label}</a>
                <span class="sub">{line.link.locale.toUpperCase()}</span>{/if}
              {#if event.commitSha}<span class="sub sha">{event.commitSha.slice(0, 7)}</span>{/if}
            </p>
            <span class="meta">
              <!-- The way back from the two commits that take a file away, on the row that
                   recorded one. The entry list's Deleted view is the same undo with the
                   collection's chrome around it. -->
              {#if RESTORABLE.includes(event.kind) && event.commitSha}
                <button
                  class="btn btn-sm"
                  type="button"
                  disabled={putting === event.id}
                  onclick={() => putBack(event)}
                  >{putting === event.id ? 'Restoring…' : 'Restore'}</button
                >
              {/if}
              {#if activityGroupOf(event.kind)}
                <span class="badge">{activityGroupOf(event.kind)}</span>
              {/if}
              <time class="when" datetime={new Date(event.at).toISOString()} title={EXACT.format(event.at)}
                >{when(event.at)}</time
              >
              <!-- Empty on every other row, which is what keeps the column straight. -->
              <span class="expand">
                {#if opens(event, line.reason)}
                  <button
                    class="btn btn-ghost btn-icon"
                    type="button"
                    aria-expanded={why === event.id}
                    aria-controls="why-{event.id}"
                    aria-label="{line.reason ? 'Why it failed' : 'What changed'}, {when(event.at)}"
                    onclick={() => toggle(event)}
                    >{why === event.id ? '▾' : '▸'}</button
                  >
                {/if}
              </span>
            </span>
          </div>
          {#if line.reason}
            <div class="activity-detail" id="why-{event.id}" hidden={why !== event.id}>
              <p>{line.reason}</p>
            </div>
          {:else if opens(event, line.reason)}
            {@const changed = diffs[event.id]}
            <div class="activity-detail" id="why-{event.id}" hidden={why !== event.id}>
              {#if changed === undefined || changed === 'loading'}
                <p>Loading…</p>
              {:else if changed === 'failed'}
                <p>The commit could not be read from GitHub.</p>
              {:else if changed.entries.length === 0}
                <p>Nothing in this commit is an entry.</p>
              {:else}
                {#each changed.entries as entry (entry.key)}
                  <section>
                    <h2><a href={hrefOf(entry.key)}>{entry.key.split('/')[1]}</a></h2>
                    <Diff groups={entry.groups} {mediaBase} />
                  </section>
                {/each}
                {#if changed.more}
                  <p>…and {changed.more} more {changed.more === 1 ? 'entry' : 'entries'} in this commit.</p>
                {/if}
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ol>
    {#if cursor}
      <div class="load-more">
        <button class="btn" type="button" disabled={more} onclick={() => load(cursor)}>
          {more ? 'Loading…' : 'Load more'}
        </button>
      </div>
    {/if}
  {/if}
</main>
