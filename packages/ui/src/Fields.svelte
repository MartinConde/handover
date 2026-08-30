<script lang="ts">
import { type DragDropEventHandlers, DragDropProvider } from '@dnd-kit/svelte';
import { createSortable, isSortable } from '@dnd-kit/svelte/sortable';
import {
  type Field,
  fieldAddress,
  newId,
  type Preset,
  type Translation,
  unsafeLinkScheme,
} from '@handover/core';
import Fields from './Fields.svelte';
import Media from './Media.svelte';
import PagePicker, { type Pickable, readPickable } from './PagePicker.svelte';
import RichText from './RichText.svelte';
import { fileSize, type MediaItem } from './upload.js';

type Data = Record<string, unknown>;
let {
  fields,
  root = $bindable(),
  path = [],
  blocks = {},
  problems = {},
  rowLabel = '',
  translating = false,
  machine = [],
  ontranslate,
  inherited = true,
  prefix = 'f',
  mediaBase = '',
  locale = '',
}: {
  fields: readonly Field[];
  root: Data;
  path?: readonly string[];
  /** Fields per block type, keyed as `formOf` returns them. */
  blocks?: Record<string, Field[]>;
  /** What the collection schema will not accept, by the same dotted path the ids use. */
  problems?: Record<string, string>;
  /** Names a field whose own path is empty — one scalar row of an array. */
  rowLabel?: string;
  /** This is a language the entry is translated into: it owns its words and nothing else. */
  translating?: boolean;
  /** The paths a machine's words are still standing at — the file's `_machine`. */
  machine?: string[];
  /** Translate one field from the source language; absent when the site has nothing to do it. */
  ontranslate?: (path: string) => void;
  /** The translation mode the fields inherit — a group hands its own down. */
  inherited?: Translation;
  /** What the field ids start with; two forms on one screen cannot share it. */
  prefix?: string;
  /** Where a stored media key is served from; without it a thumbnail has no source. */
  mediaBase?: string;
  /** The language this column writes: what a link typed into rich text has to point at. */
  locale?: string;
} = $props();

const modeOf = (field: Field): Translation => field.i18n ?? inherited;
// A group, an array or a blocks field is walked whatever its own mode says, because a field
// inside it can say otherwise.
const structural = (field: Field) =>
  field.type === 'group' || field.type === 'array' || field.type === 'blocks';
// Widgets a translation has nothing to act on: `embed` and `seo` only show what is stored,
// and a `reference` points at the same entry in every language. Neither is given to the
// second language as a picture of the first language's value it cannot change.
const FIXED = new Set(['embed', 'seo', 'reference', 'unsupported']);
const shown = $derived(
  translating
    ? fields.filter((f) => structural(f) || (modeOf(f) !== false && !FIXED.has(f.type)))
    : fields,
);

// One picker at a time per form level; the field id says which is open.
let picker = $state('');

// Where the file names this field: `blocks[_id=k3nf9a2p].heading`, which is what `_machine`
// and the machine translation route both address it by. The form knows it by its position.
const address = (at: readonly string[]) => fieldAddress('default', at, root);
// Prose is what a machine is offered — the fields this column draws as something to type in.
const prose = (field: Field) =>
  !!ontranslate && translating && (field.type === 'text' || field.type === 'richtext');

function read(at: readonly string[]): unknown {
  return at.reduce<unknown>((node, key) => (node as Data | undefined)?.[key], root);
}

// `undefined` removes the key so an optional field left empty is absent, not null.
function write(at: readonly string[], value: unknown) {
  let node = root;
  for (const key of at.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Data;
  }
  const last = at[at.length - 1] as string;
  if (value === undefined) delete node[last];
  else node[last] = value;
}

const str = (at: readonly string[]) => {
  const v = read(at);
  return typeof v === 'string' ? v : '';
};
const num = (at: readonly string[]) => {
  const v = read(at);
  return typeof v === 'number' ? v : '';
};
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const rows = (at: readonly string[]): unknown[] => {
  const v = read(at);
  return Array.isArray(v) ? v : [];
};
const list = (at: readonly string[]) => read(at) as unknown[];

function add(at: readonly string[], item: unknown) {
  if (Array.isArray(read(at))) list(at).push(item);
  else write(at, [item]);
}
// A scalar row has no `_id`, so its card is keyed by a name of its own that moves with it;
// otherwise a reorder leaves the cards where they are and swaps the words in them.
const names = new WeakMap<object, string[]>();
function keyOf(items: unknown[], i: number): string {
  const row = items[i] as Data | undefined;
  if (typeof row?._id === 'string') return row._id;
  const keys = names.get(items) ?? [];
  names.set(items, keys);
  while (keys.length < items.length) keys.push(newId('default'));
  return keys[i] as string;
}
function move(items: unknown[], from: number, to: number) {
  items.splice(to, 0, ...items.splice(from, 1));
  names.get(items)?.splice(to, 0, ...(names.get(items)?.splice(from, 1) ?? []));
}
function drop(at: readonly string[], index: number) {
  list(at).splice(index, 1);
  names.get(list(at))?.splice(index, 1);
}
type Handlers = Required<DragDropEventHandlers>;
// The list is rewritten as the card passes over each place it could land, so the others make
// room under it; a drag that is escaped puts the card back where it was picked up.
let origin = -1;
function begun(event: Parameters<Handlers['onDragStart']>[0]) {
  const { source } = event.operation;
  origin = isSortable(source) ? source.index : -1;
}
function over(at: readonly string[], event: Parameters<Handlers['onDragOver']>[0]) {
  const { source, target } = event.operation;
  if (!isSortable(source) || !isSortable(target) || source.index === target.index) return;
  move(list(at), source.index, target.index);
}
function ended(at: readonly string[], event: Parameters<Handlers['onDragEnd']>[0]) {
  const { source } = event.operation;
  if (!event.canceled || !isSortable(source) || origin < 0 || source.index === origin) return;
  move(list(at), source.index, origin);
}
// The handle is the only thing that drags: the row's inputs keep their pointer and keyboard.
const sortable = (id: string, index: () => number) =>
  createSortable({
    id,
    get index() {
      return index();
    },
    get disabled() {
      return translating;
    },
  });

const block = (row: unknown) =>
  row as { _type?: string; _id?: string; _label?: string; _ref?: string };
// A `_ref` block's content lives in a global, and an unknown `_type` has no fields to show;
// both are the same read-only card.
const blockName = (row: unknown) => block(row)._label || block(row)._type || '';
const blockFields = (row: unknown) =>
  block(row)._ref === undefined ? blocks[block(row)._type ?? ''] : undefined;

// A read-only field that says nothing reads as a broken one, so each names the release its
// editor arrives in.
const WHEN: Record<'embed' | 'seo', string> = {
  embed: 'Embeds can be changed from Phase 4. Shown as stored.',
  seo: 'SEO settings can be changed from Phase 4. Shown as stored.',
};

// A stored reference names an entry this form never picked, so the list is read for its
// title and the languages it has. Only where there is something on screen that needs one.
let known = $state<Pickable>({ entries: [], locales: [] });
$effect(() => {
  if (fields.some((f) => f.type === 'reference' || f.type === 'link'))
    readPickable().then((p) => (known = p));
});

// The picture as this field will show it: `16:9` is already what `aspect-ratio` wants.
const aspect = (preset: Preset) => preset.ratio?.replace(':', ' / ') ?? '4 / 3';
const src = (at: readonly string[]) => `${mediaBase}/${str([...at, 'src'])}`;
const bytes = (at: readonly string[]) => fileSize(read([...at, 'bytes']) as number | undefined);

/** What the picker hands back, written as the format stores it — and in that order. */
function picked(at: readonly string[], type: 'image' | 'file', item: MediaItem) {
  write(
    at,
    type === 'image'
      ? // `alt` is left as a hole rather than an empty string: nothing is written for it until
        // somebody types one, and it keeps its place in the file when they do.
        { src: item.src, alt: undefined, width: item.width, height: item.height }
      : { src: item.src, name: item.filename, bytes: item.bytes, mime: item.mime },
  );
  picker = '';
}

// Files dropped on the field itself: the picker opens with them, so there is one upload path.
let dropped = $state<File[]>([]);
function dropOn(id: string, e: DragEvent) {
  e.preventDefault();
  dropped = Array.from(e.dataTransfer?.files ?? []);
  picker = id;
}

const linkType = (at: readonly string[]) => (read([...at, 'type']) === 'url' ? 'url' : 'entry');
function setLinkType(at: readonly string[], type: 'url' | 'entry') {
  write([...at, 'type'], type);
  write([...at, type === 'url' ? 'ref' : 'href'], undefined);
}
</script>

{#snippet machineMark(path: string, text: string)}
  {#if machine.includes(path)}<span class="badge badge-machine">Machine translated</span>{/if}
  <button class="btn btn-ghost btn-translate" type="button" aria-label="Translate {text} from the source language" onclick={() => ontranslate?.(path)}>Translate</button>
{/snippet}

{#snippet groupLabel(id: string, field: Field, text: string, at: readonly string[] = [])}
  <div class="label-row"><span id="{id}-l">{text}{#if 'required' in field && field.required}<span class="req" aria-hidden="true">*</span>{/if}</span>{#if prose(field)}{@render machineMark(address(at), text)}{/if}</div>
{/snippet}

{#snippet controls(at: readonly string[], i: number, name: string, handle: (node: HTMLElement) => () => void)}
  <div class="row-controls">
    <button class="btn btn-ghost btn-icon handle" type="button" aria-label="Reorder {name}" {@attach handle}>⋮⋮</button>
    <button class="btn btn-ghost btn-icon" type="button" aria-label="Remove {name}" onclick={() => drop(at, i)}>×</button>
  </div>
{/snippet}

{#snippet altField(id: string, at: readonly string[])}
  <div class="field"><div class="label-row"><label for="{id}.alt">Alt text</label><span class="mode">Per language</span></div><input class="input" id="{id}.alt" type="text" value={str([...at, 'alt'])} oninput={(e) => write([...at, 'alt'], e.currentTarget.value || undefined)} /></div>
{/snippet}

{#snippet nameField(id: string, at: readonly string[])}
  <div class="field"><div class="label-row"><label for="{id}.name">Display name</label><span class="mode">Per language</span></div><input class="input" id="{id}.name" type="text" value={str([...at, 'name'])} oninput={(e) => write([...at, 'name'], e.currentTarget.value || undefined)} /></div>
{/snippet}

{#snippet chosenEntry(id: string, labelId: string, says: string | undefined, ref: string, open: () => void)}
  {@const found = known.entries.find((e) => e.path === ref)}
  <div class="ref-list" {id} role="group" aria-labelledby={labelId} aria-describedby={says}>
    <div class="ref-item">
      <span class="title">{found?.title ?? ref}</span>
      {#if found}
        <span class="chips">
          {#each known.locales as of (of)}<span class="chip" class:chip-missing={!found.locales.includes(of)}>{of.toUpperCase()}</span>{/each}
        </span>
      {/if}
      <span class="path">{ref}</span>
      <button class="btn btn-ghost btn-sm remove" type="button" onclick={open}>Change</button>
    </div>
  </div>
{/snippet}

{#snippet noEntry(id: string, labelId: string, says: string | undefined, text: string, open: () => void)}
  <div class="list-empty" {id} role="group" aria-labelledby={labelId} aria-describedby={says}>
    <span>Nothing chosen yet</span>
    <button class="btn btn-sm" type="button" onclick={open}>Choose {text}</button>
  </div>
{/snippet}

{#snippet labelRow(id: string, field: Field, text: string, at: readonly string[] = [])}
  <div class="label-row">
    <label for={id}>{text}{#if 'required' in field && field.required}<span class="req" aria-hidden="true">*</span>{/if}</label>
    {#if prose(field)}{@render machineMark(address(at), text)}{/if}
  </div>
{/snippet}

{#each shown as field (field.path.join('.'))}
  {@const at = [...path, ...field.path]}
  {@const id = `${prefix}-${at.join('.')}`}
  {@const mode = modeOf(field)}
  {@const text = field.label || rowLabel}
  {@const err = problems[at.join('.')]}
  {@const bad = err ? 'true' : undefined}
  {@const says = err ? `${id}-err` : undefined}
  <div class="field" class:is-invalid={err}>
    {#if translating && mode === 'duplicate' && !structural(field)}
      {@render groupLabel(id, field, text, at)}
      <div class="readonly" {id} role="region" tabindex="-1" aria-labelledby="{id}-l">{read(at) ?? ''}</div>
      <p class="hint">Same in every language</p>
    {:else if field.type === 'text'}
      {@render labelRow(id, field, text, at)}
      {#if str(at).length > 80 || str(at).includes('\n')}
        <textarea class="input textarea" {id} aria-invalid={bad} aria-describedby={says} value={str(at)} oninput={(e) => write(at, e.currentTarget.value)}></textarea>
      {:else}
        <input class="input" {id} type="text" aria-invalid={bad} aria-describedby={says} value={str(at)} oninput={(e) => write(at, e.currentTarget.value)} />
      {/if}
    {:else if field.type === 'number'}
      {@render labelRow(id, field, text, at)}
      <input class="input" {id} type="number" step="any" aria-invalid={bad} aria-describedby={says} value={num(at)} oninput={(e) => write(at, e.currentTarget.value === '' ? undefined : e.currentTarget.valueAsNumber)} />
    {:else if field.type === 'boolean'}
      <label class="switch" for={id}><input type="checkbox" role="switch" {id} aria-invalid={bad} aria-describedby={says} checked={read(at) === true} onchange={(e) => write(at, e.currentTarget.checked)} /><span>{text}</span></label>
    {:else if field.type === 'date'}
      {@render labelRow(id, field, text, at)}
      <input class="input" {id} type="date" aria-invalid={bad} aria-describedby={says} value={str(at)} oninput={(e) => write(at, e.currentTarget.value || undefined)} />
    {:else if field.type === 'select'}
      {#if field.options.length <= 5}
        <fieldset aria-describedby={says}>
          <legend>{text}{#if field.required}<span class="req" aria-hidden="true">*</span>{/if}</legend>
          {#each field.options as option (option)}
            <label class="choice"><input type="radio" name={id} value={option} checked={read(at) === option} onchange={() => write(at, option)} /><span>{capitalise(option)}</span></label>
          {/each}
        </fieldset>
      {:else}
        {@render labelRow(id, field, text, at)}
        <select class="input" {id} aria-invalid={bad} aria-describedby={says} value={str(at)} onchange={(e) => write(at, e.currentTarget.value || undefined)}>
          <option value="">Choose…</option>
          {#each field.options as option (option)}
            <option value={option}>{capitalise(option)}</option>
          {/each}
        </select>
      {/if}
    {:else if field.type === 'link' && translating}
      <!-- A link's label is the half a translation owns; where it points is the same everywhere. -->
      {@render groupLabel(id, field, text, at)}
      <div class="field"><div class="label-row"><label for="{id}.label">Label</label>{#if ontranslate}{@render machineMark(`${address(at)}.label`, `${text} label`)}{/if}</div><input class="input" id="{id}.label" type="text" value={str([...at, 'label'])} oninput={(e) => write([...at, 'label'], e.currentTarget.value || undefined)} /></div>
    {:else if field.type === 'link'}
      {@render groupLabel(id, field, text, at)}
      <div class="seg" role="group" aria-label="Link type">
        <button type="button" aria-pressed={linkType(at) === 'entry'} onclick={() => setLinkType(at, 'entry')}>Page / Entry</button>
        <button type="button" aria-pressed={linkType(at) === 'url'} onclick={() => setLinkType(at, 'url')}>URL</button>
      </div>
      {#if linkType(at) === 'url'}
        {@const scheme = unsafeLinkScheme('default', str([...at, 'href']))}
        <div class="field" class:is-invalid={scheme}>
          <div class="label-row"><label for="{id}.href">URL</label></div>
          <input class="input" id="{id}.href" type="url" aria-invalid={scheme ? 'true' : undefined} aria-describedby={scheme ? `${id}.href-err` : undefined} value={str([...at, 'href'])} oninput={(e) => { write([...at, 'type'], 'url'); write([...at, 'href'], e.currentTarget.value); }} />
          {#if scheme}<p class="error" id="{id}.href-err">{scheme}: links are not allowed</p>{/if}
        </div>
      {:else if picker === id}
        <PagePicker {id} label={text} labelId="{id}-l" chosen={str([...at, 'ref'])} onpick={(e) => { write([...at, 'type'], 'entry'); write([...at, 'ref'], e.path); picker = ''; }} onclose={() => (picker = '')} />
      {:else if str([...at, 'ref'])}
        {@render chosenEntry(`${id}.ref`, `${id}-l`, says, str([...at, 'ref']), () => (picker = id))}
      {:else}
        {@render noEntry(`${id}.ref`, `${id}-l`, says, 'a page or entry', () => (picker = id))}
      {/if}
      <div class="field"><div class="label-row"><label for="{id}.label">Label</label></div><input class="input" id="{id}.label" type="text" value={str([...at, 'label'])} oninput={(e) => write([...at, 'label'], e.currentTarget.value || undefined)} /></div>
      <label class="check" for="{id}.newTab"><input type="checkbox" id="{id}.newTab" checked={read([...at, 'newTab']) === true} onchange={(e) => write([...at, 'newTab'], e.currentTarget.checked || undefined)} /><span>Open in new tab</span></label>
    {:else if field.type === 'richtext'}
      {@render groupLabel(id, field, text, at)}
      <RichText {id} labelId="{id}-l" {locale} tier={field.tier} invalid={!!err} describedby={says} value={str(at)} onchange={(md) => write(at, md)} />
    {:else if field.type === 'group'}
      <details class="group" open>
        <summary>{text}<span class="count">{field.fields.length} fields</span></summary>
        <div class="form"><Fields fields={field.fields} bind:root {blocks} {problems} path={at} {translating} {machine} {ontranslate} {prefix} {mediaBase} {locale} inherited={mode} /></div>
      </details>
    {:else if field.type === 'array'}
      {@const items = rows(at)}
      {@const scalar = field.item.length === 1 && field.item[0]?.path.length === 0}
      {@render groupLabel(id, field, text, at)}
      <div class="list" {id} role="group" aria-labelledby="{id}-l">
        <DragDropProvider onDragStart={begun} onDragOver={(e) => over(at, e)} onDragEnd={(e) => ended(at, e)}>
        {#each items as row, i (keyOf(items, i))}
          {@const s = sortable(keyOf(items, i), () => i)}
          <div class="row-card" class:is-dragging={s.isDragging} {@attach s.attach}>
            <div class="row-fields"><Fields fields={field.item} bind:root {blocks} {problems} path={[...at, String(i)]} rowLabel="{text} {i + 1}" {translating} {machine} {ontranslate} {prefix} {mediaBase} {locale} inherited={mode} /></div>
            {#if !translating}{@render controls(at, i, `${text} row ${i + 1}`, s.attachHandle)}{/if}
          </div>
        {:else}
          <p class="hint">Nothing here yet</p>
        {/each}
        </DragDropProvider>
        {#if !translating}<button class="btn btn-sm add" type="button" onclick={() => add(at, scalar ? '' : { _id: newId('default') })}>Add to {text}</button>{/if}
      </div>
    {:else if field.type === 'blocks'}
      {@const items = rows(at)}
      {@render groupLabel(id, field, text, at)}
      <div class="list" {id} role="group" aria-labelledby="{id}-l">
        <DragDropProvider onDragStart={begun} onDragOver={(e) => over(at, e)} onDragEnd={(e) => ended(at, e)}>
        {#each items as row, i (keyOf(items, i))}
          {@const name = blockName(row)}
          {@const inner = blockFields(row)}
          {@const s = sortable(keyOf(items, i), () => i)}
          <article class="block-card" id="{id}.{i}" aria-labelledby="{id}.{i}-h" class:is-dragging={s.isDragging} {@attach s.attach}>
            <header>
              <span class="label" id="{id}.{i}-h">{name}</span>
              <span class="type">{block(row)._type} · {block(row)._id}</span>
              {#if !translating}{@render controls(at, i, name, s.attachHandle)}{/if}
            </header>
            {#if inner}
              <div class="form"><Fields fields={inner} bind:root {blocks} {problems} path={[...at, String(i)]} {translating} {machine} {ontranslate} {prefix} {mediaBase} {locale} inherited={mode} /></div>
            {:else}
              <p class="ref-note">{block(row)._ref ?? `No “${block(row)._type}” block in the registry`} — not editable here</p>
            {/if}
          </article>
        {:else}
          <p class="hint">Nothing here yet</p>
        {/each}
        </DragDropProvider>
        {#if !translating}
        <div class="pop-anchor">
          <button class="btn btn-sm add" type="button" aria-expanded={picker === id} onclick={() => (picker = picker === id ? '' : id)}>Add block</button>
          {#if picker === id}
            <div class="popover block-picker">
              <div class="types">
                {#each field.types as type (type)}
                  <button class="type-card" type="button" value={type} onclick={() => { add(at, { _type: type, _id: newId('default') }); picker = ''; }}>{type}</button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
        {/if}
      </div>
    {:else if field.type === 'image' && translating}
      <!-- A translation owns the words and not the picture: the alt, and nothing else. -->
      {@render groupLabel(id, field, text, at)}
      <div class="media-card" role="group" aria-labelledby="{id}-l">
        <span class="thumb" style="aspect-ratio: {aspect(field.preset)}"><img src={src(at)} alt="" /><span class="focal" aria-hidden="true"></span></span>
        <div class="meta">
          <div><div class="sub">{str([...at, 'src'])}</div></div>
          {@render altField(id, at)}
          <p class="hint">The picture is the same in every language.</p>
        </div>
      </div>
    {:else if field.type === 'image' && read(at) !== undefined}
      {@render groupLabel(id, field, text, at)}
      <div class="media-card" role="group" aria-labelledby="{id}-l">
        <span class="thumb" style="aspect-ratio: {aspect(field.preset)}"><img src={src(at)} alt="" /><span class="focal" aria-hidden="true"></span></span>
        <div class="meta">
          <div><div class="sub">{str([...at, 'src'])} · {num([...at, 'width'])} × {num([...at, 'height'])}</div></div>
          {@render altField(id, at)}
          <div class="actions">
            <button class="btn btn-sm" type="button" disabled title="Moving the focal point ships with the media library in Phase 4">Set focal point</button>
            <button class="btn btn-sm" type="button" onclick={() => (picker = id)}>Replace</button>
            <button class="btn btn-sm btn-ghost" type="button" onclick={() => write(at, undefined)}>Remove</button>
          </div>
          {#if field.preset.ratio}<p class="hint">Shown at {field.preset.ratio} wherever this field appears.</p>{/if}
        </div>
      </div>
    {:else if field.type === 'image'}
      {@render groupLabel(id, field, text, at)}
      <!-- svelte-ignore a11y_no_static_element_interactions -- the button inside is the control; the zone is a drop target -->
      <div class="dropzone" role="group" aria-labelledby="{id}-l" aria-describedby={says} ondragover={(e) => e.preventDefault()} ondrop={(e) => dropOn(id, e)}>
        <span>Drop an image or choose from library</span>
        {#if field.preset.ratio || field.preset.min}<span class="hint">{[field.preset.ratio, field.preset.min && `at least ${field.preset.min} px wide`].filter(Boolean).join(' · ')}</span>{/if}
        <span class="hint">JPEG, PNG or WebP · saved at up to {field.preset.max ?? 2400} px wide</span>
        <button class="btn btn-sm" type="button" onclick={() => (picker = id)}>Choose from library</button>
      </div>
    {:else if field.type === 'file' && translating}
      <!-- The download is one file for every language; what it is called is not. -->
      {@render groupLabel(id, field, text, at)}
      <div class="media-card is-file" role="group" aria-labelledby="{id}-l">
        <div class="file-icon" aria-hidden="true">{(str([...at, 'mime']).split('/').pop() ?? '').toUpperCase()}</div>
        <div class="meta">
          <div><div class="sub">{str([...at, 'src'])}</div></div>
          {@render nameField(id, at)}
          <p class="hint">The same file in every language.</p>
        </div>
      </div>
    {:else if field.type === 'file' && read(at) !== undefined}
      {@render groupLabel(id, field, text, at)}
      <div class="media-card is-file" role="group" aria-labelledby="{id}-l">
        <div class="file-icon" aria-hidden="true">{(str([...at, 'mime']).split('/').pop() ?? '').toUpperCase()}</div>
        <div class="meta">
          <div><div class="sub">{str([...at, 'src'])} · {bytes(at)} · {str([...at, 'mime'])}</div></div>
          {@render nameField(id, at)}
          <div class="actions">
            <button class="btn btn-sm" type="button" onclick={() => (picker = id)}>Replace</button>
            <button class="btn btn-sm btn-ghost" type="button" onclick={() => write(at, undefined)}>Remove</button>
          </div>
        </div>
      </div>
    {:else if field.type === 'file'}
      {@render groupLabel(id, field, text, at)}
      <!-- svelte-ignore a11y_no_static_element_interactions -- the button inside is the control; the zone is a drop target -->
      <div class="dropzone" role="group" aria-labelledby="{id}-l" aria-describedby={says} ondragover={(e) => e.preventDefault()} ondrop={(e) => dropOn(id, e)}>
        <span>Drop a file or choose from library</span>
        <span class="hint">{field.accept.map((m) => (m.split('/').pop() ?? '').toUpperCase()).join(', ')} up to 10 MB</span>
        <button class="btn btn-sm" type="button" onclick={() => (picker = id)}>Choose from library</button>
      </div>
    {:else if field.type === 'reference'}
      {@render groupLabel(id, field, text, at)}
      {#if picker === id}
        <PagePicker {id} label={text} labelId="{id}-l" collection={field.collection} chosen={str(at)} onpick={(e) => { write(at, e.path); picker = ''; }} onclose={() => (picker = '')} />
      {:else if str(at)}
        {@render chosenEntry(id, `${id}-l`, says, str(at), () => (picker = id))}
      {:else}
        {@render noEntry(id, `${id}-l`, says, text, () => (picker = id))}
      {/if}
    {:else if field.type === 'embed' || field.type === 'seo'}
      {@render groupLabel(id, field, text, at)}
      <div class="readonly" {id} role="region" tabindex="-1" aria-labelledby="{id}-l" aria-describedby={err ? `${id}-hint ${id}-err` : `${id}-hint`}><pre>{read(at) === undefined ? 'Nothing here yet' : JSON.stringify(read(at), null, 2)}</pre></div>
      <p class="hint" id="{id}-hint">{WHEN[field.type]}</p>
    {:else}
      <div class="label-row"><label for={id}>{text}</label></div>
      <p class="hint" {id}>Not editable here yet</p>
    {/if}
    {#if err}<p class="error" id="{id}-err">{err}</p>{/if}
    {#if picker === id && (field.type === 'image' || field.type === 'file')}
      <Media
        kind={field.type === 'image' ? 'images' : 'files'}
        label={text}
        preset={field.type === 'image' ? field.preset : {}}
        accept={field.type === 'file' ? field.accept : []}
        base={mediaBase}
        {dropped}
        onpick={(item) => picked(at, field.type as 'image' | 'file', item)}
        onclose={() => { picker = ''; dropped = []; }}
      />
    {/if}
  </div>
{/each}
