import {
  type CanvasAnnotationKind,
  type CanvasStructureNode,
  type CanvasTarget,
  isCanvasTarget,
} from '../canvas-bridge';
import { canvasSelectionKey } from '../canvas-target';

export const MARKERS = [
  ['data-handover-field', 'field'],
  ['data-handover-list', 'list'],
  ['data-handover-block', 'block'],
] as const satisfies readonly (readonly [string, CanvasAnnotationKind])[];
export const SELECTOR = MARKERS.map(([attribute]) => `[${attribute}]`).join(',');

interface StructuralLocation {
  document: { collection: string; id: string };
  locale: string;
  address: string;
}

export interface InternalNode extends CanvasStructureNode {
  elements: Element[];
  structural: StructuralLocation;
  /** The block's own name from the template, before position is used as a fallback. */
  named: string;
}

const structuralLocation = (target: CanvasTarget): StructuralLocation => {
  const rendered = target.occurrence;
  return {
    document: rendered?.document ?? target.document,
    locale: rendered?.locale ?? target.locale,
    address:
      rendered && target.address
        ? `${rendered.address}.${target.address}`
        : (rendered?.address ?? target.address),
  };
};

const locationKey = (location: StructuralLocation, address = location.address) =>
  JSON.stringify([location.document.collection, location.document.id, location.locale, address]);

/** Every strict ancestor address, longest first: prefixes that end before a `.` or `[`. */
function* ancestorKeys(location: StructuralLocation) {
  const { address } = location;
  for (let end = address.length - 1; end > 0; end -= 1)
    if (address[end] === '.' || address[end] === '[')
      yield locationKey(location, address.slice(0, end));
}

export const humanize = (value: string) => {
  const clean = value
    .replace(/\[_id=[^\]]+\]/g, '')
    .split('.')
    .at(-1)
    ?.replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : '';
};

export const publicNode = ({
  elements: _elements,
  structural: _structural,
  named: _named,
  ...node
}: InternalNode) => node;

const parseMarker = (element: Element, attribute: string): CanvasTarget | undefined => {
  try {
    const value = JSON.parse(element.getAttribute(attribute) ?? '') as unknown;
    return isCanvasTarget(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export function readStructure(root: Document): InternalNode[] {
  const grouped = new Map<string, InternalNode>();
  for (const element of Array.from(root.querySelectorAll(SELECTOR))) {
    for (const [attribute, kind] of MARKERS) {
      if (!element.hasAttribute(attribute)) continue;
      const target = parseMarker(element, attribute);
      if (!target) continue;
      const key = canvasSelectionKey({ kind, target });
      const prior = grouped.get(key);
      if (prior) {
        prior.elements.push(element);
        prior.occurrences += 1;
        continue;
      }
      grouped.set(key, {
        id: `target-${grouped.size + 1}`,
        kind,
        target,
        ...(kind === 'block' && element.getAttribute('data-handover-container') === 'true'
          ? { container: true }
          : {}),
        label: '',
        depth: 1,
        position: 1,
        setSize: 1,
        occurrences: 1,
        elements: [element],
        structural: structuralLocation(target),
        named: element.getAttribute('data-handover-name')?.trim() || '',
      });
    }
  }
  const nodes = [...grouped.values()];
  // The first node at a location wins when two kinds share one address.
  const byLocation = new Map<string, InternalNode>();
  const aboveBlock = new Set<string>();
  for (const node of nodes) {
    const key = locationKey(node.structural);
    if (!byLocation.has(key)) byLocation.set(key, node);
    if (node.kind === 'block')
      for (const above of ancestorKeys(node.structural)) aboveBlock.add(above);
  }
  const children = new Map<string | undefined, InternalNode[]>();
  for (const node of nodes) {
    for (const above of ancestorKeys(node.structural)) {
      const parent = byLocation.get(above);
      if (parent) {
        node.parentId = parent.id;
        break;
      }
    }
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
    // `labelNodes` supplies every owned fallback from the active catalog after the tree is indexed.
    // Keep only authored/template-derived text here so an English placeholder never crosses the
    // Canvas bridge or becomes control flow in the parent workspace.
    node.label = node.kind === 'block' ? node.named : humanize(node.target.address);
    if (node.kind === 'list' && !aboveBlock.has(locationKey(node.structural))) node.empty = true;
  }
  for (const siblings of children.values())
    siblings.forEach((node, index) => {
      node.position = index + 1;
      node.setSize = siblings.length;
    });
  // Depth-first: one element may carry both a block and the list inside it, and the list is
  // discovered first, so marker order would put a child above its own parent.
  const ordered: InternalNode[] = [];
  const walk = (parentId: string | undefined, depth: number) => {
    for (const node of children.get(parentId) ?? []) {
      node.depth = depth;
      ordered.push(node);
      walk(node.id, Math.min(100, depth + 1));
    }
  };
  walk(undefined, 1);
  return ordered;
}
