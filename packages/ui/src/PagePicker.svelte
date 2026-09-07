<script module lang="ts">
import { unsafeLinkScheme } from '@handover/core';

/** One thing an editor can point at, as `/admin/api/entries` answers it. */
export interface PickEntry {
  collection: string;
  /** `collection/name` — what a reference or an entry link stores. */
  path: string;
  title: string;
  /** Each available language's title, for localized navigation label placeholders. */
  titles?: Record<string, string>;
  /** Hidden status per language; older responses only carry the aggregate `hidden`. */
  hiddenLocales?: string[];
  /** The languages this entry has a file in. */
  locales: string[];
  /** Where each of them serves it; empty for a collection nothing renders. */
  urls: Record<string, string>;
  /** Off the site: still an answer, but a poor one, and the list says why. */
  hidden?: boolean;
  /** A collection's index page rather than an entry; `path` is then the collection alone. */
  index?: true;
}
export interface Pickable {
  entries: PickEntry[];
  /** The collections with an index page, and where each language serves it. */
  indexes?: PickEntry[];
  /** The languages the site declares, in config order: what the chips are drawn for. */
  locales: string[];
  /** The one whose URLs carry no segment of their own, unless the site asked for one. */
  defaultLocale?: string;
}

const NOTHING: Pickable = { entries: [], locales: [] };

/** The list, or an empty one: a picker that cannot reach the site says so by having nothing. */
export async function readPickable(): Promise<Pickable> {
  try {
    const res = await fetch('/admin/api/entries');
    return res.ok ? ((await res.json()) as Pickable) : NOTHING;
  } catch {
    return NOTHING;
  }
}
</script>

<script lang="ts">
import { request as fetch } from './request.js';

let {
  id,
  label,
  labelId,
  collection,
  locale,
  indexes = false,
  chosen,
  library = false,
  included = [],
  onpick,
  onurl,
  onclose,
}: {
  /** The field's own id; the search box and every reason are named under it. */
  id: string;
  /** What is being chosen, for the search box nobody can see a label on. */
  label: string;
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
  onpick: (entry: PickEntry) => void;
  /** Given when a typed web address is an answer too; without it the list is the only way. */
  onurl?: (href: string) => void;
  /** Absent where the list is the pane itself: what stands open all the time has no Cancel. */
  onclose?: () => void;
} = $props();

let all = $state<Pickable>({ entries: [], locales: [] });
let query = $state('');
let typed = $state('');
let list = $state<HTMLElement>();
let box = $state<HTMLInputElement>();

$effect(() => {
  if (!library) box?.focus();
  readPickable().then((p) => (all = p));
});

// Why this entry is no answer: it has no address in the language being written.
const why = (entry: PickEntry) => {
  if (!locale || entry.urls[locale]) return undefined;
  return entry.locales.includes(locale)
    ? 'Nothing on the site renders this, so it has no address'
    : `There is no ${locale.toUpperCase()} page to link to`;
};
// A hidden page still takes the choice; it is a poor one, so it is said rather than refused.
const note = (entry: PickEntry) =>
  entry.index
    ? 'The page that lists them all'
    : entry.hidden
      ? 'Hidden itself — visitors would land on a page that isn’t there either'
      : undefined;

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
  (at < 0 ? rows[by > 0 ? 0 : rows.length - 1] : rows[(at + by + rows.length) % rows.length])?.focus();
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- arrow keys move focus inside -->
<div class="picker" class:is-library={library} role="group" aria-labelledby={labelId} onkeydown={step}>
  <label class="visually-hidden" for="{id}-q">Search {label}</label>
  <input class="input" id="{id}-q" type="search" placeholder="Search pages and entries" bind:value={query} bind:this={box} />
  <div class="picker-list" bind:this={list} role={library ? 'group' : 'listbox'} aria-label={label}>
    {#each groups as group (group.name)}
      <!-- Not a heading: the picker opens under a different outline level on every screen. -->
      <div role="group" aria-labelledby="{id}-g-{group.name}">
      <p class="group-name" id="{id}-g-{group.name}" role="presentation">{group.name}</p>
      {#each group.rows as row (row.path)}
        {@const no = why(row)}
        {@const says = no ?? note(row)}
        <!-- aria-disabled: a disabled button takes no focus, so the reason goes unheard. -->
        <button type="button" role={library ? undefined : 'option'} aria-label={library ? `Add ${row.title}${included.includes(row.path) ? ' again' : ''}` : undefined} aria-selected={library ? undefined : row.path === chosen ? 'true' : 'false'} aria-disabled={no ? 'true' : undefined} aria-describedby={says && (!library || !row.index) ? `${id}-why-${row.path}` : undefined} onclick={() => !no && onpick(row)}>
          {#if library}
            <span class="library-entry">
              <span class="library-title">{row.title}</span>
              <span class="path">{row.path}</span>
              <span class="library-meta">
                {#if included.includes(row.path)}<span class="library-included">✓ In menu</span>{/if}
                {#if row.index}<span>Collection page</span>{/if}
                {#each all.locales as of (of)}<span class="library-locale" class:is-missing={!row.locales.includes(of)} title={row.locales.includes(of) ? `Available in ${of.toUpperCase()}` : `Not available in ${of.toUpperCase()}`}>{of.toUpperCase()}</span>{/each}
              </span>
            </span>
            <span class="library-add" aria-hidden="true">+</span>
          {:else}
          <span>{row.title}</span>
          <span class="chips">
            {#each all.locales as of (of)}
              <span class="chip" class:chip-missing={!row.locales.includes(of)}>{of.toUpperCase()}</span>
            {/each}
          </span>
          <span class="path">{locale ? (row.urls[locale] ?? row.path) : row.path}</span>
          {/if}
        </button>
        {#if says && (!library || !row.index)}<p class="why" id="{id}-why-{row.path}">{library && row.hidden && !no ? 'Hidden page — visitors won’t see this item.' : says}</p>{/if}
      {/each}
      </div>
    {:else}
      <p class="hint">{query ? `Nothing here matches “${query}”` : 'Nothing to choose from yet'}</p>
    {/each}
  </div>
  {#if onurl}
    <div class="custom-link">
      <h3 class="side-title">Custom link</h3>
      <div class="field">
        <div class="label-row"><label for="{id}-url">Address</label></div>
        <input class="input" id="{id}-url" type="url" placeholder="/contact or https://…" bind:value={typed} aria-invalid={refused ? 'true' : undefined} aria-describedby={refused ? `${id}-url-err` : undefined} />
        {#if refused}<p class="error" id="{id}-url-err">{refused}: links are not allowed</p>{/if}
      </div>
    </div>
  {/if}
  {#if onclose || onurl}
    <div class="actions">
      {#if onclose}<button class="btn btn-sm" type="button" onclick={onclose}>Cancel</button>{/if}
      {#if onurl}
        <button class="btn btn-sm btn-primary" type="button" disabled={!typed.trim() || !!refused} onclick={() => { onurl?.(typed.trim()); if (library) typed = ''; }}>{library ? 'Add custom link' : 'Use this address'}</button>
      {/if}
    </div>
  {/if}
</div>
