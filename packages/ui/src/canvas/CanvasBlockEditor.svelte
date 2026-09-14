<script lang="ts" module>
import type { Field } from '@handover/core';
import { requiredFieldProblems } from '../editor/required-fields';

type Data = Record<string, unknown>;

const object = (value: unknown): value is Data =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const canvasBlockProblems = requiredFieldProblems;

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
import type { ListCommandResult } from '../editor/entry-session.svelte';
import Fields from '../editor/fields/Fields.svelte';
import { messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';

let {
  mode,
  types,
  blocks,
  currentType,
  mediaBase = '',
  locale,
  uiLocale = 'en',
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
  uiLocale?: UiLocale;
  site?: string;
  servedAt?: string;
  locked?: boolean;
  onapply: (value: Record<string, unknown>) => ListCommandResult;
  onclose: (reason?: 'applied') => void;
} = $props();

const offered = $derived(types.filter((type) => blocks[type] !== undefined));
const options = $derived(messageOptions(uiLocale));
let chosen = $state('');
let draft = $state<Record<string, unknown>>({});
let refusal = $state('');
let panel = $state<HTMLElement>();
const fields = $derived(blocks[chosen] ?? []);
const problems = $derived(chosen ? canvasBlockProblems(fields, draft, blocks) : {});
const ready = $derived(chosen && Object.keys(problems).length === 0 && !locked);
const refusalText = $derived.by(() => {
  if (refusal === 'stale') return m.canvas_action_stale({}, options);
  if (refusal === 'deleted') return m.canvas_action_deleted({}, options);
  if (refusal === 'readonly' || refusal === 'closed') return m.canvas_action_readonly({}, options);
  return m.canvas_action_structure_changed({}, options);
});

$effect(() => {
  void tick().then(() => panel?.focus());
});

function choose(type: string) {
  if (!offered.includes(type)) return;
  const next = canvasBlockDraft(type, newId('default'), blocks[type] ?? []);
  if (mode === 'insert') {
    const result = onapply(next);
    refusal = result.ok ? '' : result.reason;
    if (result.ok) onclose('applied');
    return;
  }
  chosen = type;
  draft = next;
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
    <button class="btn btn-ghost btn-sm canvas-block-editor-back" type="button" aria-label={m.canvas_back_to_structure({}, options)} onclick={() => onclose()}><CanvasIcon name="back" /></button>
    <div>
      <span class="badge">{m.canvas_type_block({}, options)}</span>
      <h2 id="canvas-block-editor-heading">{mode === 'replace' ? m.canvas_replace_block({}, options) : m.canvas_add_block({}, options)}</h2>
    </div>
  </header>

  {#if mode === 'replace' && currentType}
    <p class="canvas-block-context">{m.canvas_replacing_block({ type: currentType }, options)}</p>
  {/if}

  {#if refusal}
    <p class="notice notice-danger" role="alert">{refusalText}</p>
  {/if}

  {#if !chosen}
    <div class="canvas-block-picker" role="list" aria-label={m.canvas_allowed_block_types({}, options)}>
      {#each offered as type (type)}
        <button class="type-card" type="button" disabled={locked} onclick={() => choose(type)}>
          <strong>{type}</strong>
          <span>{mode === 'insert' ? m.canvas_add_this_block({}, options) : m.canvas_configure_replacement({}, options)}</span>
        </button>
      {:else}
        <p class="canvas-inspector-message">{m.canvas_no_configurable_blocks({}, options)}</p>
      {/each}
    </div>
  {:else}
    <div class="canvas-block-editor-type">
      <strong>{chosen}</strong>
      <button class="btn btn-ghost btn-sm" type="button" onclick={() => (chosen = '')}>{m.canvas_change_type({}, options)}</button>
    </div>
    <form class="form canvas-inspector-form" onsubmit={(event) => { event.preventDefault(); apply(); }}>
      <fieldset disabled={locked}>
        <Fields
          {fields}
          bind:root={draft}
          {blocks}
          {problems}
          {mediaBase}
          {locale}
          {uiLocale}
          {site}
          {servedAt}
          prefix="canvas-block"
        />
      </fieldset>
      {#if Object.keys(problems).length}
        <p class="hint" role="status">{m.canvas_complete_block_fields({}, options)}</p>
      {/if}
      <div class="actions canvas-block-editor-actions">
        <button class="btn" type="button" onclick={() => onclose()}>{m.common_cancel({}, options)}</button>
        <button class="btn btn-primary" type="submit" disabled={!ready}>{m.canvas_apply({}, options)}</button>
      </div>
    </form>
  {/if}
</section>
