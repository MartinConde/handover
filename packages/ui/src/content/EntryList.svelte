<script lang="ts">
import { entryName } from '@handover/core';
import { invalidateEntryDirectory } from '../entry-directory.js';
import {
  messageDetail,
  messageLine,
  messageText,
  responseMessage,
  type UiMessage,
} from '../errors.js';
import {
  capitalise,
  collectionName,
  formatExactTime,
  formatLanguageName,
  formatRelativeTime,
  messageOptions,
  type UiLocale,
} from '../i18n.js';
import { navigate } from '../navigate';
import { missing, offered, owes, partial, queueQuery, rowTitle, stale, workFrom } from '../owed.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, sitePath } from '../request.js';
import Modal from '../shared/Modal.svelte';
import NewEntry from './NewEntry.svelte';
import OffsiteDialog, { type Target } from './Offsite.svelte';

type Entry = {
  id: string;
  locales: Record<string, { title: string; path: string; status?: 'hidden' }>;
  offered?: string[];
  /** Whether it has unpublished changes, which is what a duplicate can be asked to carry. */
  pending?: boolean;
  /** Who has it open right now. */
  editing?: { id: string; name: string | null };
  /** Who last touched it and how — the draft's editor, or the publish that carried it out. */
  edited?: { at: number; by: string | null; kind: 'edit' | 'publish' } | null;
  stale?: string[];
  /** `[written, of]` per partly written language, drafts included. */
  partial?: Record<string, [number, number]>;
  machine?: string[];
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
  oncommitted,
  role,
  onsaved,
  uiLocale = 'en',
}: {
  collection: string;
  onchanged: () => void;
  /** A successful action made a repository commit, so the shell can refresh its build state. */
  oncommitted?: () => void | Promise<void>;
  /** Saving a template shapes every entry made after it, so the item is the owner's. */
  role?: 'owner' | 'editor';
  onsaved?: (name: string) => void;
  uiLocale?: UiLocale;
} = $props();
const options = $derived(messageOptions(uiLocale));

let entries = $state.raw<Entry[]>([]);
// A tab, not a filter: a deleted entry is in neither the index nor the drafts.
let tab = $state<'all' | 'deleted'>('all');
let deleted = $state.raw<Deleted[]>([]);
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
let error = $state<UiMessage>();
let trigger = $state<HTMLElement>();

$effect(() => {
  load(collection);
});
// Asked for only when it is looked at: an entry list nobody opens the tab on costs no query.
$effect(() => {
  if (tab === 'deleted') loadDeleted(collection);
});

const plural = $derived(collectionName(collection, uiLocale));
const collectionLabel = $derived(
  uiLocale === 'en' ? collectionName(collection, uiLocale, 'singular') : plural,
);
const titleOf = (entry: Entry) => rowTitle(entry, locales);
const many = $derived(locales.length > 1);
// `_status` is the entry's rather than one language's, so any file of it saying so is the answer.
const isHidden = (entry: Entry) => Object.values(entry.locales).some((l) => l.status === 'hidden');
// The dashboard's *Show* arrives as `?locale=de`, read once when the list opens.
const address = new URLSearchParams(location.search);
let search = $state('');
let showing = $state<'all' | 'live' | 'hidden'>('all');
let language = $state(address.get('locale') ?? '');
let work = $state(workFrom(address.get('owed')));
// Above four languages a chip each stops reading at a glance, so a row counts and names the owed.
const compact = $derived(locales.length > 4);
const owedIn = (entry: Entry) => locales.filter((l) => owes(entry, l, 'owed'));
const counted = (entry: Entry) => {
  const offer = locales.filter((l) => offered(entry, l));
  return { created: offer.filter((l) => entry.locales[l]).length, offered: offer.length };
};
const summary = (entry: Entry) =>
  m.entry_list_files_created(
    {
      ...counted(entry),
      languages: locales
        .map((l) =>
          m.entry_list_language_state(
            { language: formatLanguageName(l, uiLocale), state: chipTitle(entry, l) },
            options,
          ),
        )
        .join('; '),
    },
    options,
  );
const shown = $derived(
  entries.filter(
    (e) =>
      (showing === 'all' || isHidden(e) === (showing === 'hidden')) &&
      (!language || owes(e, language, work)) &&
      (!search.trim() ||
        [e.id, ...Object.values(e.locales).map((value) => value.title)].some((value) =>
          value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
        )),
  ),
);
const filtered = $derived(showing !== 'all' || language !== '' || search.trim() !== '');
const chipTitle = (entry: Entry, locale: string) =>
  !offered(entry, locale)
    ? m.entry_list_chip_off({}, options)
    : !entry.locales[locale]
      ? m.entry_list_chip_missing({}, options)
      : entry.stale?.includes(locale)
        ? m.entry_list_chip_stale({}, options)
        : partial(entry, locale)
          ? m.entry_list_chip_partial(
              {
                written: entry.partial?.[locale]?.[0] ?? 0,
                count: entry.partial?.[locale]?.[1] ?? 0,
              },
              options,
            )
          : m.entry_list_chip_written({}, options);
// One mark per language, stale before partly written, as the editor's switcher has it.
const chipClass = (entry: Entry, locale: string) =>
  missing(entry, locale)
    ? 'chip-missing'
    : stale(entry, locale)
      ? 'chip-stale'
      : partial(entry, locale)
        ? 'chip-partial'
        : undefined;
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
const textOf = (message: UiMessage) => messageText(message, uiLocale);
const dialogError = $derived(error ? messageLine(error, uiLocale) : '');

async function loadDeleted(name: string) {
  deletedLoading = true;
  const res = await fetch(`/admin/api/deleted/${name}`);
  deletedLoading = false;
  if (res.ok) deleted = ((await res.json()) as { deleted: Deleted[] }).deleted;
  else error = await responseMessage(res, 'ENTRY_DELETED_LOAD_FAILED');
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
    if (!locales.includes(language)) {
      language = '';
      work = 'owed';
    }
  } else error = await responseMessage(res, 'ENTRY_LIST_LOAD_FAILED');
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
  const here = document.activeElement as HTMLElement | null;
  trigger = here?.closest('.row-menu')?.querySelector('button') ?? here ?? undefined;
  dialog = kind;
  target = entry;
  text = kind === 'new' ? '' : kind === 'duplicate' ? `${entry?.id ?? ''}-copy` : (entry?.id ?? '');
  withDrafts = false;
  error = undefined;
}
function startOffsite(action: 'hide' | 'delete', ids: string[]) {
  const here = document.activeElement as HTMLElement | null;
  trigger = here?.closest('.row-menu')?.querySelector('button') ?? here ?? undefined;
  menuFor = '';
  offsite = { action, ids };
}
const close = () => {
  dialog = '';
  offsite = undefined;
  putting = undefined;
  error = undefined;
};

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// A 409 or 503 is the server's own sentence and reads better than anything said here.
async function send(url: string, init: RequestInit) {
  busy = true;
  error = undefined;
  const res = await fetch(url, init);
  busy = false;
  if (res.ok) return res;
  error = await responseMessage(res, 'ENTRY_ACTION_FAILED');
  if (
    (res.status === 409 || res.status === 503) &&
    !error.detail &&
    error.code !== 'CONNECTION_LOST'
  ) {
    const detail = said(await res.text());
    if (detail) error = { ...error, detail };
  }
  return undefined;
}

// A refused restore names the files it is about in json; everything else answers in words.
const said = (body: string) =>
  body.startsWith('{') ? ((JSON.parse(body) as { error?: string }).error ?? body) : body;

// The same inverse commit as a revert; both lists move, so both are read again.
async function restore(row: Deleted) {
  const res = await send('/admin/api/restore', json({ commit_sha: row.commit_sha }));
  if (!res) return;
  close();
  await Promise.all([load(collection), loadDeleted(collection)]);
  onchanged();
  await announceCommit(res);
}

// The copy is a draft like a new entry, so it opens the same way with its own lock.
async function duplicate(event: Event) {
  event.preventDefault();
  const url = `/admin/api/entries/${collection}/${target?.id}/duplicate`;
  const res = await send(url, json({ to: text, ...(withDrafts ? { drafts: true } : {}) }));
  if (!res) return;
  const { slug } = (await res.json()) as { slug: string };
  invalidateEntryDirectory();
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
  await oncommitted?.();
}

async function rename(event: Event) {
  event.preventDefault();
  const url = `/admin/api/entries/${collection}/${target?.id}/rename`;
  const res = await send(url, json({ to: text }));
  if (!res) return;
  await done();
  await announceCommit(res);
}

// A delete commits now, so the redirect rules ride in that commit, not a later publish.
async function remove(id: string, redirect: Target) {
  const url = `/admin/api/entries/${collection}/${id}`;
  const res = await send(url, { ...json({ redirect }), method: 'DELETE' });
  if (!res) return;
  await done();
  await announceCommit(res);
}

async function announceCommit(res: Response) {
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { commit_sha?: unknown };
  if (typeof body.commit_sha === 'string' && body.commit_sha) await oncommitted?.();
}

// The list and the unpublished-changes count both moved; neither is this component's to keep.
async function done() {
  invalidateEntryDirectory();
  close();
  await load(collection);
  onchanged();
}
</script>

<svelte:window
  onkeydown={(e) => e.key === 'Escape' && menuFor && (menuFor = '')}
  onclick={(e) => menuFor && !(e.target as HTMLElement).closest('.row-menu') && (menuFor = '')}
/>

<main class="main collection-page">
  <div class="list-toolbar">
    <h1>{capitalise(plural)} <span class="count">{filtered ? m.entry_list_count_filtered({ shown: shown.length, total: entries.length }, options) : entries.length}</span></h1>
    <span class="spacer"></span>
    <button class="btn btn-primary" type="button" onclick={() => open('new')}>{m.entry_list_new({ collection: collectionLabel }, options)}</button>
  </div>
  <div class="tabs list-tabs" role="tablist" aria-label={m.entry_list_tabs_label({ collection: plural }, options)}>
    <button
      type="button"
      role="tab"
      aria-selected={tab === 'all'}
      onclick={() => (tab = 'all')}>{m.entry_list_all({}, options)}</button
    >
    <button
      type="button"
      role="tab"
      aria-selected={tab === 'deleted'}
      onclick={() => (tab = 'deleted')}>{m.entry_list_deleted({}, options)}</button
    >
  </div>
  {#if tab === 'all'}
    <div class="collection-controls">
      <div class="search-field">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
        <label class="visually-hidden" for="entry-search">{m.entry_list_search_label({ collection: plural }, options)}</label>
        <input class="input" id="entry-search" type="search" placeholder={m.entry_list_search_placeholder({ collection: plural }, options)} bind:value={search} />
      </div>
    <div class="filters">
      <label class="visually-hidden" for="list-status">{m.entry_list_status({}, options)}</label>
      <select class={['filter', { 'is-on': showing !== 'all' }]} id="list-status" bind:value={showing}>
        <option value="all">{m.entry_list_all({}, options)}</option>
        <option value="live">{m.entry_list_live({}, options)}</option>
        <option value="hidden">{m.entry_list_hidden({}, options)}</option>
      </select>
      {#if many}
        <label class="visually-hidden" for="list-locale">{m.entry_list_language({}, options)}</label>
        <select class={['filter', { 'is-on': language }]} id="list-locale" bind:value={language}>
          <option value="">{m.entry_list_every_language({}, options)}</option>
          {#each locales as locale (locale)}
            <option value={locale}>{formatLanguageName(locale, uiLocale)}</option>
          {/each}
        </select>
        <label class="visually-hidden" for="list-owed">{m.entry_list_work({}, options)}</label>
        <select class={['filter', { 'is-on': language && work !== 'owed' }]} id="list-owed" bind:value={work} disabled={!language}>
          <option value="owed">{m.entry_list_work_owed({}, options)}</option>
          <option value="missing">{m.entry_list_work_missing({}, options)}</option>
          <option value="unfinished">{m.entry_list_work_unfinished({}, options)}</option>
          <option value="stale">{m.entry_list_work_stale({}, options)}</option>
          <option value="machine">{m.entry_list_work_machine({}, options)}</option>
        </select>
      {/if}
    </div>
      {#if filtered}<button class="btn btn-ghost btn-sm" type="button" onclick={() => { search = ''; showing = 'all'; language = ''; work = 'owed'; }}>{m.entry_list_clear_filters({}, options)}</button>{/if}
    </div>
  {/if}
  {#if error && !dialog}<p class="notice notice-danger" role="alert">{textOf(error)}{#if error.detail}<span class="technical-detail">{messageDetail(error, uiLocale)}</span>{/if}</p>{/if}
  {#if tab === 'deleted'}
    <p class="list-note">{m.entry_list_deleted_note({ collection: plural }, options)}</p>
    {#if deletedLoading && !deleted.length}
      <p class="placeholder">{m.common_loading({}, options)}</p>
    {:else if deleted.length}
      <div class="table cols-4" role="table" aria-label={m.entry_list_deleted_table({ collection: plural }, options)}>
        <div class="row-head" role="row">
          <div class="th" role="columnheader">{m.entry_list_file_name({}, options)}</div>
          <div class="th" role="columnheader">{m.entry_list_what_went({}, options)}</div>
          <div class="th" role="columnheader">{m.entry_list_deleted_when({}, options)}</div>
          <div class="th" role="columnheader"><span class="visually-hidden">{m.entry_list_actions({}, options)}</span></div>
        </div>
        {#each deleted as row (row.id)}
          <div class="row" role="row">
            <div class="td title filename" role="cell">{row.slug}</div>
            <div class="td" role="cell" data-label={m.entry_list_what_went({}, options)}>
              {row.whole ? m.entry_list_whole_entry({ entry: collectionLabel }, options) : m.entry_list_one_language({}, options)}
              {#if row.locales.length}
                <span class="visually-hidden">{m.entry_list_languages({}, options)}</span>
                <span class="chips">
                  {#each row.locales as locale (locale)}
                    <span class="chip">{locale.toUpperCase()}</span>
                  {/each}
                </span>
              {/if}
            </div>
            <div class="td num" role="cell" data-label={m.entry_list_deleted_when({}, options)}>
              {row.by ?? m.entry_list_system({}, options)}
              <span class="sep" aria-hidden="true">·</span>
              {formatExactTime(row.at, uiLocale)}
            </div>
            <div class="td menu-cell" role="cell">
              <!-- aria-disabled so the button keeps focus and the reason is heard. -->
              <button
                class="btn btn-sm"
                type="button"
                aria-disabled={Boolean(row.blocked)}
                aria-describedby={row.blocked ? `why-${row.id}` : undefined}
                onclick={() => {
                  if (row.blocked) return;
                  trigger = document.activeElement as HTMLElement;
                  putting = row;
                }}
                >{m.entry_list_restore({}, options)}<span class="visually-hidden"> {row.slug}</span></button
              >
            </div>
          </div>
          {#if row.blocked}
            <div class="row row-note" role="row">
              <div class="td" role="cell">
                <p class="notice notice-warn" id="why-{row.id}">
                  {m.entry_list_restore_blocked({}, options)} <span class="technical-detail">{m.common_technical_detail({ detail: row.blocked }, options)}</span> {m.entry_list_restore_blocked_hint({}, options)}
                </p>
              </div>
            </div>
          {/if}
        {/each}
      </div>
    {:else}
      <div class="empty">
        <div>
          <h2>{m.entry_list_nothing_deleted({}, options)}</h2>
          <p>{m.entry_list_nothing_deleted_hint({ collection: plural }, options)}</p>
        </div>
      </div>
    {/if}
  {:else if loading}
    <p class="placeholder">{m.common_loading({}, options)}</p>
  {:else if entries.length && !shown.length}
    <p class="placeholder">
      {search.trim()
        ? m.entry_list_no_search_results({ search: search.trim() }, options)
        : language
        ? {
            owed: m.entry_list_language_complete,
            missing: m.entry_list_language_none_missing,
            stale: m.entry_list_language_none_stale,
            unfinished: m.entry_list_language_none_unfinished,
            machine: m.entry_list_language_none_machine,
          }[work]({ language: formatLanguageName(language, uiLocale) }, options)
        : showing === 'hidden'
          ? m.entry_list_no_hidden({ collection: plural }, options)
          : m.entry_list_no_live({ collection: plural }, options)}
    </p>
  {:else if entries.length}
    <!-- Without the languages column the grid is the five-column `has-select.cols-4`. -->
    <div class={['table has-select', { 'cols-4': !many }]} role="table" aria-label={capitalise(plural)}>
      <!-- role="table" needs a row around its columnheaders; display: contents keeps the grid. -->
      <div class="row-head" role="row">
        <div class="th" role="columnheader">
          <input
            type="checkbox"
            aria-label={m.entry_list_select_all({}, options)}
            checked={chosen.length === shown.length && shown.length > 0}
            onchange={(e) => (chosen = e.currentTarget.checked ? shown.map((x) => x.id) : [])}
          />
        </div>
        <div class="th" role="columnheader">{m.entry_list_title({}, options)}</div>
        {#if many}<div class="th" role="columnheader">{m.entry_list_languages_heading({}, options)}</div>{/if}
        <div class="th" role="columnheader">{m.entry_list_edited({}, options)}</div>
        <div class="th" role="columnheader">{m.entry_list_file_name({}, options)}</div>
        <div class="th" role="columnheader"><span class="visually-hidden">{m.entry_list_actions({}, options)}</span></div>
      </div>
      {#each shown as entry (entry.id)}
        <div class={['row', { 'is-selected': chosen.includes(entry.id) }]} role="row">
          <div class="td" role="cell">
            <input
              type="checkbox"
              aria-label={m.entry_list_select_title({ title: titleOf(entry) }, options)}
              checked={chosen.includes(entry.id)}
              onchange={(e) =>
                (chosen = e.currentTarget.checked
                  ? [...chosen, entry.id]
                  : chosen.filter((id) => id !== entry.id))}
            />
          </div>
          <div class="td title" role="cell">
            <a href={sitePath(`/admin/c/${collection}/${entry.id}${queueQuery(language || undefined, work)}`)}>{titleOf(entry)}</a>
            {#if isHidden(entry)}<span class="badge">{m.entry_list_hidden({}, options)}</span>{/if}
            {#if entry.editing}<span class="badge">{entry.editing.name ? m.entry_list_being_edited_by({ name: entry.editing.name }, options) : m.entry_list_being_edited({}, options)}</span>{/if}
          </div>
          {#if many}
            <div class="td" role="cell" data-label={m.entry_list_languages_heading({}, options)}>
              {#if compact}
                {@const words = summary(entry)}
                {@const owed = owedIn(entry)}
                {@const count = counted(entry)}
                <span class="visually-hidden">{m.entry_list_languages({}, options)} {words}</span>
                <span class="chips" aria-hidden="true" title={words}>
                  <span class="chip chip-count">{count.created}/{count.offered}</span>
                  {#each owed.slice(0, 3) as locale (locale)}
                    <span class={['chip', chipClass(entry, locale)]}>{locale.toUpperCase()}</span>
                  {/each}
                  {#if owed.length > 3}<span class="chip chip-count">+{owed.length - 3}</span>{/if}
                </span>
              {:else}
              <span class="visually-hidden">{m.entry_list_languages({}, options)}</span>
              <span class="chips">
                {#each locales as locale (locale)}
                  <span
                    class={['chip', offered(entry, locale) ? chipClass(entry, locale) : 'chip-disabled']}
                    title="{locale}: {chipTitle(entry, locale)}"
                  >{locale.toUpperCase()}</span>
                {/each}
              </span>
              {/if}
            </div>
          {/if}
          <div class="td edited" role="cell" data-label={m.entry_list_edited({}, options)}>
            {#if entry.edited}
              {@const relative = formatRelativeTime(entry.edited.at, uiLocale)}
              <time class="sub" datetime={new Date(entry.edited.at).toISOString()} title={formatExactTime(entry.edited.at, uiLocale)}>{entry.edited.kind === 'edit'
                ? entry.edited.by
                  ? m.entry_list_edited_by_when({ name: entry.edited.by, when: relative }, options)
                  : m.entry_list_edited_when({ when: relative }, options)
                : entry.edited.by
                  ? m.entry_list_published_by_when({ name: entry.edited.by, when: relative }, options)
                  : m.entry_list_published_when({ when: relative }, options)}</time>
            {/if}
          </div>
          <div class="td num filename" role="cell" data-label={m.entry_list_file_name({}, options)}>{entry.id}</div>
          <div class="td menu-cell" role="cell">
            <div class="row-menu">
              <button
                class="btn btn-ghost btn-sm"
                type="button"
                aria-expanded={menuFor === entry.id}
                aria-label={m.entry_list_actions_for({ title: titleOf(entry) }, options)}
                onclick={() => (menuFor = menuFor === entry.id ? '' : entry.id)}>⋯</button
              >
              {#if menuFor === entry.id}
                <div class="menu">
                  <button type="button" onclick={() => { menuFor = ''; open('duplicate', entry); }}>{m.entry_list_duplicate({}, options)}</button>
                  <button type="button" onclick={() => { menuFor = ''; open('rename', entry); }}>{m.entry_list_rename({}, options)}</button>
                  {#if role === 'owner'}
                    <button type="button" onclick={() => { menuFor = ''; open('template', entry); }}>{m.entry_list_save_template({}, options)}</button>
                  {/if}
                  <!-- Hide before Delete, so the gentler answer is the one reached first. -->
                  <button
                    type="button"
                    disabled={busy}
                    onclick={() => {
                      menuFor = '';
                      if (isHidden(entry)) status([entry.id], false);
                      else startOffsite('hide', [entry.id]);
                    }}>{isHidden(entry) ? m.entry_list_show({}, options) : m.entry_list_hide({}, options)}</button
                  >
                  <hr />
                  <button type="button" onclick={() => startOffsite('delete', [entry.id])}>{m.entry_list_delete({}, options)}</button>
                </div>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
    {#if chosen.length}
      <div class="bulk-bar" role="region" aria-label={m.entry_list_bulk_actions({}, options)}>
        {m.entry_list_selected({ count: chosen.length }, options)}
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" type="button" onclick={() => (chosen = [])}>{m.entry_list_clear_selection({}, options)}</button>
        <button
          class="btn btn-sm"
          type="button"
          disabled={busy}
          onclick={() => startOffsite('hide', chosen)}
        >
          {m.entry_list_hide_selected({ count: chosen.length, collection }, options)}
        </button>
      </div>
    {/if}
  {:else}
    <div class="empty">
      <div>
        <h2>{m.entry_list_empty({ collection: plural }, options)}</h2>
        <p>{m.entry_list_empty_hint({ collection: collectionLabel }, options)}</p>
        <button class="btn btn-primary" type="button" onclick={() => open('new')}>
          {m.entry_list_new({ collection: collectionLabel }, options)}
        </button>
      </div>
    </div>
  {/if}
</main>

{#if putting}
  {@const row = putting}
  <Modal labelledby="restore-h" returnTo={trigger} dismissible={!busy} onclose={close}>
      <h2 id="restore-h">{m.entry_list_restore_question({ name: row.slug }, options)}</h2>
      <p>{m.entry_list_restore_explanation({ date: formatExactTime(row.at, uiLocale) }, options)}</p>
      <ul class="publish-set">
        <li>
          {#if row.locales.length}
            <span class="chips" aria-hidden="true">
              {#each row.locales as locale (locale)}<span class="chip">{locale.toUpperCase()}</span
                >{/each}
            </span>
          {/if}
          {row.whole ? m.entry_list_restore_every_language({}, options) : m.entry_list_restore_one_language({}, options)}
        </li>
        <li>{m.entry_list_restore_redirect({}, options)}</li>
      </ul>
      <p class="hint">{m.entry_list_restore_pictures({}, options)}</p>
      {#if error}<div class="notice notice-danger" role="alert">{textOf(error)}{#if error.detail}<span class="technical-detail">{messageDetail(error, uiLocale)}</span>{/if}</div>{/if}
      <div class="actions">
        <button class="btn" type="button" disabled={busy} onclick={close}>{m.common_cancel({}, options)}</button>
        <button class="btn btn-primary" type="button" disabled={busy} onclick={() => restore(row)}>
          {busy ? m.entry_list_restoring({}, options) : m.entry_list_restore({}, options)}
        </button>
      </div>
  </Modal>
{/if}

{#if offsite}
  {@const ids = offsite.ids}
  {@const action = offsite.action}
  <OffsiteDialog
    {action}
    what={named(ids) ? titleOf(named(ids) as Entry) : `${ids.length} ${plural}`}
    many={ids.length > 1}
    {collection}
    {index}
    {busy}
    {uiLocale}
    error={dialogError}
    returnTo={trigger}
    onconfirm={(target) =>
      action === 'delete' ? remove(ids[0] ?? '', target) : status(ids, true, target)}
    onhide={() => (offsite = { action: 'hide', ids })}
    onclose={close}
  />
{/if}

{#if dialog === 'new'}
  <NewEntry {collection} {uiLocale} preferred={language || undefined} onclose={close} />
{:else if dialog}
  <Modal
    labelledby="entry-dialog-h"
    initialFocus="input.input"
    returnTo={trigger}
    dismissible={!busy}
    onclose={close}
  >
      {#if dialog === 'rename'}
        <h2 id="entry-dialog-h">{m.entry_list_rename_question({ title: titleOf(target as Entry) }, options)}</h2>
        <form onsubmit={rename}>
          <div class="field">
            <div class="label-row"><label for="rename-to">{m.entry_list_file_name({}, options)}</label></div>
            <input
              class="input filename"
              id="rename-to"
              type="text"
              bind:value={text}
              aria-describedby="rename-hint"
            />
            <p class="hint" id="rename-hint">{m.entry_list_saved_as({}, options)} <span class="filename">{preview}</span>. {m.entry_list_rename_hint({}, options)}</p>
          </div>
          {#if error}<div class="notice notice-danger" role="alert">{textOf(error)}{#if error.detail}<span class="technical-detail">{messageDetail(error, uiLocale)}</span>{/if}</div>{/if}
          <div class="actions">
            <button class="btn" type="button" disabled={busy} onclick={close}>{m.common_cancel({}, options)}</button>
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {busy ? m.entry_list_renaming({}, options) : m.entry_list_rename({}, options)}
            </button>
          </div>
        </form>
      {:else if dialog === 'template'}
        <h2 id="entry-dialog-h">{m.entry_list_template_question({ title: titleOf(target as Entry) }, options)}</h2>
        <form onsubmit={saveTemplate}>
          <div class="field">
            <div class="label-row"><label for="template-to">{m.entry_list_template_name({}, options)}</label></div>
            <input
              class="input filename"
              id="template-to"
              type="text"
              bind:value={text}
              aria-describedby="template-hint"
            />
            <p class="hint" id="template-hint">{m.entry_list_saved_as({}, options)} <span class="filename">{preview}</span>. {m.entry_list_template_hint({ collection: plural }, options)}</p>
          </div>
          {#if error}<div class="notice notice-danger" role="alert">{textOf(error)}{#if error.detail}<span class="technical-detail">{messageDetail(error, uiLocale)}</span>{/if}</div>{/if}
          <div class="actions">
            <button class="btn" type="button" disabled={busy} onclick={close}>{m.common_cancel({}, options)}</button>
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {busy ? m.entry_list_saving_template({}, options) : m.entry_list_save_template({}, options)}
            </button>
          </div>
        </form>
      {:else}
        <h2 id="entry-dialog-h">{m.entry_list_duplicate_question({ title: titleOf(target as Entry) }, options)}</h2>
        <form onsubmit={duplicate}>
          <div class="field">
            <div class="label-row"><label for="copy-to">{m.entry_list_file_name({}, options)}</label></div>
            <input
              class="input filename"
              id="copy-to"
              type="text"
              bind:value={text}
              aria-describedby="copy-hint"
            />
            <p class="hint" id="copy-hint">{m.entry_list_saved_as({}, options)} <span class="filename">{preview}</span>. {many ? m.entry_list_duplicate_hint_many({}, options) : m.entry_list_duplicate_hint_one({}, options)}</p>
          </div>
          {#if target?.pending}
            <label class="choice">
              <input type="checkbox" bind:checked={withDrafts} />
              {m.entry_list_duplicate_drafts({}, options)}
            </label>
          {/if}
          {#if error}<div class="notice notice-danger" role="alert">{textOf(error)}{#if error.detail}<span class="technical-detail">{messageDetail(error, uiLocale)}</span>{/if}</div>{/if}
          <div class="actions">
            <button class="btn" type="button" disabled={busy} onclick={close}>{m.common_cancel({}, options)}</button>
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {busy ? m.entry_list_duplicating({}, options) : m.entry_list_duplicate({}, options)}
            </button>
          </div>
        </form>
      {/if}
  </Modal>
{/if}
