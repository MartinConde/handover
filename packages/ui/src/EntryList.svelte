<script lang="ts">
import { entryName } from '@handover/core';
import { EXACT, when } from './activity-line';
import { navigate } from './navigate';
import OffsiteDialog, { type Target } from './Offsite.svelte';

type Entry = {
  id: string;
  locales: Record<string, { title: string; path: string; status?: 'hidden' }>;
  /** The languages it is offered in, absent when that is every language the site declares. */
  offered?: string[];
  /** Whether it has unpublished changes, which is what a duplicate can be asked to carry. */
  pending?: boolean;
  /** Who has it open right now. */
  editing?: { id: string; name: string | null };
  /** Who last touched it and how — the draft's editor, or the publish that carried it out. */
  edited?: { at: number; by: string | null; kind: 'edit' | 'publish' } | null;
};
/** One thing the CMS took away, as the activity log remembers it. */
type Deleted = {
  id: string;
  at: number;
  by: string | null;
  slug: string;
  /** The languages that went — every one the entry had, or the ones turned off. */
  locales: string[];
  whole: boolean;
  commit_sha: string;
  /** Why it cannot come back: something is at one of its paths again. */
  blocked?: string;
};
let { collection, onchanged }: { collection: string; onchanged: () => void } = $props();

let entries = $state<Entry[]>([]);
// Which set is on screen. A tab rather than a filter: the filters all narrow the same list and
// this one changes which list, because a deleted entry is in neither the index nor the drafts.
let tab = $state<'all' | 'deleted'>('all');
let deleted = $state<Deleted[]>([]);
let deletedLoading = $state(false);
// The row whose restore is waiting to be confirmed.
let putting = $state<Deleted>();
// The languages the site declares, in its own order. One and the column is not drawn at all.
let locales = $state<string[]>([]);
// The page above this collection, which is where a hidden entry's readers go by default.
let index = $state<string>();
// The starters this collection ships, and which one New entry is set to — '' is Blank.
let templates = $state<string[]>([]);
let starter = $state('');
// Whether a duplicate carries the unpublished changes as well as the published file.
let withDrafts = $state(false);
let loading = $state(true);
let dialog = $state<'' | 'new' | 'rename' | 'duplicate'>('');
// The rows the bulk bar is about; checking any one of them reveals the column for all.
let chosen = $state<string[]>([]);
// What the redirect question is open over: hiding one row or the whole selection, or deleting
// one entry. Both take a page off the site, so both ask it.
let offsite = $state<{ action: 'hide' | 'delete'; ids: string[] }>();
/** The row whose ⋯ is open, by entry id. A disclosure and not `role="menu"`, as on Members. */
let menuFor = $state('');
let target = $state<Entry>();
let text = $state('');
let busy = $state(false);
let error = $state('');
let field = $state<HTMLInputElement>();

$effect(() => {
  load(collection);
});
// Asked for only when it is looked at: an entry list nobody opens the tab on costs no query.
$effect(() => {
  if (tab === 'deleted') loadDeleted(collection);
});
$effect(() => {
  field?.focus();
});

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const singular = $derived(collection.replace(/s$/, ''));
// The first language the entry is written in, in the site's own order: an entry that exists
// in German alone is listed by its German title rather than by its file name.
const titleOf = (entry: Entry) =>
  locales.map((l) => entry.locales[l]?.title).find(Boolean) ||
  Object.values(entry.locales)[0]?.title ||
  entry.id;
const many = $derived(locales.length > 1);
// A language turned off for the entry gets no file, so it is not one still to write.
const offered = (entry: Entry, locale: string) => entry.offered?.includes(locale) ?? true;
// `_status` is the entry's rather than one language's, so any file of it saying so is the answer.
const isHidden = (entry: Entry) => Object.values(entry.locales).some((l) => l.status === 'hidden');
// The one filter the toolbar has: the rows the site shows, the ones it does not, or every row.
let showing = $state<'all' | 'live' | 'hidden'>('all');
const shown = $derived(
  showing === 'all' ? entries : entries.filter((e) => isHidden(e) === (showing === 'hidden')),
);
const named = (ids: string[]) =>
  ids.length === 1 ? (entries.find((e) => e.id === ids[0]) ?? undefined) : undefined;

// The same derivation the server runs on the same names, so the dialog can promise the file
// name before anything is written. A rename does not collide with the entry being renamed.
const preview = $derived(
  entryName(
    'default',
    text,
    entries.map((e) => e.id).filter((id) => dialog !== 'rename' || id !== target?.id),
  ),
);
// `house` → `House`, which is all a file name has to say to be picked from a list of two.
const starterLabel = (name: string) => capitalise(name.replace(/-/g, ' '));

const WHEN = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

async function loadDeleted(name: string) {
  deletedLoading = true;
  const res = await fetch(`/admin/api/deleted/${name}`);
  deletedLoading = false;
  if (res.ok) deleted = ((await res.json()) as { deleted: Deleted[] }).deleted;
  else error = `Could not load what was deleted (${res.status})`;
}

async function load(name: string) {
  const res = await fetch(`/admin/api/entries/${name}`);
  if (res.ok) {
    const body = (await res.json()) as {
      entries: Entry[];
      locales?: string[];
      index?: string;
      templates?: string[];
    };
    entries = body.entries;
    locales = body.locales ?? [];
    index = body.index;
    templates = body.templates ?? [];
  } else error = `Could not load the list (${res.status})`;
  loading = false;
}

// Showing an entry again has no question to ask; hiding one always does.
async function status(ids: string[], hidden: boolean, redirect?: Target) {
  const res = await send(
    `/admin/api/status/${collection}`,
    json({ entries: ids, hidden, redirect }),
  );
  if (!res) return;
  chosen = [];
  await done();
}

function open(kind: 'new' | 'rename' | 'duplicate', entry?: Entry) {
  dialog = kind;
  target = entry;
  text = kind === 'new' ? '' : kind === 'rename' ? (entry?.id ?? '') : `${entry?.id ?? ''}-copy`;
  starter = '';
  withDrafts = false;
  error = '';
}
const close = () => {
  dialog = '';
  offsite = undefined;
  putting = undefined;
  error = '';
};

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// A 409 is the server's own sentence — "publish this first", "someone else changed it" —
// and reads better than anything this component could say about it. So is the 503 that says
// the App cannot see the repository.
async function send(url: string, init: RequestInit) {
  busy = true;
  error = '';
  const res = await fetch(url, init);
  busy = false;
  if (res.ok) return res;
  error =
    res.status === 409 || res.status === 503
      ? said(await res.text())
      : `That did not work (${res.status})`;
  return undefined;
}

// A refused restore names the files it is about in json; everything else answers in words.
const said = (body: string) =>
  body.startsWith('{') ? ((JSON.parse(body) as { error?: string }).error ?? body) : body;

// Undoing the commit that took the files away, which is the same inverse a revert is. Both
// lists move: the entry is back in one and its row can no longer be restored in the other.
async function restore(row: Deleted) {
  if (!(await send('/admin/api/restore', json({ commit_sha: row.commit_sha })))) return;
  close();
  await Promise.all([load(collection), loadDeleted(collection)]);
  onchanged();
}

async function create(event: Event) {
  event.preventDefault();
  const res = await send(
    `/admin/api/entries/${collection}`,
    json({ title: text, ...(starter ? { template: starter } : {}) }),
  );
  if (!res) return;
  const { slug } = (await res.json()) as { slug: string };
  navigate(`/admin/c/${collection}/${slug}`);
}

// The copy is a draft like a new entry, so it opens the same way — its own lock, nothing in
// the repository until somebody publishes it.
async function duplicate(event: Event) {
  event.preventDefault();
  const url = `/admin/api/entries/${collection}/${target?.id}/duplicate`;
  const res = await send(url, json({ to: text, ...(withDrafts ? { drafts: true } : {}) }));
  if (!res) return;
  const { slug } = (await res.json()) as { slug: string };
  navigate(`/admin/c/${collection}/${slug}`);
}

async function rename(event: Event) {
  event.preventDefault();
  const url = `/admin/api/entries/${collection}/${target?.id}/rename`;
  if (!(await send(url, json({ to: text })))) return;
  await done();
}

// The answer travels with the DELETE: a delete commits now, so the rules go into the commit
// that takes the files away rather than waiting on a publish the way a hide's do.
async function remove(id: string, redirect: Target) {
  const url = `/admin/api/entries/${collection}/${id}`;
  if (!(await send(url, { ...json({ redirect }), method: 'DELETE' }))) return;
  await done();
}

// The list and the unpublished-changes count both moved; neither is this component's to keep.
async function done() {
  close();
  await load(collection);
  onchanged();
}
</script>

<svelte:window
  onkeydown={(e) => e.key === 'Escape' && (menuFor ? (menuFor = '') : close())}
  onclick={(e) => menuFor && !(e.target as HTMLElement).closest('.row-menu') && (menuFor = '')}
/>

<main class="main">
  <div class="list-toolbar">
    <h1>{capitalise(collection)} <span class="count">{showing === 'all' ? entries.length : `${shown.length} of ${entries.length}`}</span></h1>
    <span class="spacer"></span>
    <div class="filters">
      <label class="visually-hidden" for="list-status">Status</label>
      <select class="input" id="list-status" bind:value={showing}>
        <option value="all">All</option>
        <option value="live">Live</option>
        <option value="hidden">Hidden</option>
      </select>
    </div>
    <button class="btn btn-primary" type="button" onclick={() => open('new')}>New {singular}</button>
  </div>
  <div class="tabs" role="tablist" aria-label="Which {collection}">
    <button
      type="button"
      role="tab"
      aria-selected={tab === 'all'}
      onclick={() => (tab = 'all')}>All</button
    >
    <button
      type="button"
      role="tab"
      aria-selected={tab === 'deleted'}
      onclick={() => (tab = 'deleted')}>Deleted</button
    >
  </div>
  {#if error && !dialog}<p class="notice notice-danger" role="alert">{error}</p>{/if}
  {#if tab === 'deleted'}
    <p class="list-note">
      A deleted {singular} is in neither the published site nor your unpublished changes, so this is
      a record of what happened rather than a filter over the list. Kept for 180 days.
    </p>
    {#if deletedLoading && !deleted.length}
      <p class="placeholder">Loading…</p>
    {:else if deleted.length}
      <div class="table cols-4" role="table" aria-label="Deleted {collection}">
        <div class="row-head" role="row">
          <div class="th" role="columnheader">File name</div>
          <div class="th" role="columnheader">What went</div>
          <div class="th" role="columnheader">Deleted</div>
          <div class="th" role="columnheader"><span class="visually-hidden">Actions</span></div>
        </div>
        {#each deleted as row (row.id)}
          <div class="row" role="row">
            <div class="td title filename" role="cell">{row.slug}</div>
            <div class="td" role="cell" data-label="What went">
              {row.whole ? `The whole ${singular}` : 'One language'}
              {#if row.locales.length}
                <span class="visually-hidden">Languages:</span>
                <span class="chips">
                  {#each row.locales as locale (locale)}
                    <span class="chip">{locale.toUpperCase()}</span>
                  {/each}
                </span>
              {/if}
            </div>
            <div class="td num" role="cell" data-label="Deleted">
              {row.by ?? 'System'}
              <span class="sep" aria-hidden="true">·</span>
              {WHEN.format(row.at)}
            </div>
            <div class="td menu-cell" role="cell">
              <!-- Greyed with aria-disabled rather than disabled: a disabled button takes no
                   focus, and a keyboard user would arrow past the reason without hearing it. -->
              <button
                class="btn btn-sm"
                type="button"
                aria-disabled={Boolean(row.blocked)}
                aria-describedby={row.blocked ? `why-${row.id}` : undefined}
                onclick={() => !row.blocked && (putting = row)}
                >Restore<span class="visually-hidden"> {row.slug}</span></button
              >
            </div>
          </div>
          {#if row.blocked}
            <div class="row row-note" role="row">
              <div class="td" role="cell">
                <p class="notice notice-warn" id="why-{row.id}">
                  Can't be restored: {row.blocked} Rename what is there, then try again.
                </p>
              </div>
            </div>
          {/if}
        {/each}
      </div>
    {:else}
      <div class="empty">
        <div>
          <h2>Nothing has been deleted</h2>
          <p>
            Deleted {collection} turn up here for as long as the activity log keeps them — 180 days
            on this site.
          </p>
        </div>
      </div>
    {/if}
  {:else if loading}
    <p class="placeholder">Loading…</p>
  {:else if entries.length && !shown.length}
    <p class="placeholder">No {showing} {collection}.</p>
  {:else if entries.length}
    <!-- The languages column is the one that comes and goes; without it the grid is the
         stylesheet's five-column `has-select.cols-4`, with it the six-column default. -->
    <div class="table has-select" class:cols-4={!many} role="table" aria-label={capitalise(collection)}>
      <!-- The header cells need a row of their own, and every cell a role: `role="table"`
           with `columnheader` children and nothing between them is aria-required-parent. Both
           wrappers are `display: contents`, so the grid is unchanged. -->
      <div class="row-head" role="row">
        <div class="th" role="columnheader">
          <input
            type="checkbox"
            aria-label="Select all"
            checked={chosen.length === shown.length && shown.length > 0}
            onchange={(e) => (chosen = e.currentTarget.checked ? shown.map((x) => x.id) : [])}
          />
        </div>
        <div class="th" role="columnheader">Title</div>
        {#if many}<div class="th" role="columnheader">Languages</div>{/if}
        <div class="th" role="columnheader">Edited</div>
        <div class="th" role="columnheader">File name</div>
        <div class="th" role="columnheader"><span class="visually-hidden">Actions</span></div>
      </div>
      {#each shown as entry (entry.id)}
        <div class="row" role="row" class:is-selected={chosen.includes(entry.id)}>
          <div class="td" role="cell">
            <input
              type="checkbox"
              aria-label="Select {titleOf(entry)}"
              checked={chosen.includes(entry.id)}
              onchange={(e) =>
                (chosen = e.currentTarget.checked
                  ? [...chosen, entry.id]
                  : chosen.filter((id) => id !== entry.id))}
            />
          </div>
          <div class="td title" role="cell">
            <a href="/admin/c/{collection}/{entry.id}">{titleOf(entry)}</a>
            {#if isHidden(entry)}<span class="badge">Hidden</span>{/if}
            {#if entry.editing}<span class="badge">Being edited by {entry.editing.name || 'somebody'}</span>{/if}
          </div>
          {#if many}
            <div class="td" role="cell" data-label="Languages">
              <span class="visually-hidden">Languages:</span>
              <span class="chips">
                {#each locales as locale (locale)}
                  <span
                    class="chip"
                    class:chip-missing={!entry.locales[locale] && offered(entry, locale)}
                    class:chip-disabled={!offered(entry, locale)}
                    title="{locale}: {offered(entry, locale)
                      ? entry.locales[locale]
                        ? 'written'
                        : 'not written yet'
                      : 'turned off for this entry'}"
                  >{locale.toUpperCase()}</span>
                {/each}
              </span>
            </div>
          {/if}
          <div class="td edited" role="cell" data-label="Edited">
            {#if entry.edited}
              <span class="sub"
                >{entry.edited.kind === 'edit' ? 'Edited' : 'Published'}{#if entry.edited.by}{` by ${entry.edited.by}`}{/if}{' '}<time
                  datetime={new Date(entry.edited.at).toISOString()}
                  title={EXACT.format(entry.edited.at)}>{when(entry.edited.at).toLowerCase()}</time
                ></span
              >
            {/if}
          </div>
          <div class="td num filename" role="cell" data-label="File name">{entry.id}</div>
          <div class="td menu-cell" role="cell">
            <div class="row-menu">
              <button
                class="btn btn-ghost btn-sm"
                type="button"
                aria-expanded={menuFor === entry.id}
                aria-label="Actions for {titleOf(entry)}"
                onclick={() => (menuFor = menuFor === entry.id ? '' : entry.id)}>⋯</button
              >
              {#if menuFor === entry.id}
                <div class="menu">
                  <button type="button" onclick={() => { menuFor = ''; open('duplicate', entry); }}>Duplicate</button>
                  <button type="button" onclick={() => { menuFor = ''; open('rename', entry); }}>Rename</button>
                  <!-- Hide before Delete, so the gentler answer is the one reached first. -->
                  <button
                    type="button"
                    disabled={busy}
                    onclick={() => {
                      menuFor = '';
                      if (isHidden(entry)) status([entry.id], false);
                      else offsite = { action: 'hide', ids: [entry.id] };
                    }}>{isHidden(entry) ? 'Show' : 'Hide'}</button
                  >
                  <hr />
                  <button type="button" onclick={() => { menuFor = ''; offsite = { action: 'delete', ids: [entry.id] }; }}>Delete</button>
                </div>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
    {#if chosen.length}
      <div class="bulk-bar" role="region" aria-label="Bulk actions">
        {chosen.length} selected
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" type="button" onclick={() => (chosen = [])}>Clear</button>
        <button
          class="btn btn-sm"
          type="button"
          disabled={busy}
          onclick={() => (offsite = { action: 'hide', ids: chosen })}
        >
          Hide {chosen.length} {chosen.length === 1 ? singular : collection}
        </button>
      </div>
    {/if}
  {:else}
    <div class="empty">
      <div>
        <h2>No {collection} yet</h2>
        <p>Every {singular} is one file under <code>src/content/{collection}/</code>.</p>
        <button class="btn btn-primary" type="button" onclick={() => open('new')}>
          New {singular}
        </button>
      </div>
    </div>
  {/if}
</main>

{#if putting}
  {@const row = putting}
  <div class="scrim">
    <div class="dialog" role="dialog" aria-labelledby="restore-h">
      <h2 id="restore-h">Restore {row.slug}?</h2>
      <p>
        The files come back as they were on {WHEN.format(row.at)}, in a commit of its own — the
        site has them again as soon as the build is through.
      </p>
      <ul class="publish-set">
        <li>
          {#if row.locales.length}
            <span class="chips" aria-hidden="true">
              {#each row.locales as locale (locale)}<span class="chip">{locale.toUpperCase()}</span
                >{/each}
            </span>
          {/if}
          {row.whole ? 'Every language file it had' : 'The language file that was turned off'}
        </li>
        <li>The redirect that was added when it went is taken back out</li>
      </ul>
      <p class="hint">
        Pictures are never deleted with an entry, so the gallery comes back whole.
      </p>
      {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
      <div class="actions">
        <button class="btn" type="button" onclick={close}>Cancel</button>
        <button class="btn btn-primary" type="button" disabled={busy} onclick={() => restore(row)}>
          {busy ? 'Restoring…' : 'Restore'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if offsite}
  {@const ids = offsite.ids}
  {@const action = offsite.action}
  <OffsiteDialog
    {action}
    what={named(ids) ? titleOf(named(ids) as Entry) : `${ids.length} ${collection}`}
    many={ids.length > 1}
    {collection}
    {index}
    {busy}
    {error}
    onconfirm={(target) =>
      action === 'delete' ? remove(ids[0] ?? '', target) : status(ids, true, target)}
    onhide={() => (offsite = { action: 'hide', ids })}
    onclose={close}
  />
{/if}

<!-- Not aria-modal: the shell behind stays reachable until the design gate gives these the
     drawer's inert treatment, and claiming a trap that is not there is worse than not claiming it. -->
{#if dialog}
  <div class="scrim">
    <div class="dialog" role="dialog" aria-labelledby="entry-dialog-h">
      {#if dialog === 'rename'}
        <h2 id="entry-dialog-h">Rename {titleOf(target as Entry)}</h2>
        <form onsubmit={rename}>
          <div class="field">
            <div class="label-row"><label for="rename-to">File name</label></div>
            <input
              class="input filename"
              id="rename-to"
              type="text"
              bind:value={text}
              bind:this={field}
              aria-describedby="rename-hint"
            />
            <p class="hint" id="rename-hint">
              Saved as <span class="filename">{preview}</span>. The old address redirects to the new
              one.
            </p>
          </div>
          {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
          <div class="actions">
            <button class="btn" type="button" onclick={close}>Cancel</button>
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Renaming…' : 'Rename'}
            </button>
          </div>
        </form>
      {:else if dialog === 'duplicate'}
        <h2 id="entry-dialog-h">Duplicate {titleOf(target as Entry)}</h2>
        <form onsubmit={duplicate}>
          <div class="field">
            <div class="label-row"><label for="copy-to">File name</label></div>
            <input
              class="input filename"
              id="copy-to"
              type="text"
              bind:value={text}
              bind:this={field}
              aria-describedby="copy-hint"
            />
            <p class="hint" id="copy-hint">
              Saved as <span class="filename">{preview}</span>.
              {#if many}Every language comes with it, and the{:else}The{/if} copy is hidden until
              you show it.
            </p>
          </div>
          {#if target?.pending}
            <label class="choice">
              <input type="checkbox" bind:checked={withDrafts} />
              Duplicate including unpublished changes
            </label>
          {/if}
          {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
          <div class="actions">
            <button class="btn" type="button" onclick={close}>Cancel</button>
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Duplicating…' : 'Duplicate'}
            </button>
          </div>
        </form>
      {:else}
        <h2 id="entry-dialog-h">New {singular}</h2>
        <form onsubmit={create}>
          <div class="field">
            <div class="label-row"><label for="new-title">Title</label></div>
            <input
              class="input"
              id="new-title"
              type="text"
              bind:value={text}
              bind:this={field}
              aria-describedby="new-hint"
            />
            <p class="hint" id="new-hint">
              Saved as <span class="filename">{preview}</span>. This becomes the web address.
            </p>
          </div>
          {#if templates.length}
            <fieldset>
              <legend>Start from</legend>
              <label class="choice">
                <input type="radio" name="starter" value="" bind:group={starter} /> Blank
              </label>
              {#each templates as name (name)}
                <label class="choice">
                  <input type="radio" name="starter" value={name} bind:group={starter} />
                  {starterLabel(name)} <span class="desc">template</span>
                </label>
              {/each}
            </fieldset>
          {/if}
          {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
          <div class="actions">
            <button class="btn" type="button" onclick={close}>Cancel</button>
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      {/if}
    </div>
  </div>
{/if}
