<script lang="ts">
import { ACTIVITY_GROUPS, type ActivityEvent, type DiffGroup } from '@handover/core';
import { formatExactTime, formatRelativeTime, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import Diff from '../publishing/Diff.svelte';
import { request as fetch, sitePath } from '../request.js';
import { activityGroupLabel, ENTRY, initials, type Person, said } from '../shared/activity-line';

let {
  role,
  mediaBase = '',
  uiLocale = 'en',
  oncommitted,
}: {
  role: 'owner' | 'editor';
  /** Where a stored media key is served from, for a replaced picture's thumbnails. */
  mediaBase?: string;
  uiLocale?: UiLocale;
  /** Restoring a removed entry makes a new commit, so the shell can refresh its build state. */
  oncommitted?: () => void | Promise<void>;
} = $props();
const options = $derived(messageOptions(uiLocale));

let events = $state<ActivityEvent[]>([]);
let cursor = $state<string | null>(null);
let loading = $state(true);
let more = $state(false);
let failure = $state<number>();
let people = $state<Person[]>([]);

/** The typed box is separate, so the entry filter applies on change, not every keystroke. */
let group = $state('');
let person = $state('');
let entry = $state('');
let typed = $state('');
const filtered = $derived(Boolean(group || person || entry));
/** Always in the document, or its first content would not be announced. */
const status = $derived(
  loading
    ? ''
    : events.length
      ? m.activity_status_shown({ count: events.length }, options)
      : filtered
        ? m.activity_no_matches({}, options)
        : m.activity_empty({}, options),
);

/** A page that is no longer the one being asked for must not land in the list. */
let asked = 0;
/** The removal being put back, and what the server said if it would not be. */
let putting = $state('');
let refused = $state<{ status: number; detail?: string }>();
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
// An editor may not call the members route, and the person filter is not offered to them.
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
    failure = res.status;
    return;
  }
  failure = undefined;
  const page = (await res.json()) as { events: ActivityEvent[]; cursor: string | null };
  events = next ? [...events, ...page.events] : page.events;
  cursor = page.cursor;
}

/** No confirmation: it only puts files back; the one overwrite case the server refuses. */
async function putBack(event: ActivityEvent) {
  putting = event.id;
  refused = undefined;
  const res = await fetch('/admin/api/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commit_sha: event.commitSha }),
  });
  putting = '';
  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    if (body.startsWith('{')) {
      try {
        const error = (JSON.parse(body) as { error?: unknown }).error;
        detail = typeof error === 'string' ? error : body;
      } catch {
        // Preserve the response as diagnostics; malformed JSON must not break the recovery state.
      }
    }
    refused = { status: res.status, detail: res.status === 409 && detail ? detail : undefined };
    return;
  }
  await load();
  await oncommitted?.();
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
    <h1>{m.activity_title({}, options)}</h1>
    <span class="spacer"></span>
    <div class="filters">
      <!-- A native select brings its own keyboard, typeahead and the phone's picker. -->
      <label class="visually-hidden" for="activity-group">{m.activity_filter_kind({}, options)}</label>
      <select class="filter" class:is-on={group} id="activity-group" bind:value={group}>
        <option value="">{m.activity_all_kinds({}, options)}</option>
        {#each Object.keys(ACTIVITY_GROUPS) as name (name)}
          <option value={name}>{activityGroupLabel(ACTIVITY_GROUPS[name as keyof typeof ACTIVITY_GROUPS][0], uiLocale)}</option>
        {/each}
      </select>
      {#if role === 'owner'}
        <label class="visually-hidden" for="activity-person">{m.activity_filter_person({}, options)}</label>
        <select class="filter" class:is-on={person} id="activity-person" bind:value={person}>
          <option value="">{m.activity_everyone({}, options)}</option>
          {#each people as member (member.id)}
            <option value={member.id}>{member.name || member.email}</option>
          {/each}
        </select>
      {/if}
      <!-- The server matches `subject` exactly, a file path, so the box takes one. -->
      <label class="visually-hidden" for="activity-entry">{m.activity_filter_entry({}, options)}</label>
      <input
        class="input filter-text"
        id="activity-entry"
        type="text"
        list="activity-entries"
        placeholder={m.activity_all_pages({}, options)}
        bind:value={typed}
        onchange={() => (entry = typed.trim())}
      />
      <datalist id="activity-entries">
        {#each [...new Set(events.map((e) => e.subject).filter((s) => s && ENTRY.test(s)))] as path (path)}
          <option value={path}></option>
        {/each}
      </datalist>
      {#if filtered}
        <button class="btn btn-sm" type="button" onclick={clear}>{m.activity_clear_filters({}, options)}</button>
      {/if}
    </div>
  </div>
  <p class="visually-hidden" role="status">{status}</p>
  {#if role !== 'owner'}
    <p class="list-note">{m.activity_editor_scope({}, options)}</p>
  {/if}
  {#if failure}<p class="notice notice-danger" role="alert">{m.activity_load_failed_status({ status: failure }, options)}</p>{/if}
  {#if refused}<p class="notice notice-warn" role="alert">{refused.detail ? m.activity_restore_conflict({ detail: refused.detail }, options) : m.activity_restore_failed_status({ status: refused.status }, options)}</p>{/if}
  {#if loading}
    <p class="placeholder">{m.common_loading({}, options)}</p>
  {:else if events.length === 0}
    <div class="empty">
      <div>
        {#if filtered}
          <h2>{m.activity_no_matches({}, options)}</h2>
          <p>{m.activity_no_matches_hint({}, options)}</p>
          <button class="btn" type="button" onclick={clear}>{m.activity_clear_filters({}, options)}</button>
        {:else}
          <h2>{m.activity_empty({}, options)}</h2>
          <p>{m.activity_empty_hint({}, options)}</p>
        {/if}
      </div>
    </div>
  {:else}
    <ol class="activity">
      {#each events as event (event.id)}
        {@const line = said(event, people, uiLocale)}
        <li>
          <div class="activity-row">
            <span
              class="avatar avatar-sm"
              class:is-system={!event.user}
              class:is-gone={event.user && !event.user.name && !event.user.email}
              aria-hidden="true">{event.user ? initials(event) || '?' : '⚙'}</span
            >
            <p class="said">
              {line.lead}{#if line.link}<a href={sitePath(line.link.href)}>{line.link.label}</a>{' '}<span class="sub">{line.link.locale.toUpperCase()}</span>{line.tail ?? ''}{/if}
              {#if event.commitSha}<span class="sub sha">{event.commitSha.slice(0, 7)}</span>{/if}
            </p>
            <span class="meta">
              <!-- The entry list's Deleted view is the same undo with the collection's chrome. -->
              {#if RESTORABLE.includes(event.kind) && event.commitSha}
                <button
                  class="btn btn-sm"
                  type="button"
                  disabled={putting === event.id}
                  onclick={() => putBack(event)}
                  >{putting === event.id ? m.activity_restoring({}, options) : m.activity_restore({}, options)}</button
                >
              {/if}
              {#if activityGroupLabel(event.kind, uiLocale)}
                <span class="badge">{activityGroupLabel(event.kind, uiLocale)}</span>
              {/if}
              <time class="when" datetime={new Date(event.at).toISOString()} title={formatExactTime(event.at, uiLocale)}
                >{formatRelativeTime(event.at, uiLocale)}</time
              >
              <!-- Empty on every other row, which is what keeps the column straight. -->
              <span class="expand">
                {#if opens(event, line.reason)}
                  <button
                    class="btn btn-ghost btn-icon"
                    type="button"
                    aria-expanded={why === event.id}
                    aria-controls="why-{event.id}"
                    aria-label="{line.reason ? m.activity_why_failed({}, options) : m.activity_what_changed({}, options)}, {formatRelativeTime(event.at, uiLocale)}"
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
                <p>{m.common_loading({}, options)}</p>
              {:else if changed === 'failed'}
                <p>{m.activity_diff_failed({}, options)}</p>
              {:else if changed.entries.length === 0}
                <p>{m.activity_diff_empty({}, options)}</p>
              {:else}
                {#each changed.entries as entry (entry.key)}
                  <section>
                    <h2><a href={sitePath(hrefOf(entry.key))}>{entry.key.split('/')[1]}</a></h2>
                    <Diff groups={entry.groups} {mediaBase} {uiLocale} />
                  </section>
                {/each}
                {#if changed.more}
                  <p>{m.activity_diff_more({ count: changed.more }, options)}</p>
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
          {more ? m.common_loading({}, options) : m.activity_load_more({}, options)}
        </button>
      </div>
    {/if}
  {/if}
</main>
