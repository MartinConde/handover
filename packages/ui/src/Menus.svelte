<script module lang="ts">
/** One item of the `navigation` global, as the format stores it. */
export interface MenuItem {
  _id: string;
  /** The languages this item is shown in; absent is all of them. */
  _locales?: string[];
  label: string;
  link:
    | { type: 'url'; href: string }
    | { type: 'entry' | 'page'; ref: string }
    | { type: 'index'; collection: string };
  newTab?: boolean;
  children?: MenuItem[];
}
export interface Menu {
  _id: string;
  key: string;
  items: MenuItem[];
}

/** How deep a menu may go. The format is recursive; the cap is this editor's. */
const MAX_DEPTH = 3;

/** How many levels the item itself is, so indenting cannot push its children past the cap. */
function heightOf(item: MenuItem): number {
  return 1 + Math.max(0, ...(item.children ?? []).map(heightOf));
}
</script>

<script lang="ts">
import { type DragDropEventHandlers, DragDropProvider, DragOverlay } from '@dnd-kit/svelte';
import { createSortable } from '@dnd-kit/svelte/sortable';
import { newId } from '@handover/core';
import { tick } from 'svelte';
import PagePicker, { type Pickable, type PickEntry, readPickable } from './PagePicker.svelte';

let {
  id,
  labelId,
  menus,
  locale = '',
  translating = false,
  sourceLabel = '',
}: {
  /** The field's own id; every control on the screen is named under it. */
  id: string;
  /** The heading the whole builder belongs to. */
  labelId: string;
  /** The global's menus, edited in place. A developer declares them; the client fills them. */
  menus: Menu[];
  /** The language this column writes: which address a row shows, and what is missing where. */
  locale?: string;
  /** A second language's column: the tree is read, and its labels are what can be typed. */
  translating?: boolean;
  /** The source language's display name, supplied by the translation pane. */
  sourceLabel?: string;
} = $props();

let tab = $state(0);
/** The item whose editor is open under its row, by `_id`. */
let editing = $state('');
/** What that item was when the editor opened, so Cancel puts it back. */
let before: MenuItem | undefined;
/** The item waiting to be confirmed away, and the button to give focus back to. */
let removing = $state<MenuItem>();
let trigger: HTMLElement | undefined;
/** The editor's picker is open over the link summary. */
let changing = $state(false);
/** The row whose ⋯ is open, by `_id`. A disclosure and not `role="menu"`, as on the entry list. */
let menuFor = $state('');
/** Feedback stays beside the library, so adding several pages never loses your place. */
let addedMessage = $state('');
let lastAdded = $state('');

const menu = $derived(menus[tab]);
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// The pages and entries an item can point at, for the picker and for saying what a row
// already points at — the same read the link field makes.
let known = $state<Pickable>({ entries: [], locales: [] });
$effect(() => {
  readPickable().then((p) => (known = p));
});
const language = $derived(locale || known.locales[0] || '');
const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
const languageName = (of: string) => {
  try { return languageNames.of(of) ?? of.toUpperCase(); }
  catch { return of.toUpperCase(); }
};

/** What a link names in the picker's list: the entry's path, the collection of an index. */
const keyOf = (link: MenuItem['link']) =>
  link.type === 'url' ? '' : link.type === 'index' ? link.collection : link.ref;
const entryOf = (item: MenuItem) => {
  const link = item.link;
  if (link.type === 'url') return undefined;
  const rows = link.type === 'index' ? (known.indexes ?? []) : known.entries;
  return rows.find((e) => e.path === keyOf(link));
};
/** What the row is called when nobody has typed a label: the page's own title. */
const fallback = (item: MenuItem) =>
  item.link.type === 'url' ? item.link.href : (entryOf(item)?.titles?.[language] ?? entryOf(item)?.title ?? keyOf(item.link));
const name = (item: MenuItem) => item.label || fallback(item);
/** Where it goes in this language, which is what the client recognises the page by. */
const target = (item: MenuItem) =>
  item.link.type === 'url' ? item.link.href : (entryOf(item)?.urls[language] ?? keyOf(item.link));
/** The quiet word after the name: what kind of thing the row points at. */
const kind = (item: MenuItem) => {
  const link = item.link;
  if (link.type === 'url') return 'Custom link';
  if (link.type === 'index') return `${capitalise(link.collection)} index`;
  return capitalise(entryOf(item)?.collection ?? link.ref.split('/')[0] ?? '');
};
// Why the site will skip this row: a word on the row, the sentence in its editor. The renderer
// drops it either way; the editor is where somebody can see that it is going to and tidy the menu.
const flag = (item: MenuItem): { chip: string; why: string } | undefined => {
  if (item.link.type === 'url') return undefined;
  const entry = entryOf(item);
  if (!entry) return { chip: 'Page missing', why: 'That page is gone — the site skips this item' };
  if (item.link.type === 'index') return undefined;
  if (entry.hiddenLocales?.includes(language) ?? entry.hidden) return { chip: 'Hidden', why: 'Hidden — the site skips this item' };
  if (language && !entry.locales.includes(language)) {
    const lang = language.toUpperCase();
    return { chip: `Not in ${lang}`, why: `Not available in ${lang} — the site skips this item here` };
  }
  return undefined;
};

/** The list an item at this path is a row of. */
const listAt = (path: number[]): MenuItem[] =>
  path.reduce<MenuItem[]>((list, i) => list[i]?.children ?? [], menu?.items ?? []);
function move(list: MenuItem[], from: number, to: number) {
  list.splice(to, 0, ...list.splice(from, 1));
}
function step(path: number[], by: -1 | 1) {
  const list = listAt(path.slice(0, -1));
  const i = path[path.length - 1] as number;
  if (i + by >= 0 && i + by < list.length) move(list, i, i + by);
}
// Indenting makes the row a child of the one above it, which is where a sub-menu comes from.
// It is refused where the row's own children would land past the cap rather than silently
// flattening them.
const canIndent = (item: MenuItem, path: number[]) =>
  (path[path.length - 1] as number) > 0 && path.length + heightOf(item) <= MAX_DEPTH;
function indent(item: MenuItem, path: number[]) {
  if (!canIndent(item, path)) return;
  const list = listAt(path.slice(0, -1));
  const i = path[path.length - 1] as number;
  const parent = list[i - 1] as MenuItem;
  // Read back after the assignment: what `??=` hands on is the bare array, and a row pushed
  // into that one is pushed into nothing — the state's own copy is the proxy behind the key.
  if (!parent.children) parent.children = [];
  parent.children.push(...list.splice(i, 1));
}
function outdent(path: number[]) {
  if (path.length < 2) return;
  const list = listAt(path.slice(0, -1));
  const up = listAt(path.slice(0, -2));
  const at = path[path.length - 2] as number;
  up.splice(at + 1, 0, ...list.splice(path[path.length - 1] as number, 1));
  prune(path.slice(0, -1));
}
// An item with nothing under it holds no `children` at all: an empty list is a key in the file
// that says nothing, and it would show up in every diff of the menu it was taken out of.
function prune(path: number[]) {
  if (!path.length) return;
  const parent = listAt(path.slice(0, -1))[path[path.length - 1] as number];
  if (parent?.children && !parent.children.length) delete parent.children;
}
function remove(item: MenuItem, path: number[]) {
  if (item.children?.length) {
    removing = item;
    return;
  }
  drop(path);
}
function drop(path: number[]) {
  listAt(path.slice(0, -1)).splice(path[path.length - 1] as number, 1);
  prune(path.slice(0, -1));
  if (removing) {
    removing = undefined;
    trigger?.focus();
  }
}
// A row's ⋯ closes on the choice; what was chosen runs, and focus comes back to the ⋯ if the
// row is still there to hold it.
function act(item: MenuItem, what: () => void) {
  menuFor = '';
  trigger = document.getElementById(`${id}-more-${item._id}`) ?? undefined;
  what();
  tick().then(() => trigger?.isConnected && trigger.focus());
}
/** Where the item waiting to be confirmed away sits now — it can be moved from under a dialog. */
const pathOf = (item: MenuItem, list = menu?.items ?? [], at: number[] = []): number[] => {
  for (const [i, row] of list.entries()) {
    if (row === item) return [...at, i];
    const found = row.children?.length ? pathOf(item, row.children, [...at, i]) : [];
    if (found.length) return found;
  }
  return [];
};

// A picked page keeps no label of its own: renaming the page then moves the menu with it, and
// typing over the greyed title is what writes one.
const linkTo = (entry: PickEntry): MenuItem['link'] =>
  entry.index
    ? { type: 'index', collection: entry.collection }
    : { type: 'entry', ref: entry.path };
function addEntry(entry: PickEntry) {
  const item = { _id: newId('default'), label: '', link: linkTo(entry) };
  menu?.items.push(item);
  lastAdded = item._id;
  addedMessage = `${entry.title} added to ${capitalise(menu?.key ?? '')}.`;
}
// An address has no title to fall back on, so the row opens straight away for its label.
async function addUrl(href: string) {
  const item: MenuItem = { _id: newId('default'), label: '', link: { type: 'url', href } };
  menu?.items.push(item);
  lastAdded = item._id;
  addedMessage = 'Custom link added. Give it a label in the menu.';
  edit(item);
  await tick();
  document.getElementById(`${id}-ed-label`)?.focus();
}

function edit(item: MenuItem) {
  before = $state.snapshot(item) as MenuItem;
  editing = item._id;
  changing = false;
}
function cancelEdit(item: MenuItem | undefined) {
  if (item && before) {
    for (const key of Object.keys(item)) if (!(key in before)) delete item[key as keyof MenuItem];
    Object.assign(item, before);
  }
  closeEditor();
}
function closeEditor() {
  const key = editing;
  editing = '';
  document.getElementById(`${id}-row-${key}`)?.focus();
}
const found = $derived(editing ? find(menu?.items ?? [], editing) : undefined);
function find(list: MenuItem[], key: string): MenuItem | undefined {
  for (const item of list) {
    if (item._id === key) return item;
    const inner = item.children ? find(item.children, key) : undefined;
    if (inner) return inner;
  }
  return undefined;
}
/** `_locales` as a question about visitors: everywhere, or this one language. */
const shownIn = (item: MenuItem) =>
  item._locales?.length === 1 ? (item._locales[0] as string) : '';
function showIn(item: MenuItem, only: string) {
  if (only) item._locales = [only];
  else delete item._locales;
}

type Handlers = Required<DragDropEventHandlers>;
type Manager = Parameters<Handlers['onDragOver']>[1];
/** How far sideways a drag must travel to mean one level deeper: the branch indent. */
const INDENT = 36;
interface Slot {
  kind: 'line' | 'into' | 'blocked';
  /** Where the indicator is drawn: the list it sits in and the row it follows. */
  list: MenuItem[];
  after?: MenuItem;
  deeper: boolean;
  /** What a drop would do: into this parent (the root when absent), after this sibling. */
  parent?: MenuItem;
  sib?: MenuItem;
}
let mark = $state<Slot>();
/** Levels asked for with → and ← during a keyboard drag, on top of the pointer's travel. */
let shift = 0;

interface Row {
  item: MenuItem;
  depth: number;
  parent?: Row;
}
function rowsOf(list: MenuItem[], skip?: MenuItem, depth = 1, parent?: Row): Row[] {
  const rows: Row[] = [];
  for (const item of list) {
    if (item === skip) continue;
    const row: Row = { item, depth, parent };
    rows.push(row, ...rowsOf(item.children ?? [], skip, depth + 1, row));
  }
  return rows;
}
const flatItems = $derived(rowsOf(menu?.items ?? []).map((row) => row.item));
const included = $derived(flatItems.map((item) => keyOf(item.link)).filter(Boolean));

// Nothing moves while a drag is live — the mockup's model, not 4.1's: the slot the row would
// land in is drawn where the pointer is, and the drop is the one move. The gap is the target
// row's upper or lower half; the depth within the gap is the drag's sideways travel, clamped
// to what the rows around the gap allow — except past the cap, where the refusal is the answer.
function place(manager: Manager, to?: { x: number; y: number }) {
  mark = undefined;
  const op = manager.dragOperation;
  const items = menu?.items ?? [];
  const src = op.source ? find(items, String(op.source.id)) : undefined;
  const at = op.target?.element ? find(items, String(op.target.id)) : undefined;
  if (!src || !at || at === src) return;
  const all = rowsOf(items);
  const srcRow = all.find((row) => row.item === src);
  const atRow = all.find((row) => row.item === at);
  if (!srcRow || !atRow) return;
  for (let up = atRow.parent; up; up = up.parent) if (up.item === src) return;
  const rect = op.target?.element?.getBoundingClientRect();
  if (!rect) return;
  // A dragmove is announced before its coordinates land, so the event's own point wins.
  const point = to ?? op.position.current;
  const after =
    op.activatorEvent instanceof KeyboardEvent
      ? all.indexOf(atRow) > all.indexOf(srcRow)
      : point.y >= rect.top + rect.height / 2;
  const flat = rowsOf(items, src);
  const gap = flat.findIndex((row) => row.item === at) + (after ? 1 : 0);
  const above = flat[gap - 1];
  const below = flat[gap];
  const most = above ? above.depth + 1 : 1;
  const least = below ? below.depth : 1;
  const dx = point.x - (op.position.current.x - op.position.delta.x);
  const wanted = srcRow.depth + Math.round(dx / INDENT) + shift;
  const depth = Math.min(Math.max(wanted, least), most);
  let sibRow: Row | undefined;
  let parentRow: Row | undefined;
  if (above && depth > above.depth) {
    parentRow = above;
  } else if (above) {
    sibRow = above;
    while (sibRow && sibRow.depth > depth) sibRow = sibRow.parent;
    parentRow = sibRow?.parent;
  }
  // Its own place is not a move.
  const path = pathOf(src);
  const own = listAt(path.slice(0, -1));
  const prev = own[(path[path.length - 1] as number) - 1];
  if (parentRow?.item === srcRow.parent?.item && sibRow?.item === prev) return;
  const kind =
    depth + heightOf(src) - 1 > MAX_DEPTH ? 'blocked' : depth === least ? 'line' : 'into';
  let list = items;
  let anchor: MenuItem | undefined;
  let deeper = false;
  if (above && parentRow === above) {
    const kids = (above.item.children ?? []).filter((child) => child !== src);
    if (kids.length && above.item.children) {
      list = above.item.children;
    } else {
      list = above.parent?.item.children ?? items;
      anchor = above.item;
      deeper = true;
    }
  } else if (sibRow) {
    list = sibRow.parent?.item.children ?? items;
    anchor = sibRow.item;
  }
  mark = { kind, list, after: anchor, deeper, parent: parentRow?.item, sib: sibRow?.item };
}

function begun() {
  shift = 0;
  mark = undefined;
}
function moved(event: Parameters<Handlers['onDragMove']>[0], manager: Manager) {
  if (event.by?.x && event.nativeEvent instanceof KeyboardEvent) {
    // → and ← on a keyboard drag ask for a level, not a sideways pixel move.
    event.preventDefault();
    shift += Math.sign(event.by.x);
    place(manager);
    return;
  }
  const { current } = manager.dragOperation.position;
  const to =
    event.to ?? (event.by ? { x: current.x + event.by.x, y: current.y + event.by.y } : undefined);
  place(manager, to);
}
// A canceled drag has nothing to put back — the tree never moved. A drop is the one move:
// out of the old list, into the marked slot, children carried along.
function ended(event: Parameters<Handlers['onDragEnd']>[0]) {
  const slot = mark;
  mark = undefined;
  shift = 0;
  const { source } = event.operation;
  if (event.canceled || !slot || slot.kind === 'blocked' || !source) return;
  const item = find(menu?.items ?? [], String(source.id));
  if (!item) return;
  const path = pathOf(item);
  listAt(path.slice(0, -1)).splice(path[path.length - 1] as number, 1);
  prune(path.slice(0, -1));
  let into = menu?.items ?? [];
  if (slot.parent) {
    if (!slot.parent.children) slot.parent.children = [];
    into = slot.parent.children;
  }
  into.splice(slot.sib ? into.indexOf(slot.sib) + 1 : 0, 0, item);
}
const sortable = (key: () => string, index: () => number) =>
  createSortable({
    get id() {
      return key();
    },
    get index() {
      return index();
    },
  });

// Roving tabindex, as tabs are: the strip is one stop and the arrows walk it.
function walkTabs(event: KeyboardEvent) {
  const by = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!by) return;
  event.preventDefault();
  tab = (tab + by + menus.length) % menus.length;
  editing = '';
  addedMessage = '';
  (event.currentTarget as HTMLElement).parentElement?.querySelectorAll('button')[tab]?.focus();
}
</script>

{#snippet branch(list: MenuItem[], path: number[])}
  <ul class="branch">
    {#if mark && mark.list === list && !mark.after}{@render indicator()}{/if}
    {#each list as item, i (item._id)}
      {@const here = [...path, i]}
      {@const says = flag(item)}
      {@const open = editing === item._id}
      {@const s = sortable(() => item._id, () => i)}
      <li>
        <div class="menu-item" class:is-lifted={s.isDragging} class:is-open={open} class:is-added={lastAdded === item._id} {@attach s.attach}>
          <button class="grip" type="button" aria-label="Reorder {name(item)} — press space, then the arrow keys" {@attach s.attachHandle}>⠿</button>
          <button class="row-open" id="{id}-row-{item._id}" type="button" aria-expanded={open} onclick={() => (open ? (editing = '') : edit(item))}>
            <span class="row-copy">
              <span class="lbl" class:is-default={!item.label}>{name(item)}</span>
              <span class="row-detail"><span class="kind">{kind(item)}</span><span class="row-path">{target(item)}</span></span>
            </span>
            <span class="row-status">
            {#if item._locales?.length === 1}<span class="badge badge-info">{(item._locales[0] ?? '').toUpperCase()} only</span>{/if}
            {#if says}<span class="badge badge-warn" title={says.why}>{says.chip}</span>{/if}
            </span>
            <span class="row-edit">{open ? 'Close' : 'Edit'}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d={open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg></span>
          </button>
          <div class="item-actions row-menu">
            <button class="btn btn-ghost btn-icon btn-sm" id="{id}-more-{item._id}" type="button" aria-expanded={menuFor === item._id} aria-label="Actions for {name(item)}" onclick={() => (menuFor = menuFor === item._id ? '' : item._id)}>⋯</button>
            {#if menuFor === item._id}
              <div class="menu">
                <button type="button" disabled={i === 0} aria-label="Move {name(item)} up" onclick={() => act(item, () => step(here, -1))}>Move up</button>
                <button type="button" disabled={i === list.length - 1} aria-label="Move {name(item)} down" onclick={() => act(item, () => step(here, 1))}>Move down</button>
                <button type="button" disabled={!canIndent(item, here)} aria-label="Indent {name(item)} — make it a sub-item" onclick={() => act(item, () => indent(item, here))}>Make a sub-item</button>
                <button type="button" disabled={path.length === 0} aria-label="Outdent {name(item)}" onclick={() => act(item, () => outdent(here))}>Move out a level</button>
                <hr />
                <button type="button" aria-label="Remove {name(item)}" onclick={() => act(item, () => remove(item, here))}>Remove</button>
              </div>
            {/if}
          </div>
        </div>
        {#if open && found}{@render editor(found, says)}{/if}
        {#if item.children?.length}
          {@render branch(item.children, here)}
        {/if}
      </li>
      {#if mark && mark.list === list && mark.after === item}{@render indicator()}{/if}
    {/each}
  </ul>
{/snippet}

<!-- Under its row rather than over the tree: the row it edits stays in sight, and so do the
     rows around it. -->
{#snippet editor(row: MenuItem, says: { chip: string; why: string } | undefined)}
  <div class="item-editor" role="group" aria-label="Edit {name(row)}">
    {#if says}<p class="notice notice-warn">{says.why}</p>{/if}
    <div class="field">
      <div class="label-row"><label for="{id}-ed-label">Label</label><span class="mode">Per language</span></div>
      <input class="input" id="{id}-ed-label" type="text" value={row.label} oninput={(e) => (row.label = e.currentTarget.value)} placeholder={fallback(row)} aria-describedby="{id}-ed-label-hint" />
      <p class="hint" id="{id}-ed-label-hint">{row.link.type === 'url' ? 'Empty shows the address itself,' : "Empty uses the page's own title,"} <b>{fallback(row)}</b>.</p>
    </div>
    <div class="field">
      <div class="label-row"><span id="{id}-ed-link-l">Links to</span><span class="mode">Same in every language</span></div>
      {#if changing}
        <PagePicker id="{id}-ed-link" label="a page or entry" labelId="{id}-ed-link-l" indexes chosen={keyOf(row.link)} onpick={(e) => { row.link = linkTo(e); changing = false; }} onurl={(href) => { row.link = { type: 'url', href }; changing = false; }} onclose={() => (changing = false)} />
      {:else}
        <div class="link-summary" role="group" aria-labelledby="{id}-ed-link-l">
          <span class="name">{fallback(row)}</span>
          <button class="btn btn-sm" type="button" onclick={() => (changing = true)}>Change</button>
          <span class="sub">{row.link.type === 'url' ? 'Link' : 'Page'} <code>{target(row)}</code></span>
        </div>
      {/if}
      <p class="hint">{row.link.type === 'url' ? 'Custom links use this exact address in every language.' : 'Visitors go to the linked page in their language automatically.'}</p>
    </div>
    <label class="choice" for="{id}-ed-tab"><input type="checkbox" id="{id}-ed-tab" checked={row.newTab === true} onchange={(e) => { if (e.currentTarget.checked) row.newTab = true; else delete row.newTab; }} /><span>Open in a new tab</span></label>
    {#if known.locales.length > 1}
      <details class="nav-visibility" open={shownIn(row) !== ''}>
        <summary>Language visibility<span>{shownIn(row) ? `${languageName(shownIn(row))} only` : 'All languages'}</span></summary>
        <fieldset>
        <legend>Show this item in</legend>
        <label class="choice"><input type="radio" name="{id}-ed-loc" checked={shownIn(row) === ''} onchange={() => showIn(row, '')} /><span>All languages</span></label>
        {#each known.locales as of (of)}
          <label class="choice"><input type="radio" name="{id}-ed-loc" checked={shownIn(row) === of} onchange={() => showIn(row, of)} /><span>{languageName(of)} only</span></label>
        {/each}
        </fieldset>
        <p class="hint">Most items belong in all languages. Limit an item only for language-specific content, such as a legal link. This also applies to its sub-items.</p>
        {#if row.link.type !== 'url'}<p class="hint">The item only appears where its linked page is available. This setting does not create a translation.</p>{/if}
      </details>
    {/if}
    <div class="actions">
      <button class="btn btn-primary" type="button" onclick={closeEditor}>Done</button>
      <button class="btn" type="button" onclick={() => cancelEdit(row)}>Cancel</button>
    </div>
  </div>
{/snippet}

{#snippet indicator()}
  {#if mark?.kind === 'line'}
    <li aria-hidden="true"><div class="drop-line"></div></li>
  {:else if mark?.kind === 'into' && mark.parent}
    <li aria-hidden="true"><div class="drop-into" class:is-deeper={mark.deeper}>Add inside <b>{name(mark.parent)}</b>{#if mark.sib}, after {name(mark.sib)}{/if}</div></li>
  {:else if mark}
    <li aria-hidden="true"><div class="drop-blocked" class:is-deeper={mark.deeper}>Can't go here — three levels is as deep as a menu goes</div></li>
  {/if}
{/snippet}

{#snippet labelled(list: MenuItem[])}
  <ul class="branch">
    {#each list as item (item._id)}
      {@const says = flag(item)}
      <li>
        <div class="menu-item is-label">
          <label class="lbl" for="{id}-lbl-{item._id}">{fallback(item)}</label>
          <input class="input" id="{id}-lbl-{item._id}" type="text" value={item.label} oninput={(e) => (item.label = e.currentTarget.value)} placeholder={fallback(item)} aria-describedby="{id}-tgt-{item._id}" />
          <span class="kind" id="{id}-tgt-{item._id}">
            {kind(item)}
            {#if says}<span class="badge badge-warn" title={says.why}>{says.chip}</span>{/if}
          </span>
        </div>
        {#if item.children?.length}
          {@render labelled(item.children)}
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<svelte:window
  onkeydown={(e) => { if (e.key !== 'Escape') return; if (removing) { removing = undefined; trigger?.focus(); } else if (menuFor) menuFor = ''; }}
  onclick={(e) => { const at = e.target as HTMLElement; if (menuFor && !at.closest('.row-menu')) menuFor = ''; }}
/>

<div class="nav-build" class:is-labels={translating} {id} role="group" aria-labelledby={labelId}>
  {#if !menu}
    <div class="empty is-wide">
      <div>
        <h2>No menus yet</h2>
        <p>
          A menu is declared in <code>src/content/globals/</code> by whoever built the site. Once
          there is one, its items are edited here.
        </p>
      </div>
    </div>
  {:else}
    {#if menus.length > 1}
      <div class="tabs is-menus" role="tablist" aria-label="Menus">
        {#each menus as one, i (one._id)}
          <button type="button" role="tab" id="{id}-tab-{i}" aria-selected={i === tab} aria-controls="{id}-menu" tabindex={i === tab ? 0 : -1} onkeydown={walkTabs} onclick={() => { tab = i; editing = ''; addedMessage = ''; }}>{capitalise(one.key)}</button>
        {/each}
      </div>
    {/if}
    <div class="nav-main" id="{id}-menu" role={menus.length > 1 ? 'tabpanel' : undefined} aria-labelledby={menus.length > 1 ? `${id}-tab-${tab}` : undefined}>
      {#if !translating}
        <section class="nav-library" aria-labelledby="{id}-add-h">
          <header class="nav-panel-heading">
            <h2 id="{id}-add-h">Add to menu</h2>
            <p>Choose a page or add your own link.</p>
            <a class="nav-jump" href="#{id}-structure-h">Go to menu structure ↓</a>
          </header>
          <PagePicker id="{id}-pick" label="pages and entries" labelId="{id}-add-h" indexes library {included} onpick={addEntry} onurl={addUrl} />
          <p class="nav-feedback" role="status">{addedMessage || 'Pages keep their titles up to date automatically.'}</p>
        </section>
      {/if}
      <section class="nav-workspace" aria-labelledby="{id}-structure-h">
        <header class="nav-structure-heading">
          <div><h2 id="{id}-structure-h" tabindex="-1">{translating ? `${languageName(language)} menu labels` : 'Menu structure'}</h2><p>{translating ? 'Translate the labels visitors see in this language.' : 'Shared across languages. Drag to reorder; move right to nest.'}</p></div>
          <span class="nav-count">{flatItems.length} {flatItems.length === 1 ? 'item' : 'items'}</span>
        </header>
      {#if translating}
        <!-- The shape is one tree for the whole site, and this column cannot save one: a save of
             a translation writes the words this language owns and nothing else. -->
        <div class="menu-tree">
          <p class="notice notice-info">Edit labels here. To add, remove or arrange items, switch to {sourceLabel || 'the source language'}. The menu structure is shared across languages.</p>
          {@render labelled(menu.items)}
        </div>
        <p class="tree-note">An empty box uses the page's own title in this language.</p>
      {:else if menu.items.length}
        <DragDropProvider onDragStart={begun} onDragMove={moved} onDragOver={(_, m) => place(m)} onDragEnd={ended}>
          <div class="menu-tree">
            {@render branch(menu.items, [])}
          </div>
          <DragOverlay>
            {#snippet children(source)}
              {@const carried = find(menu.items, String(source.id))}
              {#if carried}<div class="drag-proxy">⠿ {name(carried)}</div>{/if}
            {/snippet}
          </DragOverlay>
        </DragDropProvider>
      {:else}
        <div class="empty tree-empty">
          <div>
            <h2>Nothing in this menu yet</h2>
            <p>Choose a page from Add to menu to get started.<br />You can arrange it and change its label here.</p>
          </div>
        </div>
      {/if}
        {#if !translating && menu.items.length}<p class="nav-tree-help">Select an item to edit its label and destination. The ⋯ menu has move and remove options.</p>{/if}
      </section>
    </div>
  {/if}
</div>

{#if removing}
  <!-- Not aria-modal: the shell behind stays reachable, as it does on the other screens. -->
  <div class="scrim">
    <div class="dialog" role="alertdialog" aria-labelledby="{id}-rm-h" aria-describedby="{id}-rm-d">
      <h2 id="{id}-rm-h">Remove {name(removing)} and what is under it?</h2>
      <p id="{id}-rm-d">
        {removing.children?.length === 1 ? 'The item under it goes too' : `The ${removing.children?.length} items under it go too`}. Nothing is removed from the site — the pages stay where they are, they just stop being in this menu.
      </p>
      <div class="actions">
        <button class="btn" type="button" {@attach (node) => node.focus()} onclick={() => { removing = undefined; trigger?.focus(); }}>Cancel</button>
        <button class="btn btn-danger" type="button" onclick={() => removing && drop(pathOf(removing))}>Remove</button>
      </div>
    </div>
  </div>
{/if}
