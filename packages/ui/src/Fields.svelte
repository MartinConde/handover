<script lang="ts">
import { type Field, newId } from '@handover/core';
import Fields from './Fields.svelte';
import RichText from './RichText.svelte';

type Data = Record<string, unknown>;
let {
  fields,
  root = $bindable(),
  path = [],
  blocks = {},
  label = '',
}: {
  fields: readonly Field[];
  root: Data;
  path?: readonly string[];
  /** Fields per block type, keyed as `formOf` returns them. */
  blocks?: Record<string, Field[]>;
  /** Names a field whose own path is empty — one scalar row of an array. */
  label?: string;
} = $props();

// One picker at a time per form level; the field id says which is open.
let picker = $state('');

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
function move(at: readonly string[], from: number, to: number) {
  const items = list(at);
  items.splice(to, 0, ...items.splice(from, 1));
}
const drop = (at: readonly string[], index: number) => list(at).splice(index, 1);

const block = (row: unknown) =>
  row as { _type?: string; _id?: string; _label?: string; _ref?: string };
// A `_ref` block's content lives in a global, and an unknown `_type` has no fields to show;
// both are the same read-only card.
const blockName = (row: unknown) => block(row)._label || block(row)._type || '';
const blockFields = (row: unknown) =>
  block(row)._ref === undefined ? blocks[block(row)._type ?? ''] : undefined;

const linkType = (at: readonly string[]) => (read([...at, 'type']) === 'url' ? 'url' : 'entry');
function setLinkType(at: readonly string[], type: 'url' | 'entry') {
  write([...at, 'type'], type);
  write([...at, type === 'url' ? 'ref' : 'href'], undefined);
}
</script>

{#snippet groupLabel(id: string, field: Field, text: string)}
  <div class="label-row"><span id="{id}-l">{text}{#if 'required' in field && field.required}<span class="req" aria-hidden="true">*</span>{/if}</span></div>
{/snippet}

{#snippet controls(at: readonly string[], i: number, count: number, name: string)}
  <div class="row-controls">
    <button class="btn btn-ghost btn-icon" type="button" aria-label="Move {name} up" disabled={i === 0} onclick={() => move(at, i, i - 1)}>↑</button>
    <button class="btn btn-ghost btn-icon" type="button" aria-label="Move {name} down" disabled={i === count - 1} onclick={() => move(at, i, i + 1)}>↓</button>
    <button class="btn btn-ghost btn-icon" type="button" aria-label="Remove {name}" onclick={() => drop(at, i)}>×</button>
  </div>
{/snippet}

{#snippet labelRow(id: string, field: Field, text: string)}
  <div class="label-row">
    <label for={id}>{text}{#if 'required' in field && field.required}<span class="req" aria-hidden="true">*</span>{/if}</label>
  </div>
{/snippet}

{#each fields as field (field.path.join('.'))}
  {@const at = [...path, ...field.path]}
  {@const id = `f-${at.join('.')}`}
  {@const text = capitalise(field.path[0] ?? '') || label}
  <div class="field">
    {#if field.type === 'text'}
      {@render labelRow(id, field, text)}
      {#if str(at).length > 80 || str(at).includes('\n')}
        <textarea class="input textarea" {id} value={str(at)} oninput={(e) => write(at, e.currentTarget.value)}></textarea>
      {:else}
        <input class="input" {id} type="text" value={str(at)} oninput={(e) => write(at, e.currentTarget.value)} />
      {/if}
    {:else if field.type === 'number'}
      {@render labelRow(id, field, text)}
      <input class="input" {id} type="number" step="any" value={num(at)} oninput={(e) => write(at, e.currentTarget.value === '' ? undefined : e.currentTarget.valueAsNumber)} />
    {:else if field.type === 'boolean'}
      <label class="switch" for={id}><input type="checkbox" role="switch" {id} checked={read(at) === true} onchange={(e) => write(at, e.currentTarget.checked)} /><span>{text}</span></label>
    {:else if field.type === 'date'}
      {@render labelRow(id, field, text)}
      <input class="input" {id} type="date" value={str(at)} oninput={(e) => write(at, e.currentTarget.value || undefined)} />
    {:else if field.type === 'select'}
      {#if field.options.length <= 5}
        <fieldset>
          <legend>{text}{#if field.required}<span class="req" aria-hidden="true">*</span>{/if}</legend>
          {#each field.options as option (option)}
            <label class="choice"><input type="radio" name={id} value={option} checked={read(at) === option} onchange={() => write(at, option)} /><span>{capitalise(option)}</span></label>
          {/each}
        </fieldset>
      {:else}
        {@render labelRow(id, field, text)}
        <select class="input" {id} value={str(at)} onchange={(e) => write(at, e.currentTarget.value || undefined)}>
          <option value="">Choose…</option>
          {#each field.options as option (option)}
            <option value={option}>{capitalise(option)}</option>
          {/each}
        </select>
      {/if}
    {:else if field.type === 'link'}
      {@render groupLabel(id, field, text)}
      <div class="seg" role="group" aria-label="Link type">
        <button type="button" aria-pressed={linkType(at) === 'entry'} onclick={() => setLinkType(at, 'entry')}>Page / Entry</button>
        <button type="button" aria-pressed={linkType(at) === 'url'} onclick={() => setLinkType(at, 'url')}>URL</button>
      </div>
      {#if linkType(at) === 'url'}
        <div class="field"><div class="label-row"><label for="{id}.href">URL</label></div><input class="input" id="{id}.href" type="url" value={str([...at, 'href'])} oninput={(e) => { write([...at, 'type'], 'url'); write([...at, 'href'], e.currentTarget.value); }} /></div>
      {:else}
        <div class="field"><div class="label-row"><label for="{id}.ref">Page or entry</label></div><input class="input" id="{id}.ref" type="text" placeholder="listings/mill-house" value={str([...at, 'ref'])} oninput={(e) => { write([...at, 'type'], 'entry'); write([...at, 'ref'], e.currentTarget.value); }} /></div>
      {/if}
      <div class="field"><div class="label-row"><label for="{id}.label">Label</label></div><input class="input" id="{id}.label" type="text" value={str([...at, 'label'])} oninput={(e) => write([...at, 'label'], e.currentTarget.value || undefined)} /></div>
      <label class="check" for="{id}.newTab"><input type="checkbox" id="{id}.newTab" checked={read([...at, 'newTab']) === true} onchange={(e) => write([...at, 'newTab'], e.currentTarget.checked || undefined)} /><span>Open in new tab</span></label>
    {:else if field.type === 'richtext'}
      {@render groupLabel(id, field, text)}
      <RichText {id} labelId="{id}-l" tier={field.tier} value={str(at)} onchange={(md) => write(at, md)} />
    {:else if field.type === 'group'}
      <details class="group" open>
        <summary>{text}<span class="count">{field.fields.length} fields</span></summary>
        <div class="form"><Fields fields={field.fields} bind:root {blocks} path={at} /></div>
      </details>
    {:else if field.type === 'array'}
      {@const items = rows(at)}
      {@const scalar = field.item.length === 1 && field.item[0]?.path.length === 0}
      {@render groupLabel(id, field, text)}
      <div class="list" {id} role="group" aria-labelledby="{id}-l">
        {#each items as row, i ((row as Data)?._id ?? i)}
          <div class="row-card">
            <div class="row-fields"><Fields fields={field.item} bind:root {blocks} path={[...at, String(i)]} label="{text} {i + 1}" /></div>
            {@render controls(at, i, items.length, `${text} row ${i + 1}`)}
          </div>
        {:else}
          <p class="hint">Nothing here yet</p>
        {/each}
        <button class="btn btn-sm add" type="button" onclick={() => add(at, scalar ? '' : { _id: newId('default') })}>Add to {text}</button>
      </div>
    {:else if field.type === 'blocks'}
      {@const items = rows(at)}
      {@render groupLabel(id, field, text)}
      <div class="list" {id} role="group" aria-labelledby="{id}-l">
        {#each items as row, i (block(row)._id ?? i)}
          {@const name = blockName(row)}
          {@const inner = blockFields(row)}
          <article class="block-card" id="{id}.{i}" aria-labelledby="{id}.{i}-h">
            <header>
              <span class="label" id="{id}.{i}-h">{name}</span>
              <span class="type">{block(row)._type} · {block(row)._id}</span>
              {@render controls(at, i, items.length, name)}
            </header>
            {#if inner}
              <div class="form"><Fields fields={inner} bind:root {blocks} path={[...at, String(i)]} /></div>
            {:else}
              <p class="ref-note">{block(row)._ref ?? `No “${block(row)._type}” block in the registry`} — not editable here</p>
            {/if}
          </article>
        {:else}
          <p class="hint">Nothing here yet</p>
        {/each}
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
      </div>
    {:else if field.type === 'image' || field.type === 'file' || field.type === 'embed' || field.type === 'seo' || field.type === 'reference'}
      {@render groupLabel(id, field, text)}
      <div class="readonly" {id} role="region" aria-labelledby="{id}-l"><pre>{read(at) === undefined ? 'Nothing here yet' : JSON.stringify(read(at), null, 2)}</pre></div>
    {:else}
      <div class="label-row"><label for={id}>{text}</label></div>
      <p class="hint" {id}>Not editable here yet</p>
    {/if}
  </div>
{/each}
