<script module lang="ts">
/** One item of the `navigation` global, as the format stores it. */
export interface MenuItem {
  _id: string;
  /** The languages this item is shown in; absent is all of them. */
  _locales?: string[];
  label: string;
  link: { type: 'url'; href: string } | { type: 'entry' | 'page'; ref: string };
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
import { newId, unsafeLinkScheme } from '@handover/core';
import { tick } from 'svelte';
import PagePicker, { type Pickable, type PickEntry, readPickable } from './PagePicker.svelte';

let {
  id,
  labelId,
  menus,
  locale = '',
  translating = false,
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
} = $props();

let tab = $state(0);
/** The item whose form has taken the tree's place, by `_id`. */
let editing = $state('');
/** What that item was when the form opened, so Cancel puts it back. */
let before: MenuItem | undefined;
/** The item waiting to be confirmed away, and the button to give focus back to. */
let removing = $state<MenuItem>();
let trigger: HTMLElement | undefined;
/** The item form's picker is open over the link summary. */
let changing = $state(false);
let custom = $state({ label: '', href: '', newTab: false });
// On a phone the tree is the screen and the add pane is a sheet opened from a button; wider
// than that the stylesheet hides the button and the pane is simply there. One disclosure
// either way, so nothing here asks how wide the screen is.
let adding = $state(false);
let addButton = $state<HTMLButtonElement>();
async function openAdd() {
  adding = true;
  await tick();
  document.getElementById(`${id}-add-h`)?.focus();
}
function closeAdd() {
  adding = false;
  addButton?.focus();
}

const menu = $derived(menus[tab]);
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// The pages and entries an item can point at, for the left pane's list and for saying what a
// row already points at — the same read the link field makes.
let known = $state<Pickable>({ entries: [], locales: [] });
$effect(() => {
  readPickable().then((p) => (known = p));
});
const language = $derived(locale || known.locales[0] || '');

const entryOf = (item: MenuItem) => {
  const link = item.link;
  return link.type === 'url' ? undefined : known.entries.find((e) => e.path === link.ref);
};
/** What the row is called when nobody has typed a label: the page's own title. */
const fallback = (item: MenuItem) =>
  item.link.type === 'url' ? item.link.href : (entryOf(item)?.title ?? item.link.ref);
const name = (item: MenuItem) => item.label || fallback(item);
/** Where it goes in this language, which is what the client recognises the page by. */
const target = (item: MenuItem) =>
  item.link.type === 'url' ? item.link.href : (entryOf(item)?.urls[language] ?? item.link.ref);
// Why the site will skip this row. The renderer drops it either way; the editor is where
// somebody can see that it is going to and tidy the menu.
const flag = (item: MenuItem) => {
  if (item.link.type === 'url') return undefined;
  const entry = entryOf(item);
  if (!entry) return 'That page is gone — the site skips this item';
  if (entry.hidden) return 'Hidden — the site skips this item';
  if (language && !entry.locales.includes(language))
    return `Not available in ${language.toUpperCase()} — the site skips this item here`;
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
    trigger = document.activeElement as HTMLElement;
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
/** Where the item waiting to be confirmed away sits now — it can be moved from under a dialog. */
const pathOf = (item: MenuItem, list = menu?.items ?? [], at: number[] = []): number[] => {
  for (const [i, row] of list.entries()) {
    if (row === item) return [...at, i];
    const found = row.children?.length ? pathOf(item, row.children, [...at, i]) : [];
    if (found.length) return found;
  }
  return [];
};

const scheme = $derived(custom.href ? unsafeLinkScheme('default', custom.href) : undefined);
function add(item: MenuItem) {
  menu?.items.push(item);
}
// A picked page keeps no label of its own: renaming the page then moves the menu with it, and
// typing over the greyed title is what writes one.
const addEntry = (entry: PickEntry) =>
  add({ _id: newId('default'), label: '', link: { type: 'entry', ref: entry.path } });
function addCustom() {
  if (!custom.href || scheme) return;
  add({
    _id: newId('default'),
    label: custom.label,
    link: { type: 'url', href: custom.href },
    ...(custom.newTab ? { newTab: true } : {}),
  });
  custom = { label: '', href: '', newTab: false };
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
  editing = '';
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
  (event.currentTarget as HTMLElement).parentElement?.querySelectorAll('button')[tab]?.focus();
}
</script>

{#snippet branch(list: MenuItem[], path: number[])}
  <ul class="branch">
    {#if mark && mark.list === list && !mark.after}{@render indicator()}{/if}
    {#each list as item, i (item._id)}
      {@const here = [...path, i]}
      {@const says = flag(item)}
      {@const s = sortable(() => item._id, () => i)}
      <li>
        <div class="menu-item" class:is-lifted={s.isDragging} class:is-flagged={says} {@attach s.attach}>
          <button class="grip" type="button" aria-label="Reorder {name(item)} — press space, then the arrow keys" {@attach s.attachHandle}>⠿</button>
          <span class="lbl">
            {#if item.label}
              {item.label}
            {:else}
              <span class="default-label">{fallback(item)}</span>
              <span class="badge">Uses the page title</span>
            {/if}
            {#if item._locales?.length === 1}<span class="badge badge-info">{(item._locales[0] ?? '').toUpperCase()} only</span>{/if}
          </span>
          <span class="target">
            {item.link.type === 'url' ? 'Link' : 'Page'} <code>{target(item)}</code>
            {#if says}<span class="badge badge-warn">{says}</span>{/if}
          </span>
          <div class="item-actions">
            <div class="move-controls">
              <button class="btn btn-ghost btn-icon btn-sm" type="button" disabled={i === 0} aria-label="Move {name(item)} up" onclick={() => step(here, -1)}>↑</button>
              <button class="btn btn-ghost btn-icon btn-sm" type="button" disabled={i === list.length - 1} aria-label="Move {name(item)} down" onclick={() => step(here, 1)}>↓</button>
              <button class="btn btn-ghost btn-icon btn-sm" type="button" disabled={!canIndent(item, here)} aria-label="Indent {name(item)} — make it a sub-item" onclick={() => indent(item, here)}>→</button>
              <button class="btn btn-ghost btn-icon btn-sm" type="button" disabled={path.length === 0} aria-label="Outdent {name(item)}" onclick={() => outdent(here)}>←</button>
            </div>
            <button class="btn btn-ghost btn-sm" type="button" onclick={() => edit(item)}>Edit<span class="visually-hidden"> {name(item)}</span></button>
            <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Remove {name(item)}" onclick={() => remove(item, here)}>×</button>
          </div>
        </div>
        {#if item.children?.length}
          {@render branch(item.children, here)}
        {/if}
      </li>
      {#if mark && mark.list === list && mark.after === item}{@render indicator()}{/if}
    {/each}
  </ul>
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
        <div class="menu-item is-label" class:is-flagged={says}>
          <label class="lbl" for="{id}-lbl-{item._id}">{fallback(item)}</label>
          <input class="input" id="{id}-lbl-{item._id}" type="text" value={item.label} oninput={(e) => (item.label = e.currentTarget.value)} placeholder={fallback(item)} aria-describedby="{id}-tgt-{item._id}" />
          <span class="target" id="{id}-tgt-{item._id}">
            {item.link.type === 'url' ? 'Link' : 'Page'} <code>{target(item)}</code>
            {#if says}<span class="badge badge-warn">{says}</span>{/if}
          </span>
        </div>
        {#if item.children?.length}
          {@render labelled(item.children)}
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<svelte:window onkeydown={(e) => { if (e.key !== 'Escape') return; if (removing) { removing = undefined; trigger?.focus(); } else if (adding) closeAdd(); }} />

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
          <button type="button" role="tab" id="{id}-tab-{i}" aria-selected={i === tab} aria-controls="{id}-menu" tabindex={i === tab ? 0 : -1} onkeydown={walkTabs} onclick={() => { tab = i; editing = ''; }}>{capitalise(one.key)}</button>
        {/each}
      </div>
    {/if}
    {#if !translating}
      <button class="btn btn-primary nav-add-open" type="button" aria-expanded={adding} aria-controls="{id}-add" bind:this={addButton} onclick={openAdd}>Add to menu</button>
      <div class="nav-add" class:is-open={adding} id="{id}-add">
        <h2 class="side-title" id="{id}-add-h" tabindex="-1">Add to menu</h2>
        <PagePicker id="{id}-pick" label="pages and entries" labelId="{id}-add-h" onpick={addEntry} />
        <p class="hint">Choosing one puts it at the bottom of the menu; move it from there.</p>
        <div class="custom-link">
          <h3 class="side-title" id="{id}-cl-h">Custom link</h3>
          <div class="field">
            <div class="label-row"><label for="{id}-cl-label">Label</label></div>
            <input class="input" id="{id}-cl-label" type="text" bind:value={custom.label} placeholder="Book a viewing" />
          </div>
          <div class="field" class:is-invalid={scheme}>
            <div class="label-row"><label for="{id}-cl-url">Address</label></div>
            <input class="input" id="{id}-cl-url" type="text" bind:value={custom.href} placeholder="/contact or https://…" aria-invalid={scheme ? 'true' : undefined} aria-describedby={scheme ? `${id}-cl-err` : undefined} />
            {#if scheme}<p class="error" id="{id}-cl-err">{scheme}: links are not allowed</p>{/if}
          </div>
          <label class="choice" for="{id}-cl-tab"><input type="checkbox" id="{id}-cl-tab" bind:checked={custom.newTab} /><span>Open in a new tab</span></label>
          <button class="btn btn-sm" type="button" disabled={!custom.href || !!scheme} onclick={addCustom}>Add to menu</button>
        </div>
        <button class="btn nav-add-close" type="button" onclick={closeAdd}>Done</button>
      </div>
    {/if}
    <div class="nav-main" id="{id}-menu" role={menus.length > 1 ? 'tabpanel' : undefined} aria-labelledby={menus.length > 1 ? `${id}-tab-${tab}` : undefined}>
      {#if found}
        <!-- Editing takes the tree's place rather than floating over it: a form over a tree
             somebody is reading is the worst of both. -->
        <div class="form" aria-labelledby="{id}-ed-h">
          <h2 class="side-title" id="{id}-ed-h">{name(found)}</h2>
          <div class="field">
            <div class="label-row"><label for="{id}-ed-label">Label</label><span class="mode">Per language</span></div>
            <input class="input" id="{id}-ed-label" type="text" value={found.label} oninput={(e) => { if (found) found.label = e.currentTarget.value; }} placeholder={fallback(found)} aria-describedby="{id}-ed-label-hint" />
            <p class="hint" id="{id}-ed-label-hint">Empty uses the page's own title, <b>{fallback(found)}</b>.</p>
          </div>
          <div class="field">
            <div class="label-row"><span id="{id}-ed-link-l">Links to</span><span class="mode">Same in every language</span></div>
            {#if changing}
              <PagePicker id="{id}-ed-link" label="a page or entry" labelId="{id}-ed-link-l" chosen={found.link.type === 'url' ? '' : found.link.ref} onpick={(e) => { found.link = { type: 'entry', ref: e.path }; changing = false; }} onurl={(href) => { found.link = { type: 'url', href }; changing = false; }} onclose={() => (changing = false)} />
            {:else}
              <div class="link-summary" role="group" aria-labelledby="{id}-ed-link-l">
                <span class="name">{fallback(found)}</span>
                <button class="btn btn-sm" type="button" onclick={() => (changing = true)}>Change</button>
                <span class="sub">{found.link.type === 'url' ? 'Link' : 'Page'} <code>{target(found)}</code></span>
              </div>
            {/if}
          </div>
          <label class="choice" for="{id}-ed-tab"><input type="checkbox" id="{id}-ed-tab" checked={found.newTab === true} onchange={(e) => { if (e.currentTarget.checked) found.newTab = true; else delete found.newTab; }} /><span>Open in a new tab</span></label>
          {#if known.locales.length > 1}
            <fieldset>
              <legend>Show in<span class="mode">Same in every language</span></legend>
              <label class="choice"><input type="radio" name="{id}-ed-loc" checked={shownIn(found) === ''} onchange={() => showIn(found, '')} /><span>All languages</span></label>
              {#each known.locales as of (of)}
                <label class="choice"><input type="radio" name="{id}-ed-loc" checked={shownIn(found) === of} onchange={() => showIn(found, of)} /><span>{of.toUpperCase()} only</span></label>
              {/each}
            </fieldset>
          {/if}
          <div class="actions">
            <button class="btn btn-primary" type="button" onclick={() => (editing = '')}>Save</button>
            <button class="btn" type="button" onclick={() => cancelEdit(found)}>Cancel</button>
          </div>
        </div>
      {:else if translating}
        <!-- The shape is one tree for the whole site, and this column cannot save one: a save of
             a translation writes the words this language owns and nothing else. -->
        <div class="menu-tree">
          <p class="notice notice-info">The shape of this menu is shared with every language. Items are added, moved and removed in the other column; the labels here are this language's own.</p>
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
        <p class="tree-note">Up to {MAX_DEPTH} levels. Drag a row where it should go — carrying it right makes it a sub-item — or use the arrow buttons on it.</p>
      {:else}
        <div class="empty tree-empty">
          <div>
            <h2>Nothing in this menu yet</h2>
            <p>Choose a page on the left, or write a custom link.</p>
          </div>
        </div>
      {/if}
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
