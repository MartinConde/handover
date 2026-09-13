<script lang="ts">
import { unsafeLinkScheme } from '@handover/core';
import { type Pickable, type PickEntry, readEntryDirectory } from '../entry-directory.js';
import { messageText, type UiMessage } from '../errors.js';
import { formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
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

let all = $state<Pickable>({ entries: [], locales: [] });
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
const languageName = (locale: string) => formatLanguageName(locale, uiLocale);
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
      (e.title.toLowerCase().includes(query.toLowerCase().trim()) ||
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

const refused = $derived(typed ? unsafeLinkScheme('default', typed) : undefined);

// Arrow keys walk the rows and wrap; every row is a button, so Tab reaches them regardless.
function step(e: KeyboardEvent) {
  if (e.key === 'Escape') return onclose?.();
  if (e.target !== box && e.target !== e.currentTarget && !list?.contains(e.target as Node)) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = Array.from(list?.querySelectorAll('button') ?? []);
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
<div class="picker" class:is-library={library} role="group" aria-labelledby={labelId} onkeydown={step}>
  <label class="visually-hidden" for="{id}-q">{m.page_picker_search_label({ label: displayedLabel }, options)}</label>
  <input class="input" id="{id}-q" type="search" placeholder={m.page_picker_search_placeholder({}, options)} bind:value={query} bind:this={box} />
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
      <p class="group-name" id="{id}-g-{group.name}" role="presentation">{group.name}</p>
      {#each group.rows as row (row.path)}
        {@const no = why(row)}
        {@const says = no ?? note(row)}
        <!-- aria-disabled: a disabled button takes no focus, so the reason goes unheard. -->
        <button type="button" role={library ? undefined : 'option'} aria-label={library ? (included.includes(row.path) ? m.page_picker_add_again({ title: row.title }, options) : m.page_picker_add({ title: row.title }, options)) : undefined} aria-selected={library ? undefined : row.path === chosen ? 'true' : 'false'} aria-disabled={no || !directoryCurrent ? 'true' : undefined} aria-describedby={says && (!library || !row.index) ? `${id}-why-${row.path}` : undefined} onclick={() => directoryCurrent && !no && onpick(row)}>
          {#if library}
            <span class="library-entry">
              <span class="library-title">{row.title}</span>
              <span class="path">{row.path}</span>
              <span class="library-meta">
                {#if included.includes(row.path)}<span class="library-included">✓ {m.page_picker_in_menu({}, options)}</span>{/if}
                {#if row.index}<span>{m.page_picker_collection_page({}, options)}</span>{/if}
                {#each all.locales as of (of)}<span class="library-locale" class:is-missing={!row.locales.includes(of)} title={row.locales.includes(of) ? m.page_picker_available_in({ language: languageName(of) }, options) : m.page_picker_not_available_in({ language: languageName(of) }, options)}>{of.toUpperCase()}</span>{/each}
              </span>
            </span>
            <span class="library-add" aria-hidden="true">+</span>
          {:else}
          <span>{row.title}</span>
          <span class="chips">
            {#each all.locales as of (of)}
              <span class="chip" class:chip-missing={!row.locales.includes(of)} title={row.locales.includes(of) ? m.page_picker_available_in({ language: languageName(of) }, options) : m.page_picker_not_available_in({ language: languageName(of) }, options)}>{of.toUpperCase()}</span>
            {/each}
          </span>
          <span class="path">{locale ? (row.urls[locale] ?? row.path) : row.path}</span>
          {/if}
        </button>
        {#if says && (!library || !row.index)}<p class="why" id="{id}-why-{row.path}">{library && row.hidden && !no ? m.page_picker_hidden_library_note({}, options) : says}</p>{/if}
      {/each}
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
        <div class="label-row"><label for="{id}-url">{m.page_picker_address({}, options)}</label></div>
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
