// Its own module, not part of canvas-selection: the admin shell reads the tree, and importing
// that module would pull the whole in-page selection runtime into the editor's bundle.
import type { CanvasStructureNode } from './canvas-bridge';
import { canvasSelectionKey } from './canvas-target';

/** Node ids are renumbered on every render, so a collapsed branch is remembered by its target. */
export const canvasNodeKey = (node: CanvasStructureNode) => canvasSelectionKey(node);

/** A row under a collapsed ancestor is not in the tree, however deep the branch it sits in. */
export function visibleCanvasNodes(
  nodes: readonly CanvasStructureNode[],
  collapsed: Record<string, boolean>,
): CanvasStructureNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentOf = (node: CanvasStructureNode) =>
    node.parentId ? byId.get(node.parentId) : undefined;
  return nodes.filter((node) => {
    let parent = parentOf(node);
    for (let steps = 0; parent && steps <= nodes.length; steps += 1) {
      if (collapsed[canvasNodeKey(parent)]) return false;
      parent = parentOf(parent);
    }
    return true;
  });
}

export const structuralName = (node: CanvasStructureNode) =>
  node.target.address.split('.').at(-1)?.replace(/\[.*$/, '').toLowerCase();

export type CanvasStructureIndex = {
  parentOf: (node: CanvasStructureNode) => CanvasStructureNode | undefined;
  branches: Set<string>;
  hiddenWrappers: Set<string>;
  depthOf: (node: CanvasStructureNode) => number;
};

/** One pass over the tree so parent lookup, depth and hidden-wrapper checks are O(1) per row. */
export function buildStructureIndex(nodes: readonly CanvasStructureNode[]): CanvasStructureIndex {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentOf = (node: CanvasStructureNode) =>
    node.parentId ? byId.get(node.parentId) : undefined;
  const branches = new Set(
    nodes.map((node) => node.parentId).filter((id): id is string => Boolean(id)),
  );
  // Hide only generic, nonempty wrapper lists; retain empty lists as insertion targets.
  const hiddenWrappers = new Set(
    nodes
      .filter(
        (node) =>
          node.kind === 'list' &&
          node.parentId &&
          !node.empty &&
          (structuralName(node) === 'blocks' || structuralName(node) === 'columns'),
      )
      .map((node) => node.id),
  );
  const depths = new Map<string, number>();
  const depthOf = (node: CanvasStructureNode): number => {
    const cached = depths.get(node.id);
    if (cached !== undefined) return cached;
    let depth = node.depth;
    for (let parent = parentOf(node); parent; parent = parentOf(parent))
      if (hiddenWrappers.has(parent.id)) depth -= 1;
    depths.set(node.id, depth);
    return depth;
  };
  return { parentOf, branches, hiddenWrappers, depthOf };
}
