<script lang="ts">
import { type DragDropEventHandlers, DragDropProvider } from '@dnd-kit/svelte';
import { isSortable } from '@dnd-kit/svelte/sortable';
import { tick, untrack } from 'svelte';
import { messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import CanvasIcon from './CanvasIcon.svelte';
import type {
  CanvasActionMessage,
  CanvasBlockAction,
  CanvasSelection,
  CanvasStructureNode,
} from './canvas-bridge';
import type { CanvasStructureIndex } from './canvas-structure';
import { canvasNodeKey, visibleCanvasNodes } from './canvas-structure';
import { sameCanvasSelection } from './canvas-target';
import StructureRow from './StructureRow.svelte';

let {
  treeDomId,
  structure,
  selected,
  selectedNode,
  index,
  treeLabel,
  session,
  locale,
  uiLocale,
  interactionMode,
  insertionNode,
  blockLocation,
  blockActionsFor,
  onselectnode,
  onaction,
  oninsert,
  onclose,
  addBlockButton = $bindable(),
}: {
  treeDomId: string;
  structure: CanvasStructureNode[];
  selected: CanvasSelection | undefined;
  selectedNode: CanvasStructureNode | undefined;
  index: CanvasStructureIndex;
  treeLabel: (node: CanvasStructureNode) => string;
  session: import('../editor/entry-session.svelte').EntrySession;
  locale: string;
  uiLocale: UiLocale;
  interactionMode: 'edit' | 'interact';
  insertionNode: CanvasStructureNode | undefined;
  blockLocation: (node: CanvasStructureNode) => { address: string; index: number } | undefined;
  blockActionsFor: (node: CanvasStructureNode) => CanvasBlockAction[];
  onselectnode: (node: CanvasStructureNode) => void;
  onaction: (message: Pick<CanvasActionMessage, 'action' | 'destination' | 'selection'>) => void;
  oninsert: (kind: 'insert-empty' | 'insert-after', node: CanvasStructureNode) => void;
  onclose: () => void;
  addBlockButton?: HTMLButtonElement;
} = $props();

const options = $derived(messageOptions(uiLocale));

let root = $state<HTMLElement>();
let collapsed = $state.raw<Record<string, boolean>>({});
let structureOrder = $state.raw<string[]>([]);

const visibleStructure = $derived(
  visibleCanvasNodes(structure, collapsed).filter((node) => !index.hiddenWrappers.has(node.id)),
);
let focusedTreeKey = $state('');
const treeFocusKey = $derived.by(() => {
  if (visibleStructure.some((node) => canvasNodeKey(node) === focusedTreeKey))
    return focusedTreeKey;
  const first = treeChildren()[0];
  return first ? canvasNodeKey(first) : '';
});

// blockLocation is computed once per node here, not once per comparison in the sort below.
const sortKeys = $derived.by(() => {
  const map = new Map<string, number | undefined>();
  for (const node of structure) {
    const projected = structureOrder.indexOf(canvasNodeKey(node));
    map.set(canvasNodeKey(node), projected < 0 ? blockLocation(node)?.index : projected);
  }
  return map;
});

function treeChildren(parent?: CanvasStructureNode) {
  return visibleStructure
    .filter((node) => {
      let ancestor = index.parentOf(node);
      while (ancestor && index.hiddenWrappers.has(ancestor.id)) ancestor = index.parentOf(ancestor);
      return ancestor?.id === parent?.id;
    })
    .sort((a, b) => {
      const from = sortKeys.get(canvasNodeKey(a));
      const to = sortKeys.get(canvasNodeKey(b));
      return from === undefined || to === undefined ? 0 : from - to;
    });
}

function nodeIcon(node: CanvasStructureNode) {
  if (node.target.occurrence) return 'external';
  if (node.kind !== 'field') return node.kind === 'list' ? 'structure' : 'block';
  const field = session.inspectField(locale, node.target.address);
  return field.ok && ['image', 'file'].includes(field.target.field.type) ? 'image' : 'text';
}

function toggleBranch(node: CanvasStructureNode) {
  const key = canvasNodeKey(node);
  collapsed = { ...collapsed, [key]: !collapsed[key] };
}

function focusTreeNode(node?: CanvasStructureNode) {
  if (!node) return;
  const key = canvasNodeKey(node);
  focusedTreeKey = key;
  void tick().then(() => {
    const item = Array.from(root?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []).find(
      (element) => element.dataset.treeKey === key,
    );
    item?.focus();
  });
}

function treeKeydown(
  event: KeyboardEvent,
  node: CanvasStructureNode,
  branch: boolean,
  shut: boolean,
) {
  const items = Array.from(root?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
  const rowIndex = items.findIndex((item) => item.dataset.treeKey === canvasNodeKey(node));
  const visible = visibleStructure.find(
    (candidate) => canvasNodeKey(candidate) === items[rowIndex + 1]?.dataset.treeKey,
  );
  let destination: CanvasStructureNode | undefined;
  switch (event.key) {
    case 'ArrowDown':
      destination = visible;
      break;
    case 'ArrowUp':
      destination = visibleStructure.find(
        (candidate) => canvasNodeKey(candidate) === items[rowIndex - 1]?.dataset.treeKey,
      );
      break;
    case 'Home':
      destination = visibleStructure.find(
        (candidate) => canvasNodeKey(candidate) === items[0]?.dataset.treeKey,
      );
      break;
    case 'End':
      destination = visibleStructure.find(
        (candidate) => canvasNodeKey(candidate) === items.at(-1)?.dataset.treeKey,
      );
      break;
    case 'ArrowRight':
      if (branch && shut) toggleBranch(node);
      else if (branch) destination = treeChildren(node)[0];
      break;
    case 'ArrowLeft':
      if (branch && !shut) toggleBranch(node);
      else {
        destination = index.parentOf(node);
        while (destination && index.hiddenWrappers.has(destination.id))
          destination = index.parentOf(destination);
      }
      break;
    default:
      return;
  }
  event.preventDefault();
  if (destination) focusTreeNode(destination);
}

// A target picked in the page must not land inside a branch the editor left collapsed. Only a
// change of selection opens the chain, so collapsing the branch you are working in still holds.
let openedFor = '';
$effect(() => {
  const node = selectedNode;
  if (!node) return;
  const key = canvasNodeKey(node);
  if (key === openedFor) return;
  openedFor = key;
  untrack(() => {
    const opened = { ...collapsed };
    let changed = false;
    for (let parent = index.parentOf(node); parent; parent = index.parentOf(parent)) {
      if (!opened[canvasNodeKey(parent)]) continue;
      opened[canvasNodeKey(parent)] = false;
      changed = true;
    }
    if (changed) collapsed = opened;
  });
});

type StructureDragHandlers = Required<DragDropEventHandlers>;
let structureDrag:
  | { node: CanvasStructureNode; siblings: CanvasStructureNode[]; version: number }
  | undefined;
const structureDragStart: StructureDragHandlers['onDragStart'] = ({ operation }) => {
  const node = structure.find((candidate) => canvasNodeKey(candidate) === operation.source?.id);
  const location = node && blockLocation(node);
  if (!node || !location) return;
  structureDrag = {
    node,
    siblings: structure
      .filter((candidate) => blockLocation(candidate)?.address === location.address)
      .sort((a, b) => (blockLocation(a)?.index ?? 0) - (blockLocation(b)?.index ?? 0)),
    version: session.contentVersion(locale),
  };
  structureOrder = structureDrag.siblings.map(canvasNodeKey);
};
const structureDragOver: StructureDragHandlers['onDragOver'] = ({ operation }) => {
  const { source, target } = operation;
  if (!isSortable(source) || !isSortable(target) || source.group !== target.group) return;
  const from = structureOrder.indexOf(String(source.id));
  const to = structureOrder.indexOf(String(target.id));
  if (from < 0 || to < 0 || from === to) return;
  const next = [...structureOrder];
  next.splice(to, 0, ...next.splice(from, 1));
  structureOrder = next;
};
const structureDragEnd: StructureDragHandlers['onDragEnd'] = ({ canceled }) => {
  const held = structureDrag;
  const to = held ? structureOrder.indexOf(canvasNodeKey(held.node)) : -1;
  structureDrag = undefined;
  structureOrder = [];
  if (canceled || !held || to < 0 || held.siblings[to] === held.node) return;
  if (held.version !== session.contentVersion(locale)) return;
  const destination = held.siblings[to];
  if (destination) onaction({ action: 'move', selection: held.node, destination });
};
</script>

<div class="canvas-structure-home" bind:this={root}>
  <header>
    <div>
      <h2 id="canvas-structure-title">{m.canvas_structure({}, options)}</h2>
      <span>{m.canvas_editable_items({ count: structure.length }, options)}</span>
    </div>
    <button
      class="btn btn-ghost btn-sm"
      type="button"
      aria-label={m.canvas_close_structure({}, options)}
      onclick={onclose}><CanvasIcon name="collapse-left" /></button
    >
  </header>
  {#if structure.length}
    <div class="canvas-structure-tree" aria-label={m.canvas_page_structure({}, options)} role="tree">
      {#snippet structureRows(parent?: CanvasStructureNode)}
        {@const siblings = treeChildren(parent)}
        {#each siblings as node, rowIndex (canvasNodeKey(node))}
          {@const branch = index.branches.has(node.id)}
          {@const shut = branch && collapsed[canvasNodeKey(node)] === true}
          <StructureRow
            {node}
            depth={index.depthOf(node)}
            posinset={rowIndex + 1}
            setsize={siblings.length}
            {branch}
            {shut}
            isSelected={sameCanvasSelection(node, selected)}
            focused={treeFocusKey === canvasNodeKey(node)}
            label={treeLabel(node)}
            icon={nodeIcon(node)}
            {treeDomId}
            {options}
            {structureOrder}
            structureIndex={(candidate) => sortKeys.get(canvasNodeKey(candidate))}
            {blockLocation}
            {blockActionsFor}
            onselect={onselectnode}
            ontoggle={toggleBranch}
            onrowkeydown={treeKeydown}
            onrowfocus={(node) => (focusedTreeKey = canvasNodeKey(node))}
          >
            {@render structureRows(node)}
          </StructureRow>
        {/each}
      {/snippet}
      <DragDropProvider
        onDragStart={structureDragStart}
        onDragOver={structureDragOver}
        onDragEnd={structureDragEnd}
      >
        {@render structureRows()}
      </DragDropProvider>
    </div>
  {:else}
    <p class="canvas-structure-empty">{m.canvas_no_annotations({}, options)}</p>
  {/if}
  <footer>
    <button
      bind:this={addBlockButton}
      class="btn btn-sm"
      type="button"
      disabled={!insertionNode || interactionMode !== 'edit'}
      onclick={() => {
        if (insertionNode) oninsert(insertionNode.kind === 'list' ? 'insert-empty' : 'insert-after', insertionNode);
      }}><CanvasIcon name="plus" /> {m.canvas_add_block({}, options)}</button
    >
  </footer>
</div>
