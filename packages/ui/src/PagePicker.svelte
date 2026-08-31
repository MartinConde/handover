<script module lang="ts">
import { unsafeLinkScheme } from '@handover/core';

/** One thing an editor can point at, as `/admin/api/entries` answers it. */
export interface PickEntry {
  collection: string;
  /** `collection/name` — what a reference or an entry link stores. */
  path: string;
  title: string;
  /** The languages this entry has a file in. */
  locales: string[];
  /** Where each of them serves it; empty for a collection nothing renders. */
  urls: Record<string, string>;
  /** Off the site: still an answer, but a poor one, and the list says why. */
  hidden?: boolean;
}
export interface Pickable {
  entries: PickEntry[];
  /** The languages the site declares, in config order: what the chips are drawn for. */
  locales: string[];
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
let {
  id,
  label,
  labelId,
  collection,
  locale,
  chosen,
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
  /**
   * The caller wants an address rather than a pointer, in this language: rows show the URL
   * that language serves, and an entry with none there is refused with the reason.
   */
  locale?: string;
  /** What the field holds now, so the list says which row that is. */
  chosen?: string;
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
  box?.focus();
  readPickable().then((p) => (all = p));
});

// Why this entry is no answer for the caller: it has no address in the language being
// written, either because that language has no file or because nothing renders it at all.
const why = (entry: PickEntry) => {
  if (!locale || entry.urls[locale]) return undefined;
  return entry.locales.includes(locale)
    ? 'Nothing on the site renders this, so it has no address'
    : `There is no ${locale.toUpperCase()} page to link to`;
};
// And what is worth saying about a row that is still pickable. A hidden page has an address
// and would take the choice; it is just a poor one, so it is said rather than refused.
const note = (entry: PickEntry) =>
  entry.hidden ? 'Hidden itself — visitors would land on a page that isn’t there either' : undefined;

const matches = $derived(
  all.entries.filter(
    (e) =>
      (!collection || e.collection === collection) &&
      (e.title.toLowerCase().includes(query.toLowerCase().trim()) ||
        e.path.toLowerCase().includes(query.toLowerCase().trim())),
  ),
);
// Grouped under the collection's name, in the order the config declares them.
const groups = $derived(
  [...new Set(matches.map((e) => e.collection))].map((name) => ({
    name,
    rows: matches.filter((e) => e.collection === name),
  })),
);

const refused = $derived(typed ? unsafeLinkScheme('default', typed) : undefined);

// Arrow keys walk the rows from the search box down, and wrap; every row is a button, so
// Tab reaches them all whether or not this runs.
function step(e: KeyboardEvent) {
  if (e.key === 'Escape') return onclose?.();
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = Array.from(list?.querySelectorAll('button') ?? []);
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const by = e.key === 'ArrowDown' ? 1 : -1;
  e.preventDefault();
  (at < 0 ? rows[by > 0 ? 0 : rows.length - 1] : rows[(at + by + rows.length) % rows.length])?.focus();
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- the keys move focus between the controls inside -->
<div class="picker" role="group" aria-labelledby={labelId} onkeydown={step}>
  <label class="visually-hidden" for="{id}-q">Search {label}</label>
  <input class="input" id="{id}-q" type="search" placeholder="Search pages and entries" bind:value={query} bind:this={box} />
  <div class="picker-list" bind:this={list}>
    {#each groups as group (group.name)}
      <!-- The collection's name is what the rows under it have in common, not a step in the
           page's outline: a heading here reads as one level below whatever opened the picker,
           and the picker opens under a different level on every screen. -->
      <p class="group-name">{group.name}</p>
      {#each group.rows as row (row.path)}
        {@const no = why(row)}
        {@const says = no ?? note(row)}
        <!-- Refused with aria-disabled rather than disabled: a disabled button takes no focus,
             so a keyboard would walk past the row and never hear the reason. -->
        <button type="button" aria-current={row.path === chosen ? 'true' : undefined} aria-disabled={no ? 'true' : undefined} aria-describedby={says ? `${id}-why-${row.path}` : undefined} onclick={() => !no && onpick(row)}>
          <span>{row.title}</span>
          <span class="chips">
            {#each all.locales as of (of)}
              <span class="chip" class:chip-missing={!row.locales.includes(of)}>{of.toUpperCase()}</span>
            {/each}
          </span>
          <span class="path">{locale ? (row.urls[locale] ?? row.path) : row.path}</span>
        </button>
        {#if says}<p class="why" id="{id}-why-{row.path}">{says}</p>{/if}
      {/each}
    {:else}
      <p class="hint">{query ? `Nothing here matches “${query}”` : 'Nothing to choose from yet'}</p>
    {/each}
  </div>
  {#if onurl}
    <div class="field">
      <div class="label-row"><label for="{id}-url">Or a web address</label></div>
      <input class="input" id="{id}-url" type="url" placeholder="https://example.com" bind:value={typed} aria-invalid={refused ? 'true' : undefined} aria-describedby={refused ? `${id}-url-err` : undefined} />
      {#if refused}<p class="error" id="{id}-url-err">{refused}: links are not allowed</p>{/if}
    </div>
  {/if}
  {#if onclose || onurl}
    <div class="actions">
      {#if onclose}<button class="btn btn-sm" type="button" onclick={onclose}>Cancel</button>{/if}
      {#if onurl}
        <button class="btn btn-sm btn-primary" type="button" disabled={!typed || !!refused} onclick={() => onurl?.(typed)}>Use this address</button>
      {/if}
    </div>
  {/if}
</div>
