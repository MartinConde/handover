// Its own module, not part of canvas-selection: the admin shell reads the tree, and importing
// that module would pull the whole in-page selection runtime into the editor's bundle.
import type { CanvasStructureNode } from './canvas-bridge';
import { canvasSelectionKey } from './canvas-target';

/** Node ids are renumbered on every render, so a collapsed branch is remembered by its target. */
export const canvasNodeKey = (node: CanvasStructureNode) =>
  canvasSelectionKey(node);

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
