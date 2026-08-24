<script lang="ts">
import { type Field, fieldAddress, newId, type Translation } from '@handover/core';
import Fields from './Fields.svelte';
import RichText from './RichText.svelte';

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
} = $props();

const modeOf = (field: Field): Translation => field.i18n ?? inherited;
// A group, an array or a blocks field is walked whatever its own mode says, because a field
// inside it can say otherwise.
const structural = (field: Field) =>
  field.type === 'group' || field.type === 'array' || field.type === 'blocks';
// Widgets that only show what is stored. Their translated half — an image's alt, a file's
// name — has no editor before Phase 3, so the second language is not given a picture of the
// first language's value it cannot act on.
const FIXED = new Set(['image', 'file', 'embed', 'seo', 'reference', 'unsupported']);
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

// A read-only field that says nothing reads as a broken one, so each names the release its
// editor arrives in.
const WHEN: Record<'image' | 'file' | 'embed' | 'seo' | 'reference', string> = {
  image: 'Images can be changed from Phase 3. Shown as stored.',
  file: 'Files can be changed from Phase 3. Shown as stored.',
  embed: 'Embeds can be changed from Phase 4. Shown as stored.',
  seo: 'SEO settings can be changed from Phase 4. Shown as stored.',
  reference: 'References can be changed from Phase 2. Shown as stored.',
};

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

{#snippet controls(at: readonly string[], i: number, count: number, name: string)}
  <div class="row-controls">
    <button class="btn btn-ghost btn-icon" type="button" aria-label="Move {name} up" disabled={i === 0} onclick={() => move(at, i, i - 1)}>↑</button>
    <button class="btn btn-ghost btn-icon" type="button" aria-label="Move {name} down" disabled={i === count - 1} onclick={() => move(at, i, i + 1)}>↓</button>
    <button class="btn btn-ghost btn-icon" type="button" aria-label="Remove {name}" onclick={() => drop(at, i)}>×</button>
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
        <div class="field"><div class="label-row"><label for="{id}.href">URL</label></div><input class="input" id="{id}.href" type="url" value={str([...at, 'href'])} oninput={(e) => { write([...at, 'type'], 'url'); write([...at, 'href'], e.currentTarget.value); }} /></div>
      {:else}
        <div class="field"><div class="label-row"><label for="{id}.ref">Page or entry</label></div><input class="input" id="{id}.ref" type="text" placeholder="listings/mill-house" value={str([...at, 'ref'])} oninput={(e) => { write([...at, 'type'], 'entry'); write([...at, 'ref'], e.currentTarget.value); }} /></div>
      {/if}
      <div class="field"><div class="label-row"><label for="{id}.label">Label</label></div><input class="input" id="{id}.label" type="text" value={str([...at, 'label'])} oninput={(e) => write([...at, 'label'], e.currentTarget.value || undefined)} /></div>
      <label class="check" for="{id}.newTab"><input type="checkbox" id="{id}.newTab" checked={read([...at, 'newTab']) === true} onchange={(e) => write([...at, 'newTab'], e.currentTarget.checked || undefined)} /><span>Open in new tab</span></label>
    {:else if field.type === 'richtext'}
      {@render groupLabel(id, field, text, at)}
      <RichText {id} labelId="{id}-l" tier={field.tier} invalid={!!err} describedby={says} value={str(at)} onchange={(md) => write(at, md)} />
    {:else if field.type === 'group'}
      <details class="group" open>
        <summary>{text}<span class="count">{field.fields.length} fields</span></summary>
        <div class="form"><Fields fields={field.fields} bind:root {blocks} {problems} path={at} {translating} {machine} {ontranslate} {prefix} inherited={mode} /></div>
      </details>
    {:else if field.type === 'array'}
      {@const items = rows(at)}
      {@const scalar = field.item.length === 1 && field.item[0]?.path.length === 0}
      {@render groupLabel(id, field, text, at)}
      <div class="list" {id} role="group" aria-labelledby="{id}-l">
        {#each items as row, i ((row as Data)?._id ?? i)}
          <div class="row-card">
            <div class="row-fields"><Fields fields={field.item} bind:root {blocks} {problems} path={[...at, String(i)]} rowLabel="{text} {i + 1}" {translating} {machine} {ontranslate} {prefix} inherited={mode} /></div>
            {#if !translating}{@render controls(at, i, items.length, `${text} row ${i + 1}`)}{/if}
          </div>
        {:else}
          <p class="hint">Nothing here yet</p>
        {/each}
        {#if !translating}<button class="btn btn-sm add" type="button" onclick={() => add(at, scalar ? '' : { _id: newId('default') })}>Add to {text}</button>{/if}
      </div>
    {:else if field.type === 'blocks'}
      {@const items = rows(at)}
      {@render groupLabel(id, field, text, at)}
      <div class="list" {id} role="group" aria-labelledby="{id}-l">
        {#each items as row, i (block(row)._id ?? i)}
          {@const name = blockName(row)}
          {@const inner = blockFields(row)}
          <article class="block-card" id="{id}.{i}" aria-labelledby="{id}.{i}-h">
            <header>
              <span class="label" id="{id}.{i}-h">{name}</span>
              <span class="type">{block(row)._type} · {block(row)._id}</span>
              {#if !translating}{@render controls(at, i, items.length, name)}{/if}
            </header>
            {#if inner}
              <div class="form"><Fields fields={inner} bind:root {blocks} {problems} path={[...at, String(i)]} {translating} {machine} {ontranslate} {prefix} inherited={mode} /></div>
            {:else}
              <p class="ref-note">{block(row)._ref ?? `No “${block(row)._type}” block in the registry`} — not editable here</p>
            {/if}
          </article>
        {:else}
          <p class="hint">Nothing here yet</p>
        {/each}
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
    {:else if field.type === 'image' || field.type === 'file' || field.type === 'embed' || field.type === 'seo' || field.type === 'reference'}
      {@render groupLabel(id, field, text, at)}
      <div class="readonly" {id} role="region" tabindex="-1" aria-labelledby="{id}-l" aria-describedby={err ? `${id}-hint ${id}-err` : `${id}-hint`}><pre>{read(at) === undefined ? 'Nothing here yet' : JSON.stringify(read(at), null, 2)}</pre></div>
      <p class="hint" id="{id}-hint">{WHEN[field.type]}</p>
    {:else}
      <div class="label-row"><label for={id}>{text}</label></div>
      <p class="hint" {id}>Not editable here yet</p>
    {/if}
    {#if err}<p class="error" id="{id}-err">{err}</p>{/if}
  </div>
{/each}
