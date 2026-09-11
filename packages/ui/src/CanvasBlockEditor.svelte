<script lang="ts" module>
import type { Field } from '@handover/core';

type Data = Record<string, unknown>;

const object = (value: unknown): value is Data =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const read = (root: unknown, path: readonly string[]) =>
  path.reduce<unknown>((value, key) => (object(value) ? value[key] : undefined), root);

const filled = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

function requiredProblems(fields: readonly Field[], root: unknown, prefix: readonly string[] = []) {
  const problems: Record<string, string> = {};
  for (const field of fields) {
    if (field.type === 'unsupported') {
      continue;
    }
    const path = [...prefix, ...field.path];
    const value = read(root, field.path);
    if (field.type === 'group') {
      if (value !== undefined || field.required)
        Object.assign(problems, requiredProblems(field.fields, object(value) ? value : {}, path));
      continue;
    }
    if (!field.required) continue;
    const present =
      field.type === 'text' || field.type === 'richtext' || field.type === 'date'
        ? filled(value)
        : field.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : field.type === 'boolean'
            ? typeof value === 'boolean'
            : field.type === 'select'
              ? typeof value === 'string' && field.options.includes(value)
              : field.type === 'reference'
                ? filled(value)
                : field.type === 'array' || field.type === 'blocks' || field.type === 'menus'
                  ? Array.isArray(value)
                  : field.type === 'image' || field.type === 'file'
                    ? object(value) && filled(value.src)
                    : field.type === 'link'
                      ? object(value) &&
                        ((value.type === 'entry' && filled(value.ref)) ||
                          (value.type === 'url' && filled(value.href)))
                      : object(value);
    if (!present) problems[path.join('.')] = `${field.label || 'This field'} is required`;
  }
  return problems;
}

export const canvasBlockProblems = (fields: readonly Field[], root: unknown) =>
  requiredProblems(fields, root);

export function canvasBlockDraft(type: string, id: string, fields: readonly Field[]) {
  const draft: Data = { _type: type, _id: id };
  for (const field of fields) {
    if (field.type === 'unsupported' || !field.required || !field.path.length) continue;
    let value: unknown;
    if (field.type === 'boolean') value = false;
    else if (field.type === 'array' || field.type === 'blocks' || field.type === 'menus')
      value = [];
    else if (field.type === 'group') {
      const group = canvasBlockDraft('', '', field.fields);
      delete group._type;
      delete group._id;
      value = group;
    }
    if (value === undefined) continue;
    let node = draft;
    for (const key of field.path.slice(0, -1)) {
      if (!object(node[key])) node[key] = {};
      node = node[key] as Data;
    }
    node[field.path.at(-1) as string] = value;
  }
  return draft;
}
</script>

<script lang="ts">
import { newId, type Field as BlockField } from '@handover/core';
import { tick } from 'svelte';
import CanvasIcon from './CanvasIcon.svelte';
import type { ListCommandResult } from './entry-session.svelte';
import Fields from './Fields.svelte';

let {
  mode,
  types,
  blocks,
  currentType,
  mediaBase = '',
  locale,
  site,
  servedAt,
  locked = false,
  onapply,
  onclose,
}: {
  mode: 'insert' | 'replace';
  types: readonly string[];
  blocks: Record<string, BlockField[]>;
  currentType?: string;
  mediaBase?: string;
  locale: string;
  site?: string;
  servedAt?: string;
  locked?: boolean;
  onapply: (value: Record<string, unknown>) => ListCommandResult;
  onclose: () => void;
} = $props();

const offered = $derived(types.filter((type) => blocks[type] !== undefined));
let chosen = $state('');
let draft = $state<Record<string, unknown>>({});
let refusal = $state('');
let panel = $state<HTMLElement>();
const fields = $derived(blocks[chosen] ?? []);
const problems = $derived(chosen ? canvasBlockProblems(fields, draft) : {});
const ready = $derived(chosen && Object.keys(problems).length === 0 && !locked);

$effect(() => {
  void tick().then(() => panel?.focus());
});

function choose(type: string) {
  if (!offered.includes(type)) return;
  chosen = type;
  draft = canvasBlockDraft(type, newId('default'), blocks[type] ?? []);
  refusal = '';
}

function apply() {
  if (!ready) return;
  const result = onapply($state.snapshot(draft));
  refusal = result.ok ? '' : result.reason;
  if (result.ok) onclose();
}
</script>

<section
  class="canvas-block-editor"
  aria-labelledby="canvas-block-editor-heading"
  tabindex="-1"
  bind:this={panel}
>
  <header>
    <button class="btn btn-ghost btn-sm canvas-block-editor-back" type="button" aria-label="Back to Structure" onclick={onclose}><CanvasIcon name="back" /></button>
    <div>
      <span class="badge">Block</span>
      <h2 id="canvas-block-editor-heading">{mode === 'replace' ? 'Replace block' : 'Add block'}</h2>
    </div>
  </header>

  {#if mode === 'replace' && currentType}
    <p class="canvas-block-context">Replacing <strong>{currentType}</strong>. Fields are not converted between block types.</p>
  {/if}

  {#if !chosen}
    <div class="canvas-block-picker" role="list" aria-label="Allowed block types">
      {#each offered as type (type)}
        <button class="type-card" type="button" disabled={locked} onclick={() => choose(type)}>
          <strong>{type}</strong>
          <span>Add and configure this block</span>
        </button>
      {:else}
        <p class="canvas-inspector-message">This list has no configurable block types.</p>
      {/each}
    </div>
  {:else}
    <div class="canvas-block-editor-type">
      <strong>{chosen}</strong>
      <button class="btn btn-ghost btn-sm" type="button" onclick={() => (chosen = '')}>Change type</button>
    </div>
    {#if refusal}
      <p class="notice notice-danger" role="alert">This block was not applied ({refusal}).</p>
    {/if}
    <form class="form canvas-inspector-form" onsubmit={(event) => { event.preventDefault(); apply(); }}>
      <fieldset disabled={locked}>
        <Fields
          {fields}
          bind:root={draft}
          {blocks}
          {problems}
          {mediaBase}
          {locale}
          {site}
          {servedAt}
          prefix="canvas-block"
        />
      </fieldset>
      {#if Object.keys(problems).length}
        <p class="hint" role="status">Complete the required fields before applying this block.</p>
      {/if}
      <div class="actions canvas-block-editor-actions">
        <button class="btn" type="button" onclick={onclose}>Cancel</button>
        <button class="btn btn-primary" type="submit" disabled={!ready}>Apply</button>
      </div>
    </form>
  {/if}
</section>
