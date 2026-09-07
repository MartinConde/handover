<script lang="ts">
import { entryName } from '@handover/core';
import { EXACT, when } from './activity-line';
import NewEntry, { nameOf } from './NewEntry.svelte';
import { navigate } from './navigate';
import OffsiteDialog, { type Target } from './Offsite.svelte';
import { request as fetch, sitePath } from './request.js';

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
  /** The languages the last build found translated from a source that has moved on since. */
  stale?: string[];
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
let {
  collection,
  onchanged,
  role,
  onsaved,
}: {
  collection: string;
  onchanged: () => void;
  /** Saving a template shapes every entry made after it, so the item is the owner's. */
  role?: 'owner' | 'editor';
  onsaved?: (name: string) => void;
} = $props();

let entries = $state<Entry[]>([]);
// A tab, not a filter: a deleted entry is in neither the index nor the drafts.
let tab = $state<'all' | 'deleted'>('all');
let deleted = $state<Deleted[]>([]);
let deletedLoading = $state(false);
// The row whose restore is waiting to be confirmed.
let putting = $state<Deleted>();
// The site's languages in its own order; with one the column is not drawn at all.
let locales = $state<string[]>([]);
// The page above this collection, which is where a hidden entry's readers go by default.
let index = $state<string>();
// The starters the collection has, which a saved template's name must not repeat.
let templates = $state<string[]>([]);
// Whether a duplicate carries the unpublished changes as well as the published file.
let withDrafts = $state(false);
let loading = $state(true);
let dialog = $state<'' | 'new' | 'rename' | 'duplicate' | 'template'>('');
// The rows the bulk bar is about; checking any one of them reveals the column for all.
let chosen = $state<string[]>([]);
// Hiding and deleting both take a page off the site, so both ask the redirect question.
let offsite = $state<{ action: 'hide' | 'delete'; ids: string[] }>();
/** The row whose ⋯ is open; a disclosure and not `role="menu"`, as on Members. */
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
const singular = $derived(nameOf(collection));
// An entry that exists in German alone is listed by its German title, not its file name.
const titleOf = (entry: Entry) =>
  locales.map((l) => entry.locales[l]?.title).find(Boolean) ||
  Object.values(entry.locales)[0]?.title ||
  entry.id;
const many = $derived(locales.length > 1);
// A language turned off for the entry gets no file, so it is not one still to write.
const offered = (entry: Entry, locale: string) => entry.offered?.includes(locale) ?? true;
// `_status` is the entry's rather than one language's, so any file of it saying so is the answer.
const isHidden = (entry: Entry) => Object.values(entry.locales).some((l) => l.status === 'hidden');
// The dashboard's *Show* arrives as `?locale=de`, read once when the list opens.
let search = $state('');
let showing = $state<'all' | 'live' | 'hidden'>('all');
let language = $state(new URLSearchParams(location.search).get('locale') ?? '');
const owes = (entry: Entry, locale: string) =>
  offered(entry, locale) && (!entry.locales[locale] || (entry.stale?.includes(locale) ?? false));
const shown = $derived(
  entries.filter(
    (e) =>
      (showing === 'all' || isHidden(e) === (showing === 'hidden')) &&
      (!language || owes(e, language)) &&
      (!search.trim() ||
        [e.id, ...Object.values(e.locales).map((value) => value.title)].some((value) =>
          value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
        )),
  ),
);
const filtered = $derived(showing !== 'all' || language !== '' || search.trim() !== '');
const chipTitle = (entry: Entry, locale: string) =>
  !offered(entry, locale)
    ? 'turned off for this entry'
    : !entry.locales[locale]
      ? 'not written yet'
      : entry.stale?.includes(locale)
        ? 'behind the language it was translated from'
        : 'written';
const named = (ids: string[]) =>
  ids.length === 1 ? (entries.find((e) => e.id === ids[0]) ?? undefined) : undefined;

// The same derivation the server runs, so the dialog can promise the file name in advance.
const preview = $derived(
  entryName(
    'default',
    text,
    dialog === 'template'
      ? templates
      : entries.map((e) => e.id).filter((id) => dialog !== 'rename' || id !== target?.id),
  ),
);
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
    // A language the address names and the site does not declare filters nothing.
    if (!locales.includes(language)) language = '';
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

function open(kind: 'new' | 'rename' | 'duplicate' | 'template', entry?: Entry) {
  dialog = kind;
  target = entry;
  text = kind === 'new' ? '' : kind === 'duplicate' ? `${entry?.id ?? ''}-copy` : (entry?.id ?? '');
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

// A 409 or 503 is the server's own sentence and reads better than anything said here.
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

// The same inverse commit as a revert; both lists move, so both are read again.
async function restore(row: Deleted) {
  if (!(await send('/admin/api/restore', json({ commit_sha: row.commit_sha })))) return;
  close();
  await Promise.all([load(collection), loadDeleted(collection)]);
  onchanged();
}

// The copy is a draft like a new entry, so it opens the same way with its own lock.
async function duplicate(event: Event) {
  event.preventDefault();
  const url = `/admin/api/entries/${collection}/${target?.id}/duplicate`;
  const res = await send(url, json({ to: text, ...(withDrafts ? { drafts: true } : {}) }));
  if (!res) return;
  const { slug } = (await res.json()) as { slug: string };
  navigate(`/admin/c/${collection}/${slug}`);
}

// A template is a commit with no screen of its own, so the list stays and the shell says so.
async function saveTemplate(event: Event) {
  event.preventDefault();
  const url = `/admin/api/entries/${collection}/${target?.id}/template`;
  const res = await send(url, json({ to: text }));
  if (!res) return;
  const { name } = (await res.json()) as { name: string };
  close();
  await load(collection);
  onsaved?.(name);
}

async function rename(event: Event) {
  event.preventDefault();
  const url = `/admin/api/entries/${collection}/${target?.id}/rename`;
  if (!(await send(url, json({ to: text })))) return;
  await done();
}

// A delete commits now, so the redirect rules ride in that commit, not a later publish.
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

<main class="main collection-page">
  <div class="list-toolbar">
    <h1>{capitalise(collection)} <span class="count">{filtered ? `${shown.length} of ${entries.length}` : entries.length}</span></h1>
    <span class="spacer"></span>
    <button class="btn btn-primary" type="button" onclick={() => open('new')}>New {singular}</button>
  </div>
  <div class="tabs list-tabs" role="tablist" aria-label="Which {collection}">
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
  {#if tab === 'all'}
    <div class="collection-controls">
      <div class="search-field">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
        <label class="visually-hidden" for="entry-search">Search {collection}</label>
        <input class="input" id="entry-search" type="search" placeholder="Search {collection}…" bind:value={search} />
      </div>
    <div class="filters">
      <label class="visually-hidden" for="list-status">Status</label>
      <select class="filter" class:is-on={showing !== 'all'} id="list-status" bind:value={showing}>
        <option value="all">All</option>
        <option value="live">Live</option>
        <option value="hidden">Hidden</option>
      </select>
      {#if many}
        <label class="visually-hidden" for="list-locale">Language</label>
        <select class="filter" class:is-on={language} id="list-locale" bind:value={language}>
          <option value="">Every language</option>
          {#each locales as locale (locale)}
            <option value={locale}>{locale.toUpperCase()} missing or stale</option>
          {/each}
        </select>
      {/if}
    </div>
      {#if filtered}<button class="btn btn-ghost btn-sm" type="button" onclick={() => { search = ''; showing = 'all'; language = ''; }}>Clear filters</button>{/if}
    </div>
  {/if}
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
              <!-- aria-disabled so the button keeps focus and the reason is heard. -->
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
    <p class="placeholder">
      {search.trim()
        ? `No results for “${search.trim()}”. Try another search or clear the filters.`
        : language
        ? `Nothing is missing or stale in ${language.toUpperCase()}.`
        : `No ${showing} ${collection}.`}
    </p>
  {:else if entries.length}
    <!-- Without the languages column the grid is the five-column `has-select.cols-4`. -->
    <div class="table has-select" class:cols-4={!many} role="table" aria-label={capitalise(collection)}>
      <!-- role="table" needs a row around its columnheaders; display: contents keeps the grid. -->
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
            <a href={sitePath(`/admin/c/${collection}/${entry.id}`)}>{titleOf(entry)}</a>
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
                    class:chip-stale={Boolean(entry.locales[locale]) && entry.stale?.includes(locale)}
                    title="{locale}: {chipTitle(entry, locale)}"
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
                  {#if role === 'owner'}
                    <button type="button" onclick={() => { menuFor = ''; open('template', entry); }}>Save as template</button>
                  {/if}
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
        <p>Create your first {singular} to start adding content to your site.</p>
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

<!-- Not aria-modal: the shell behind stays reachable, so claiming a trap would be false. -->
{#if dialog === 'new'}
  <NewEntry {collection} onclose={close} />
{:else if dialog}
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
      {:else if dialog === 'template'}
        <h2 id="entry-dialog-h">Save {titleOf(target as Entry)} as a template</h2>
        <form onsubmit={saveTemplate}>
          <div class="field">
            <div class="label-row"><label for="template-to">Template name</label></div>
            <input
              class="input filename"
              id="template-to"
              type="text"
              bind:value={text}
              bind:this={field}
              aria-describedby="template-hint"
            />
            <p class="hint" id="template-hint">
              Saved as <span class="filename">{preview}</span> and offered when somebody makes a new
              {singular}. What is published now is what it keeps, in the language it was written in.
            </p>
          </div>
          {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
          <div class="actions">
            <button class="btn" type="button" onclick={close}>Cancel</button>
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save as template'}
            </button>
          </div>
        </form>
      {:else}
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
      {/if}
    </div>
  </div>
{/if}
