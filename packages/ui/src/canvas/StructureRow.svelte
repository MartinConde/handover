<script lang="ts">
import { createSortable } from '@dnd-kit/svelte/sortable';
import type { Snippet } from 'svelte';
import type { messageOptions } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import CanvasIcon from './CanvasIcon.svelte';
import type { CanvasBlockAction, CanvasStructureNode } from './canvas-bridge';
import { canvasNodeKey } from './canvas-structure';

let {
  node,
  depth,
  posinset,
  setsize,
  branch,
  shut,
  isSelected,
  focused,
  label,
  icon,
  treeDomId,
  options,
  structureOrder,
  structureIndex,
  blockLocation,
  blockActionsFor,
  onselect,
  ontoggle,
  onrowkeydown,
  onrowfocus,
  children,
}: {
  node: CanvasStructureNode;
  depth: number;
  posinset: number;
  setsize: number;
  branch: boolean;
  shut: boolean;
  isSelected: boolean;
  focused: boolean;
  label: string;
  icon: string;
  treeDomId: string;
  options: ReturnType<typeof messageOptions>;
  structureOrder: readonly string[];
  structureIndex: (node: CanvasStructureNode) => number | undefined;
  blockLocation: (node: CanvasStructureNode) => { address: string } | undefined;
  blockActionsFor: (node: CanvasStructureNode) => CanvasBlockAction[];
  onselect: (node: CanvasStructureNode) => void;
  ontoggle: (node: CanvasStructureNode) => void;
  onrowkeydown: (
    event: KeyboardEvent,
    node: CanvasStructureNode,
    branch: boolean,
    shut: boolean,
  ) => void;
  onrowfocus: (node: CanvasStructureNode) => void;
  children?: Snippet;
} = $props();

const key = $derived(canvasNodeKey(node));
const movable = $derived(blockActionsFor(node).includes('move'));
const outsideDragList = $derived(structureOrder.length > 0 && !structureOrder.includes(key));
const labelId = $derived(`${treeDomId}-label-${node.id}`);

function activate(target: Element) {
  if (branch && (node.container || target.closest('.canvas-structure-twisty'))) ontoggle(node);
  else onselect(node);
}

// Created once per row; the getters keep it current without rebuilding the Sortable.
const sortable = createSortable({
  get id() {
    return canvasNodeKey(node);
  },
  get index() {
    return structureIndex(node) ?? 0;
  },
  get group() {
    return blockLocation(node)?.address;
  },
  get type() {
    return blockLocation(node)?.address;
  },
  get accept() {
    return blockLocation(node)?.address ?? [];
  },
  get disabled() {
    return !movable;
  },
  transition: { duration: 200 },
});
</script>

<!-- aria-labelledby points at the row's own label span, or the nested group's text joins the name. -->
<div class="canvas-structure-branch" {@attach movable ? sortable.attach : undefined}>
  <div
    role="treeitem"
    class={{ 'is-branch': branch }}
    aria-level={depth}
    aria-posinset={posinset}
    aria-setsize={setsize}
    aria-selected={isSelected}
    aria-expanded={branch ? !shut : undefined}
    aria-current={isSelected ? 'true' : undefined}
    aria-labelledby={labelId}
    data-target-address={node.target.occurrence?.address ?? node.target.address}
    data-tree-key={key}
    tabindex={focused ? 0 : -1}
    onfocus={() => onrowfocus(node)}
    onclick={(event) => {
      const target = event.target as Element;
      if (target.closest('.canvas-structure-drag')) return;
      if (target.closest('.canvas-structure-row')?.parentElement !== event.currentTarget) return;
      activate(target);
    }}
    onkeydown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate(event.currentTarget as Element);
        return;
      }
      onrowkeydown(event, node, branch, shut);
    }}
  >
    <div
      class={['canvas-structure-row', { 'is-outside-drag-list': outsideDragList }]}
      style={`--canvas-indent:${7 + (depth - 1) * 12}px`}
      {@attach movable ? sortable.attachTarget : undefined}
    >
      <span id={labelId} class="canvas-structure-label">
        {#if branch}
          <span class="canvas-structure-twisty" aria-hidden="true"
            ><CanvasIcon name={shut ? 'chevron-right' : 'chevron-down'} /></span
          >
        {:else}
          <span class="canvas-structure-twisty is-leaf" aria-hidden="true"></span>
        {/if}
        <span class="canvas-structure-kind" aria-hidden="true"><CanvasIcon name={icon} /></span>
        <span class="canvas-structure-name">{label}</span>
        {#if node.empty}<small>{m.canvas_empty({}, options)}</small>{/if}
        {#if node.occurrences > 1}<small>{node.occurrences}×</small>{/if}
      </span>
      {#if movable}
        <button
          class="canvas-structure-drag"
          type="button"
          {@attach sortable.attachHandle}
          tabindex={focused ? 0 : -1}
          aria-label={m.canvas_selection_drag({ label }, options)}
          title={m.canvas_selection_drag({ label }, options)}><CanvasIcon name="grip" /></button
        >
      {/if}
    </div>
    {#if branch && !shut}
      <div role="group">{@render children?.()}</div>
    {/if}
  </div>
</div>
