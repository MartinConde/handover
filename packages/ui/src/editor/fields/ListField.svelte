<script lang="ts">
import { KeyboardSensor, PointerSensor, type Sensors } from '@dnd-kit/dom';
import { type DragDropEventHandlers, DragDropProvider } from '@dnd-kit/svelte';
import { createSortable, isSortable } from '@dnd-kit/svelte/sortable';
import { type Field, type Form, labelIn, newId, type Translation } from '@handover/core';
import type { Snippet } from 'svelte';
import { capitalise } from '../../i18n.js';
import Focal from '../../media/Focal.svelte';
import MediaPicker from '../../media/MediaPicker.svelte';
import type { MediaItem } from '../../media/upload.js';
import * as m from '../../paraglide/messages.js';
import MediaImage from '../../shared/MediaImage.svelte';
import Modal from '../../shared/Modal.svelte';
import type {
  EntrySession,
  FieldCommandResult,
  ListCommandResult,
  ListOperation,
} from '../entry-session.svelte';
import { aspect, centred, type Data, type FieldLevel, readFrom, stored } from './field-level.js';
import ImageCard from './ImageCard.svelte';

let {
  level,
  id,
  at,
  field,
  text,
  mode,
  form,
  root = $bindable(),
  session,
  locale,
  oncommand,
  onreveal,
  blocks,
  blockLabels,
  problems,
}: {
  level: FieldLevel;
  id: string;
  at: readonly string[];
  field: Extract<Field, { type: 'array' | 'blocks' }>;
  text: string;
  mode: Translation;
  /** One form level deeper, drawn by Fields for each row or block. */
  form: Snippet<
    [
      inner: readonly Field[],
      at: readonly string[],
      mode: Translation,
      view: Data,
      rowLabel?: string,
    ]
  >;
  root: Data;
  session?: EntrySession;
  locale: string;
  oncommand?: (result: FieldCommandResult | ListCommandResult) => void;
  onreveal?: (path: readonly string[]) => void;
  blocks: Record<string, Field[]>;
  blockLabels?: Form['blockLabels'];
  problems: Record<string, string>;
} = $props();
const options = $derived(level.options);
const rows = (): unknown[] => {
  const v = level.read(at);
  return Array.isArray(v) ? v : [];
};
const dot = (at: readonly string[]) => level.point(at).map((n) => n * 100);
// A folded card hides the field the *problems* button jumps to, so a block with one stays open.
const broken = (at: string[]) => {
  const under = `${at.join('.')}.`;
  return Object.keys(problems).some((p) => p.startsWith(under));
};
function directList(operation: ListOperation) {
  const held = readFrom(root, at);
  if (operation.type === 'insert') {
    if (Array.isArray(held)) held.splice(operation.index, 0, operation.value);
    else level.write(at, [operation.value]);
  } else if (Array.isArray(held) && operation.type === 'remove') {
    held.splice(operation.index, 1);
  } else if (Array.isArray(held) && operation.type === 'move') {
    move(held, operation.from, operation.to);
  }
}
function listCommand(operation: ListOperation) {
  if (!session) {
    directList(operation);
    return;
  }
  const stable = level.address(at);
  const result = stable
    ? session.listCommand(locale, {
        address: stable,
        contentVersion: session.contentVersion(locale),
        operation,
      })
    : ({ ok: false, reason: 'ambiguous' } as const);
  oncommand?.(result);
  return result;
}
function add(item: unknown) {
  const held = readFrom(root, at);
  const index = Array.isArray(held) ? held.length : 0;
  const result = listCommand({ type: 'insert', index, value: item });
  if (!session || result?.ok) folded[keyOf(rows(), index)] = false;
}
// A scalar row has no `_id`; without a key that moves with it a reorder swaps words, not cards.
const names = new WeakMap<object, string[]>();
function keyOf(items: unknown[], i: number): string {
  const row = items[i] as Data | undefined;
  if (typeof row?._id === 'string') return row._id;
  const keys = names.get(items) ?? [];
  names.set(items, keys);
  while (keys.length < items.length) keys.push(newId());
  return keys[i] as string;
}
function move(items: unknown[], from: number, to: number) {
  items.splice(to, 0, ...items.splice(from, 1));
  names.get(items)?.splice(to, 0, ...(names.get(items)?.splice(from, 1) ?? []));
}
function drop(index: number) {
  const held = readFrom(root, at);
  const result = listCommand({ type: 'remove', index });
  if (Array.isArray(held) && (!session || result?.ok)) names.get(held)?.splice(index, 1);
}
function duplicate(index: number) {
  const result = listCommand({ type: 'duplicate', index });
  if (result?.ok) folded[keyOf(rows(), index + 1)] = false;
}
type Handlers = Required<DragDropEventHandlers>;
let origin = -1;
let dragAddress = '';
let dragVersion = -1;
let dragId = '';
// Hover order lives only in this rendering copy; the entry changes once, on a successful drop.
function begun(event: Parameters<Handlers['onDragStart']>[0]) {
  const { source } = event.operation;
  origin = isSortable(source) ? source.index : -1;
  dragId = source ? String(source.id) : '';
  dragAddress = level.address(at);
  dragVersion = session?.contentVersion(locale) ?? -1;
  if (origin < 0 || !dragAddress) return;
  const next = structuredClone($state.snapshot(root) as Data);
  const before = readFrom(root, at);
  const projected = readFrom(next, at);
  if (!Array.isArray(before) || !Array.isArray(projected)) return;
  const keys = names.get(before);
  level.projection = next;
  // `$state` proxies the clone on assignment, so attach scalar-row identities to that array.
  const held = readFrom(level.projection as Data, at);
  if (keys && Array.isArray(held)) names.set(held, [...keys]);
}
function over(event: Parameters<Handlers['onDragOver']>[0]) {
  const { source, target } = event.operation;
  if (
    !level.projection ||
    !isSortable(source) ||
    !isSortable(target) ||
    source.index === target.index
  )
    return;
  move(level.read(at) as unknown[], source.index, target.index);
}
function ended(event: Parameters<Handlers['onDragEnd']>[0]) {
  const from = origin;
  const projected = level.projection ? readFrom(level.projection, at) : undefined;
  const to = Array.isArray(projected)
    ? projected.findIndex((_row, i) => keyOf(projected, i) === dragId)
    : -1;
  const stable = dragAddress;
  const version = dragVersion;
  level.projection = undefined;
  origin = -1;
  dragAddress = '';
  dragVersion = -1;
  dragId = '';
  if (event.canceled || from < 0 || to < 0 || from === to) return;
  if (!session) directList({ type: 'move', from, to });
  else {
    const result = stable
      ? session.listCommand(locale, {
          address: stable,
          contentVersion: version,
          operation: { type: 'move', from, to },
        })
      : ({ ok: false, reason: 'ambiguous' } as const);
    oncommand?.(result);
  }
}
// Read lazily: an eager read would remake the sortable on every reorder, losing the animation.
const sortable = (id: () => string, index: () => number, sensors?: Sensors) =>
  createSortable({
    ...(sensors && { sensors }),
    get id() {
      return id();
    },
    get index() {
      return index();
    },
    get disabled() {
      return level.translating || level.structureLocked;
    },
  });

const block = (row: unknown) =>
  row as { _type?: string; _id?: string; _label?: string; _ref?: string };
// Folded blocks, by the block's own key, so a fold rides along when the block is moved.
let folded = $state<Record<string, boolean>>({});
function excerpt(row: unknown, inner: Field[] | undefined): string {
  for (const f of inner ?? []) {
    if (f.advanced) continue;
    const v = f.path.reduce<unknown>((node, key) => (node as Data | undefined)?.[key], row);
    if ((f.type === 'text' || f.type === 'richtext') && typeof v === 'string' && v.trim())
      return v.length > 100 ? `${v.slice(0, 99)}…` : v;
    if (f.type === 'group') {
      const words = excerpt(v, f.fields);
      if (words) return words;
    }
    if (f.type === 'array' && Array.isArray(v)) {
      for (const item of v) {
        const words = excerpt(item, f.item);
        if (words) return words;
      }
    }
  }
  return '';
}
// A `_ref` block's content lives in a global and an unknown `_type` has no fields: both read-only.
const blockName = (row: unknown) =>
  block(row)._label ||
  labelIn(blockLabels?.[block(row)._type ?? ''], level.uiLocale) ||
  block(row)._type ||
  '';
const blockFields = (row: unknown) =>
  block(row)._ref === undefined ? blocks[block(row)._type ?? ''] : undefined;

// An array whose row is the picture: the picker takes several at once, one row each.
const gallery = (field: Field) =>
  field.type === 'array' &&
  field.item.length === 1 &&
  field.item[0]?.path.length === 0 &&
  field.item[0]?.type === 'image';

// The picture itself drags as well as the handle; the keyboard still goes through the handle.
const GALLERY_SENSORS: Sensors = [
  PointerSensor.configure({ activatorElements: (source) => [source.element, source.handle] }),
  KeyboardSensor,
];
// The gallery picture whose dialog is open, and whether its focal dialog is.
let editing = $state<number>();
let framing = $state(false);

function pickedInto(items: MediaItem[]) {
  for (const item of items) add(stored('image', item));
  level.picker = '';
}
</script>

{#snippet icon(d: string)}
  <svg class="field-icon" viewBox="0 0 24 24" aria-hidden="true"><path {d} /></svg>
{/snippet}

{#snippet controls(
  i: number,
  name: string,
  handle: (node: HTMLElement) => () => void,
  duplicable = false,
)}
  <div class="row-controls">
    <button
      class="btn btn-ghost btn-icon handle"
      type="button"
      aria-label={m.field_reorder({ item: name }, options)}
      disabled={level.structureLocked}
      {@attach handle}
      >{@render icon('M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01')}</button
    >
    {#if duplicable}<button
        class="btn btn-ghost btn-icon"
        type="button"
        aria-label={m.field_duplicate({ item: name }, options)}
        disabled={level.structureLocked}
        onclick={() => duplicate(i)}>{@render icon('M9 9h10v10H9zM5 15V5h10')}</button
      >{/if}
    <button
      class="btn btn-ghost btn-icon remove-row"
      type="button"
      aria-label={m.field_remove({ item: name }, options)}
      disabled={level.structureLocked}
      onclick={() => drop(i)}>{@render icon('M7 7l10 10M17 7 7 17')}</button
    >
  </div>
{/snippet}

{#if field.type === 'array' && gallery(field) && !level.translating}
  {@const items = rows()}
  {@const preset = field.item[0]?.type === 'image' ? field.item[0].preset : {}}
  <div class="list gallery" {id} role="group" aria-labelledby="{id}-l">
    <DragDropProvider onDragStart={begun} onDragOver={over} onDragEnd={ended}>
      {#each items as _row, i (keyOf(items, i))}
        {@const s = sortable(
          () => keyOf(items, i),
          () => i,
          GALLERY_SENSORS,
        )}
        {@const cell = [...at, String(i)]}
        {@const name = m.field_gallery_image({ index: i + 1, count: items.length }, options)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -- the edit button is the keyboard route -->
        <div
          class={['gallery-item', { 'is-dragging': s.isDragging }]}
          {@attach s.attach}
          onclick={(e) => !e.defaultPrevented && (editing = i)}
        >
          <span class="thumb"
            ><MediaImage
              src={level.src(cell)}
              alt=""
              loading="lazy"
              style="object-position: {dot(cell)[0]}% {dot(cell)[1]}%"
              uiLocale={level.uiLocale}
            /></span
          >
          <span class="gallery-number">{i + 1}</span>
          {#if !level.str([...cell, 'alt'])}<span class="gallery-no-alt"
              >{m.field_gallery_no_alt({}, options)}</span
            >{/if}
          <div class="row-controls">
            <button
              class="btn btn-ghost btn-icon handle"
              type="button"
              aria-label={m.field_reorder({ item: name }, options)}
              disabled={level.structureLocked}
              {@attach s.attachHandle}
              >{@render icon('M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01')}</button
            >
            <button
              class="btn btn-ghost btn-icon"
              type="button"
              aria-label={m.field_gallery_edit({ index: i + 1 }, options)}
              onclick={() => (editing = i)}
              >{@render icon('M4 20h4L19 9l-4-4L4 16zM14 6l4 4')}</button
            >
            <button
              class="btn btn-ghost btn-icon remove-row"
              type="button"
              aria-label={m.field_remove({ item: name }, options)}
              disabled={level.structureLocked}
              onclick={() => drop(i)}>{@render icon('M7 7l10 10M17 7 7 17')}</button
            >
          </div>
        </div>
      {/each}
    </DragDropProvider>
    <button
      class="btn btn-sm add"
      type="button"
      aria-label={m.field_list_add_label({ field: text }, options)}
      disabled={level.structureLocked}
      onclick={() => (level.picker = id)}>{m.field_gallery_add({}, options)}</button
    >
  </div>
  {#if level.picker === id}
    <MediaPicker
      kind="images"
      label={text}
      {preset}
      base={level.mediaBase}
      many
      uiLocale={level.uiLocale}
      onpick={pickedInto}
      onclose={() => (level.picker = '')}
    />
  {/if}
  {#if editing !== undefined && items[editing] !== undefined}
    {@const i = editing}
    {@const cell = [...at, String(i)]}
    {@const cellId = `${id}.${i}`}
    <Modal
      labelledby="{cellId}-h"
      panelClass="dialog gallery-dialog"
      initialFocus="input"
      onclose={() => (editing = undefined)}
    >
      <header>
        <h2 id="{cellId}-h">
          {m.field_gallery_image({ index: i + 1, count: items.length }, options)}
        </h2>
      </header>
      <ImageCard
        {level}
        id={cellId}
        at={cell}
        ratio={aspect(preset)}
        onframe={() => (framing = true)}
        onreplace={() => (level.picker = cellId)}
        onremove={() => {
          drop(i);
          editing = undefined;
        }}
        locked={level.structureLocked}
      />
      <div class="actions">
        <button class="btn btn-primary" type="button" onclick={() => (editing = undefined)}
          >{m.field_gallery_done({}, options)}</button
        >
      </div>
    </Modal>
    {#if framing}
      <Focal
        name={text}
        url={level.src(cell)}
        focal={level.point(cell)}
        presets={preset.ratio ? [{ label: text, preset }] : []}
        uiLocale={level.uiLocale}
        onsave={(moved) => {
          level.write([...cell, 'focal'], centred(moved) ? undefined : moved);
          framing = false;
        }}
        onclose={() => (framing = false)}
      />
    {/if}
    {#if level.picker === cellId}
      <MediaPicker
        kind="images"
        label={text}
        {preset}
        base={level.mediaBase}
        uiLocale={level.uiLocale}
        onpick={(picks) => level.picked(cell, 'image', picks)}
        onclose={() => (level.picker = '')}
      />
    {/if}
  {/if}
{:else if field.type === 'array'}
  {@const items = rows()}
  {@const scalar = field.item.length === 1 && field.item[0]?.path.length === 0}
  <div class="list" {id} role="group" aria-labelledby="{id}-l">
    <DragDropProvider onDragStart={begun} onDragOver={over} onDragEnd={ended}>
      {#each items as row, i (keyOf(items, i))}
        {@const s = sortable(
          () => keyOf(items, i),
          () => i,
        )}
        {@const name = m.field_row_name({ field: text, index: i + 1 }, options)}
        {@const open = broken([...at, String(i)])}
        {@const shut = !open && folded[keyOf(items, i)] !== false}
        {#if scalar}
          <div
            class={['row-card', { 'is-scalar': true, 'is-dragging': s.isDragging }]}
            {@attach !level.translating && s.attach}
          >
            <div class="row-fields">
              {@render form(field.item, [...at, String(i)], mode, level.view, `${text} ${i + 1}`)}
            </div>
            {#if !level.translating}{@render controls(i, name, s.attachHandle)}{/if}
          </div>
        {:else}
          <article
            class={['block-card section-card', { 'is-dragging': s.isDragging, 'is-folded': shut }]}
            id="{id}.{i}"
            aria-labelledby="{id}.{i}-h"
            {@attach !level.translating && s.attach}
          >
            <header>
              <button
                class="btn btn-ghost fold section-toggle"
                type="button"
                disabled={open}
                aria-expanded={!shut}
                aria-controls="{id}.{i}-b"
                onclick={() => {
                  const opening = shut;
                  folded[keyOf(items, i)] = !opening;
                  if (opening) onreveal?.([...at, String(i)]);
                }}
              >
                {@render icon('m9 6 6 6-6 6')}
                <span class="section-number">{i + 1}</span>
                <span class="section-copy"
                  ><span class="label" id="{id}.{i}-h">{name}</span>{#if shut}
                    <span class="excerpt">{excerpt(row, field.item)}</span>{/if}</span
                >
              </button>
              {#if !level.translating}{@render controls(i, name, s.attachHandle)}{/if}
            </header>
            {#if !shut}<div class="form" id="{id}.{i}-b">
                {@render form(field.item, [...at, String(i)], mode, level.view, `${text} ${i + 1}`)}
              </div>{/if}
          </article>
        {/if}
      {:else}
        <p class="hint">{m.field_list_empty({}, options)}</p>
      {/each}
    </DragDropProvider>
    {#if !level.translating}
      <button
        class="btn btn-sm add"
        type="button"
        aria-label={m.field_list_add_label({ field: text }, options)}
        disabled={level.structureLocked}
        onclick={() => add(scalar ? '' : { _id: newId() })}
        >{m.field_list_add({}, options)}</button
      >
    {/if}
  </div>
{:else if field.type === 'blocks'}
  {@const items = rows()}
  <div class="list" {id} role="group" aria-labelledby="{id}-l">
    <DragDropProvider onDragStart={begun} onDragOver={over} onDragEnd={ended}>
      {#each items as row, i (keyOf(items, i))}
        {@const name = blockName(row)}
        {@const inner = blockFields(row)}
        {@const label = block(row)._label || capitalise(name.replace(/([a-z])([A-Z])/g, '$1 $2'))}
        {@const s = sortable(
          () => keyOf(items, i),
          () => i,
        )}
        {@const open = broken([...at, String(i)])}
        {@const shut = !open && folded[keyOf(items, i)] !== false}
        <article
          class={['block-card section-card', { 'is-dragging': s.isDragging, 'is-folded': shut }]}
          id="{id}.{i}"
          aria-labelledby="{id}.{i}-h"
          {@attach !level.translating && s.attach}
        >
          <header>
            <button
              class="btn btn-ghost fold section-toggle"
              type="button"
              disabled={open}
              aria-expanded={!shut}
              aria-controls="{id}.{i}-b"
              onclick={() => {
                const opening = shut;
                folded[keyOf(items, i)] = !opening;
                if (opening) onreveal?.([...at, String(i)]);
              }}
            >
              {@render icon('m9 6 6 6-6 6')}
              <span class="section-number">{i + 1}</span>
              <span class="section-copy"
                ><span class="label" id="{id}.{i}-h" title="{block(row)._type} · {block(row)._id}"
                  >{label}</span
                >{#if shut}
                  <span class="excerpt">{excerpt(row, inner)}</span>{/if}</span
              >
            </button>
            {#if !level.translating}{@render controls(i, name, s.attachHandle, true)}{/if}
          </header>
          {#if shut}
            <!-- folded: the header is the whole card -->
          {:else if inner}
            <div class="form" id="{id}.{i}-b">
              {@render form(inner, [...at, String(i)], mode, level.view)}
            </div>
          {:else}
            <p class="ref-note" id="{id}.{i}-b">
              {block(row)._ref ??
                m.field_block_missing({ type: block(row)._type ?? '' }, options)} — {m.field_not_editable({}, options)}
            </p>
          {/if}
        </article>
      {:else}
        <p class="hint">{m.field_list_empty({}, options)}</p>
      {/each}
    </DragDropProvider>
    {#if !level.translating}
      <div class="pop-anchor">
        <button
          class="btn btn-sm add"
          type="button"
          disabled={level.structureLocked}
          aria-haspopup="dialog"
          aria-expanded={level.picker === id}
          onclick={() => (level.picker = id)}>{m.field_add_block({}, options)}</button
        >
        {#if level.picker === id}
          <Modal
            labelledby="{id}-picker-h"
            panelClass="dialog block-picker"
            initialFocus=".type-card"
            onclose={() => (level.picker = '')}
          >
            <header><h2 id="{id}-picker-h">{m.field_add_block({}, options)}</h2></header>
            <div class="types">
              {#each field.types as type (type)}
                <button
                  class="type-card"
                  type="button"
                  value={type}
                  disabled={level.structureLocked}
                  onclick={() => {
                    add({ _type: type, _id: newId() });
                    level.picker = '';
                  }}>{labelIn(blockLabels?.[type], level.uiLocale) ?? type}</button
                >
              {/each}
            </div>
            <div class="actions">
              <button class="btn" type="button" onclick={() => (level.picker = '')}
                >{m.common_cancel({}, options)}</button
              >
            </div>
          </Modal>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .section-card > header { align-items: flex-start; }
  .section-card > header .section-toggle { width: auto; min-width: 0; flex: 1; justify-content: flex-start; align-items: flex-start; gap: 8px; padding: 5px 3px; text-align: left; white-space: normal; }
  .section-toggle > :global(svg) { flex: none; margin-top: 2px; }
  .section-number { flex: none; min-width: 20px; font-size: var(--text-xs); font-variant-numeric: tabular-nums; color: var(--ink-3); line-height: 20px; }
  .section-copy { display: grid; gap: 3px; min-width: 0; }
  .section-card > header .label { max-width: none; font-size: var(--text-sm); }
  .section-card > header .excerpt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; font-size: var(--text-xs); font-weight: 400; white-space: normal; overflow-wrap: anywhere; }
  .section-card > header :global(.row-controls) { flex: none; margin-top: 3px; }
</style>
