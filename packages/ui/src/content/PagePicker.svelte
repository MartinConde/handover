<script lang="ts">
import { labelIn, unsafeLinkScheme } from '@handover/core';
import { type Pickable, type PickEntry, readEntryDirectory } from '../entry-directory.js';
import { messageText, type UiMessage } from '../errors.js';
import { collectionName, formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';

let {
  id,
  label,
  labelKind,
  labelId,
  collection,
  locale,
  indexes = false,
  chosen,
  library = false,
  included = [],
  uiLocale = 'en',
  onpick,
  onurl,
  onclose,
}: {
  /** The field's own id; the search box and every reason are named under it. */
  id: string;
  /** What is being chosen, for the search box nobody can see a label on. */
  label: string;
  /** Handover-owned wording; omitted for schema-authored labels that must stay verbatim. */
  labelKind?: 'pages-and-entries' | 'page-or-entry' | 'link-targets';
  /** The heading this list belongs to. */
  labelId: string;
  /** Only this collection's entries — a `reference` is locked to the one its schema names. */
  collection?: string;
  /** Asked for an address in this language: rows show its URL, and one without is refused. */
  locale?: string;
  /** Offer each collection's index page too, ahead of its entries: a menu can point at one. */
  indexes?: boolean;
  /** What the field holds now, so the list says which row that is. */
  chosen?: string;
  /** A persistent library offers repeatable add actions instead of a single selection. */
  library?: boolean;
  included?: string[];
  uiLocale?: UiLocale;
  onpick: (entry: PickEntry) => void;
  /** Given when a typed web address is an answer too; without it the list is the only way. */
  onurl?: (href: string) => void;
  /** Absent where the list is the pane itself: what stands open all the time has no Cancel. */
  onclose?: () => void;
} = $props();
const options = $derived(messageOptions(uiLocale));
const displayedLabel = $derived(
  labelKind === 'pages-and-entries'
    ? m.page_picker_label_pages_entries({}, options)
    : labelKind === 'page-or-entry'
      ? m.page_picker_label_page_entry({}, options)
      : labelKind === 'link-targets'
        ? m.page_picker_label_link_targets({}, options)
        : label,
);

let all = $state.raw<Pickable>({ entries: [], locales: [] });
let query = $state('');
let typed = $state('');
let list = $state<HTMLElement>();
let box = $state<HTMLInputElement>();
let directoryLoading = $state(true);
let directoryCurrent = $state(false);
let directoryError = $state<UiMessage>();

$effect(() => {
  if (!library) box?.focus();
  void loadDirectory();
});

async function loadDirectory() {
  directoryLoading = true;
  directoryError = undefined;
  try {
    all = await readEntryDirectory();
    directoryCurrent = true;
  } catch {
    directoryCurrent = false;
    directoryError = { code: 'PAGE_PICKER_LOAD_FAILED' };
  } finally {
    directoryLoading = false;
  }
}

// Why this entry is no answer: it has no address in the language being written.
const why = (entry: PickEntry) => {
  if (!locale || entry.urls[locale]) return undefined;
  return entry.locales.includes(locale)
    ? m.page_picker_no_rendered_address({}, options)
    : m.page_picker_no_language_page({ language: formatLanguageName(locale, uiLocale) }, options);
};
// A hidden page still takes the choice; it is a poor one, so it is said rather than refused.
const note = (entry: PickEntry) =>
  entry.index
    ? m.page_picker_collection_page_note({}, options)
    : entry.hidden
      ? m.page_picker_hidden_note({}, options)
      : undefined;
const directoryText = $derived(
  directoryError?.code === 'CONNECTION_LOST'
    ? messageText(directoryError, uiLocale)
    : labelKind
      ? m.page_picker_owned_load_failed({}, options)
      : m.page_picker_load_failed({ label }, options),
);

const matches = $derived(
  [...all.entries, ...(indexes ? (all.indexes ?? []) : [])].filter(
    (e) =>
      (!collection || e.collection === collection) &&
      (rowTitle(e).toLowerCase().includes(query.toLowerCase().trim()) ||
        e.title.toLowerCase().includes(query.toLowerCase().trim()) ||
        e.path.toLowerCase().includes(query.toLowerCase().trim())),
  ),
);
// Grouped under the collection's name, in the order the config declares them, its index first.
const groups = $derived(
  [...new Set(matches.map((e) => e.collection))].map((name) => ({
    name,
    rows: matches
      .filter((e) => e.collection === name)
      .sort((a, b) => Number(b.index ?? false) - Number(a.index ?? false)),
  })),
);

const rowTitle = (row: PickEntry) => labelIn(row.labels, uiLocale) ?? row.title;

// Library sections start closed; a search opens every section it matched until one is shut by hand.
let opened = $state<Record<string, boolean>>({});
let shut = $state<Record<string, boolean>>({});
const isOpen = (name: string) => (query.trim() ? !shut[name] : !!opened[name]);
function toggle(name: string) {
  if (query.trim()) shut[name] = !shut[name];
  else opened[name] = !opened[name];
}
/** The languages a page is limited to, when it is not in all of them. */
const onlyIn = (row: PickEntry) =>
  row.locales.length && row.locales.length < all.locales.length
    ? row.locales.map((of) => of.toUpperCase()).join(', ')
    : '';
const addLabel = (row: PickEntry) => {
  const again = included.includes(row.path);
  if (row.index) {
    const collection = rowTitle(row);
    return again
      ? m.page_picker_add_collection_page_again({ collection }, options)
      : m.page_picker_add_collection_page({ collection }, options);
  }
  return again
    ? m.page_picker_add_again({ title: rowTitle(row) }, options)
    : m.page_picker_add({ title: rowTitle(row) }, options);
};

const refused = $derived(typed ? unsafeLinkScheme('default', typed) : undefined);

// Arrow keys walk the rows and wrap; every row is a button, so Tab reaches them regardless.
function step(e: KeyboardEvent) {
  if (e.key === 'Escape') return onclose?.();
  if (e.target !== box && e.target !== e.currentTarget && !list?.contains(e.target as Node)) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = Array.from(
    list?.querySelectorAll<HTMLButtonElement>('button:not(.group-toggle)') ?? [],
  );
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const by = e.key === 'ArrowDown' ? 1 : -1;
  e.preventDefault();
  (at < 0
    ? rows[by > 0 ? 0 : rows.length - 1]
    : rows[(at + by + rows.length) % rows.length]
  )?.focus();
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- arrow keys move focus inside -->
<div class={['picker', { 'is-library': library }]} role="group" aria-labelledby={labelId} onkeydown={step}>
  <label class="visually-hidden" for="{id}-q">{m.page_picker_search_label({ label: displayedLabel }, options)}</label>
  <input class="input" id="{id}-q" type="search" placeholder={m.page_picker_search_placeholder({}, options)} bind:value={query} bind:this={box} oninput={() => (shut = {})} />
  {#if directoryError}
    <div class="notice notice-danger directory-read-error" role="alert">
      {directoryText}{all.entries.length ? ` ${m.page_picker_stale_choices({}, options)}` : ''}
      <button class="btn-link" type="button" onclick={loadDirectory}>{m.common_retry({}, options)}</button>
    </div>
  {/if}
  <div class="picker-list" bind:this={list} role={library ? 'group' : 'listbox'} aria-label={displayedLabel}>
    {#if directoryLoading && !all.entries.length}
      <p class="hint">{m.page_picker_loading({}, options)}</p>
    {:else}
    {#each groups as group (group.name)}
      <!-- Not a heading: the picker opens under a different outline level on every screen. -->
      <div role="group" aria-labelledby="{id}-g-{group.name}">
      {#if library}
        <button class="group-name group-toggle" id="{id}-g-{group.name}" type="button" aria-expanded={isOpen(group.name)} onclick={() => toggle(group.name)}>
          <span class="group-label">{collectionName(group.name, uiLocale)}</span>
          <span class="group-count">{group.rows.length}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      {:else}
      <p class="group-name" id="{id}-g-{group.name}" role="presentation">{collectionName(group.name, uiLocale)}</p>
      {/if}
      {#if !library || isOpen(group.name)}
      {#each group.rows as row (row.path)}
        {@const no = why(row)}
        {@const says = no ?? note(row)}
        <!-- aria-disabled: a disabled button takes no focus, so the reason goes unheard. -->
        <button type="button" data-path={library ? row.path : undefined} role={library ? undefined : 'option'} aria-label={library ? addLabel(row) : undefined} aria-selected={library ? undefined : row.path === chosen ? 'true' : 'false'} aria-disabled={no || !directoryCurrent ? 'true' : undefined} aria-describedby={says && (!library || !row.index) ? `${id}-why-${row.path}` : undefined} title={library ? undefined : locale ? (row.urls[locale] ?? row.path) : row.path} onclick={() => directoryCurrent && !no && onpick(row)}>
          {#if library}
            {@const only = onlyIn(row)}
            <span class="library-title">{row.index ? m.page_picker_collection_page({}, options) : rowTitle(row)}</span>
            {#if row.hidden && !row.index}<span class="library-tag is-warn">{m.menus_hidden({}, options)}</span>{/if}
            {#if only}<span class="library-tag library-only">{m.menus_language_only({ language: only }, options)}</span>{/if}
            {#if included.includes(row.path)}<span class="library-included" title={m.page_picker_in_menu({}, options)}>✓<span class="visually-hidden"> {m.page_picker_in_menu({}, options)}</span></span>{/if}
            <span class="library-add" aria-hidden="true">+</span>
          {:else}
          {@const only = onlyIn(row)}
          <span class="library-title">{rowTitle(row)}</span>
          {#if row.hidden && !row.index}<span class="library-tag is-warn">{m.menus_hidden({}, options)}</span>{/if}
          {#if only}<span class="library-tag library-only">{m.menus_language_only({ language: only }, options)}</span>{/if}
          {/if}
        </button>
        {#if says && (!library || !row.index)}<p class={['why', { 'visually-hidden': library || (!no && row.hidden && !row.index) }]} id="{id}-why-{row.path}">{library && row.hidden && !no ? m.page_picker_hidden_library_note({}, options) : says}</p>{/if}
      {/each}
      {/if}
      </div>
    {:else}
      {#if !directoryError}<p class="hint">{query ? m.page_picker_no_matches({ query }, options) : m.page_picker_empty({}, options)}</p>{/if}
    {/each}
    {/if}
  </div>
  {#if onurl}
    <div class="custom-link">
      <h3 class="side-title">{m.page_picker_custom_link({}, options)}</h3>
      <div class="field">
        <div class={['label-row', { 'visually-hidden': library }]}><label for="{id}-url">{m.page_picker_address({}, options)}</label></div>
        <input class="input" id="{id}-url" type="url" placeholder={m.page_picker_address_placeholder({}, options)} bind:value={typed} aria-invalid={refused ? 'true' : undefined} aria-describedby={refused ? `${id}-url-err` : undefined} />
        {#if refused}<p class="error" id="{id}-url-err">{m.page_picker_links_not_allowed({ scheme: refused }, options)}</p>{/if}
      </div>
    </div>
  {/if}
  {#if onclose || onurl}
    <div class="actions">
      {#if onclose}<button class="btn btn-sm" type="button" onclick={onclose}>{m.common_cancel({}, options)}</button>{/if}
      {#if onurl}
        <button class="btn btn-sm btn-primary" type="button" disabled={!typed.trim() || !!refused} onclick={() => { onurl?.(typed.trim()); if (library) typed = ''; }}>{library ? m.page_picker_add_custom_link({}, options) : m.page_picker_use_address({}, options)}</button>
      {/if}
    </div>
  {/if}
</div>
