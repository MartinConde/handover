<script lang="ts">
import { ACTIVITY_GROUPS, type ActivityEvent, activityGroupOf } from '@handover/core';

let { role }: { role: 'owner' | 'editor' } = $props();

let events = $state<ActivityEvent[]>([]);
let cursor = $state<string | null>(null);
let loading = $state(true);
let more = $state(false);
let failure = $state('');
let people = $state<{ id: string; name: string; email: string }[]>([]);

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
/** Which row has its reason open — one at a time, the way the log reads. */
let why = $state('');

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

// `src/content/<collection>/<locale>/<slug>.yaml` — the only subject shape that is somewhere to
// go. A user id or a media id is a key, and a key on screen tells nobody anything.
const ENTRY = /^src\/content\/([\w-]+)\/([\w-]+)\/([\w-]+)\.yaml$/;
const entryOf = (subject: string | null) => {
  const found = subject?.match(ENTRY);
  return found
    ? { href: `/admin/c/${found[1]}/${found[3]}`, label: found[3] ?? '', locale: found[2] ?? '' }
    : undefined;
};

/** `detail` is small json written by whichever route caused the event, so every read of it is a
    read of one named key and never of the blob. */
const str = (detail: unknown, key: string): string | undefined => {
  const value = (detail as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' ? value : undefined;
};

const METHOD: Record<string, string> = {
  password: 'with a password',
  link: 'with an email link',
  github: 'through GitHub',
};
const ROLES: Record<string, string> = { owner: 'an owner', editor: 'an editor' };
const HOW: Record<string, string> = {
  first: 'set their first password',
  changed: 'changed their password',
  reset: 'reset their password',
};
/** The two keys a client owns, as the settings screen names them, and what can happen to one. */
const INTEGRATIONS: Record<string, string> = {
  deepl: 'DeepL key',
  assist: 'writing help key',
};
const HOW_KEY: Record<string, string> = { set: 'set', replaced: 'replaced', removed: 'removed' };
const MESSAGE: Record<string, string> = {
  'sign-in link': 'A sign-in link',
  invite: 'An invite',
  'password reset': 'A password reset',
};

/** The kinds a restore is offered over, which are the two commits that take a file away. */
const RESTORABLE = ['entry-delete', 'locale-off'];

const who = (event: ActivityEvent) =>
  event.user ? event.user.name || event.user.email || 'A removed member' : 'System';
/** The subject of an Accounts event is a member id; the list an owner already has gives it a name. */
const named = (id: string | null) => {
  const found = people.find((p) => p.id === id);
  return found ? found.name || found.email : 'a member';
};

interface Said {
  lead: string;
  link?: { href: string; label: string; locale: string };
  /** Why a publish was not made. The one kind of row that expands, until 3.19 draws the diff. */
  reason?: string;
}

const REFUSED: Record<string, string> = {
  'ref-moved':
    'Another change reached the repository first. Nothing was written, and publishing again writes on top of it.',
  refused: 'The repository would not take the commit. Nothing was written.',
};
const changed = (files: number) =>
  files === 1
    ? 'That file had changed in the repository after it was opened. Nothing was written: discard the draft in the pending-changes drawer, then publish again.'
    : `${files} files had changed in the repository after they were opened. Nothing was written: discard those drafts in the pending-changes drawer, then publish again.`;
/** How many files a Publishing event was about, as its route wrote it down. */
const count = (detail: unknown, key: 'files' | 'done' = 'files'): number => {
  const value = (detail as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'number' ? value : 0;
};
/** The languages a removal took away, as the row that would put them back names them. */
const went = (detail: unknown): string => {
  const value = (detail as { locales?: unknown } | null | undefined)?.locales;
  return Array.isArray(value) ? value.map((l) => String(l).toUpperCase()).join(', ') : '';
};

/** What each cron job did, in the words of the screen it did it to. */
const JOB_DID: Record<string, (n: number) => string> = {
  reconcile: (n) =>
    `The hourly media check recorded ${n} upload${n === 1 ? '' : 's'} the library had missed.`,
  retention: (n) =>
    `The daily clean-up removed ${n} activity row${n === 1 ? '' : 's'} older than 180 days.`,
  orphans: (n) =>
    `The daily clean-up discarded ${n} draft${n === 1 ? '' : 's'} whose file is no longer in the repository.`,
};
const JOB_NAME: Record<string, string> = {
  reconcile: 'hourly media check',
  retention: 'daily activity clean-up',
  orphans: 'daily draft clean-up',
};

function said(event: ActivityEvent): Said {
  const actor = who(event);
  const d = event.detail;
  if (event.kind.startsWith('cron-')) {
    const job = event.kind.slice('cron-'.length);
    const failed = str(d, 'error');
    if (failed) return { lead: `The ${JOB_NAME[job] ?? `${job} job`} failed: ${failed}.` };
    const n = count(d, 'done');
    return {
      lead: JOB_DID[job]?.(n) ?? `The ${job} job ran and did ${n} thing${n === 1 ? '' : 's'}.`,
    };
  }
  switch (event.kind) {
    case 'login': {
      const how = METHOD[str(d, 'method') ?? ''];
      return { lead: how ? `${actor} signed in ${how}.` : `${actor} signed in.` };
    }
    case 'invite':
      return {
        lead: `${actor} invited ${str(d, 'email') ?? 'somebody'} as ${ROLES[str(d, 'role') ?? ''] ?? 'a member'}.`,
      };
    case 'role-change':
      return {
        lead: `${actor} made ${named(event.subject)} ${ROLES[str(d, 'role') ?? ''] ?? 'a member'}.`,
      };
    case 'member-removed': {
      const address = str(d, 'email') ?? 'somebody';
      return {
        lead: (d as { pending?: unknown } | null)?.pending
          ? `${actor} revoked the invite to ${address}.`
          : `${actor} removed ${address}.`,
      };
    }
    case 'password-set':
      return { lead: `${actor} ${HOW[str(d, 'how') ?? ''] ?? 'set their password'}.` };
    case 'publish': {
      const one = entryOf(event.subject);
      if (one) return { lead: `${actor} published `, link: one };
      const files = (d as { files?: unknown } | null)?.files;
      const many =
        typeof files === 'number' ? `${files} file${files === 1 ? '' : 's'}` : 'several files';
      return { lead: `${actor} published ${many}.` };
    }
    case 'publish-failed':
      return {
        lead: 'Publish failed: the repository refused the update.',
        reason: REFUSED[str(d, 'reason') ?? ''] ?? REFUSED.refused,
      };
    case 'publish-conflict': {
      const one = entryOf(event.subject);
      const files = count(d);
      return {
        lead: one
          ? 'Publish stopped: somebody else had changed '
          : `Publish stopped: ${files} files had changed in the repository.`,
        link: one,
        reason: changed(one ? 1 : files),
      };
    }
    case 'hold-released': {
      const one = entryOf(event.subject);
      const from = str(d, 'from');
      const whose = from ? `${from}'s hold` : 'the hold';
      return one
        ? { lead: `${actor} released ${whose} on `, link: one }
        : { lead: `${actor} released ${whose}.` };
    }
    case 'lock-takeover': {
      const one = entryOf(event.subject);
      const from = str(d, 'from');
      const whose = from ? `${from}'s editing of ` : 'editing of ';
      return one
        ? { lead: `${actor} took over ${whose}`, link: one }
        : { lead: `${actor} took over an entry.` };
    }
    case 'setting-changed': {
      // The log holds the name of the key and what happened to it, never the value, so the row
      // has nothing else to say. An unknown key is still a record of a change.
      const did = HOW_KEY[str(d, 'how') ?? ''] ?? 'changed';
      const key = INTEGRATIONS[event.subject ?? ''];
      return { lead: key ? `${actor} ${did} the ${key}.` : `${actor} ${did} a key.` };
    }
    case 'entry-delete': {
      // Named rather than linked: the entry is gone, and a row pointing at a page that answers
      // 404 is worse than the file name on its own.
      const gone = entryOf(event.subject);
      const langs = went(d);
      return {
        lead: `${actor} deleted ${gone?.label ?? 'an entry'}${langs ? ` (${langs})` : ''}.`,
      };
    }
    case 'locale-off': {
      const one = entryOf(event.subject);
      const langs = went(d) || 'a language';
      return one
        ? { lead: `${actor} turned ${langs} off for `, link: one }
        : { lead: `${actor} turned ${langs} off for an entry.` };
    }
    case 'revert': {
      // Both are the same inverse commit, so the detail is what tells them apart: one takes a
      // publish back, the other puts a delete back.
      const one = entryOf(event.subject);
      if (!(d as { restore?: unknown } | null)?.restore)
        return { lead: `${actor} undid a publish.` };
      return one
        ? { lead: `${actor} restored `, link: one }
        : { lead: `${actor} restored ${count(d)} files.` };
    }
    case 'upload':
      // No library to open until Phase 4, so the name it was chosen as is the whole row.
      return { lead: `${actor} uploaded ${str(d, 'name') ?? 'a file'}.` };
    case 'mail-failed':
      return { lead: `${MESSAGE[str(d, 'message') ?? ''] ?? 'A message'} could not be sent.` };
  }
  // Later kinds arrive without opening this file. A row whose sentence nobody has written is
  // still a record of something, so it names the kind rather than throwing or vanishing.
  const one = entryOf(event.subject);
  return { lead: one ? `${actor} — ${event.kind} ` : `${actor} — ${event.kind}`, link: one };
}

const initials = (event: ActivityEvent) =>
  (event.user?.name || event.user?.email || '')
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const EXACT = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short' });
const midnight = (at: number) => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/**
 * A week is where a distance stops being an answer: "1 week ago" is not something an audit can
 * be read off, so anything older is its date. The day buckets count calendar days from local
 * midnight rather than dividing elapsed milliseconds, because a day is 23 or 25 hours across a
 * daylight-saving change — 2026-03-29 02:00 local is 25 hours after 2026-03-28 01:00 here.
 */
function when(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round((midnight(Date.now()) - midnight(at)) / 86_400_000);
  if (days <= 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return DATE.format(at);
}
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
        {@const line = said(event)}
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
                {#if line.reason}
                  <button
                    class="btn btn-ghost btn-icon"
                    type="button"
                    aria-expanded={why === event.id}
                    aria-controls="why-{event.id}"
                    aria-label="Why it failed, {when(event.at)}"
                    onclick={() => (why = why === event.id ? '' : event.id)}
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
