import type { CanvasDocumentIdentity, CanvasSelection, CanvasTarget } from './canvas-protocol';

type CanvasLocation = Omit<CanvasTarget, 'occurrence'>;

export const sameCanvasDocument = (a: CanvasDocumentIdentity, b: CanvasDocumentIdentity) =>
  a === b || (a.collection === b.collection && a.id === b.id);

export const sameCanvasLocation = (a: CanvasLocation | undefined, b: CanvasLocation | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    sameCanvasDocument(a.document, b.document) &&
    a.locale === b.locale &&
    a.address === b.address);

export const sameCanvasTarget = (a: CanvasTarget, b: CanvasTarget) =>
  a === b || (sameCanvasLocation(a, b) && sameCanvasLocation(a.occurrence, b.occurrence));

export const sameCanvasSelection = (
  a: CanvasSelection | undefined,
  b: CanvasSelection | undefined,
) => a === b || (!!a && !!b && a.kind === b.kind && sameCanvasTarget(a.target, b.target));

const locationIdentity = (location: CanvasLocation) => [
  location.document.collection,
  location.document.id,
  location.locale,
  location.address,
];

const targetIdentity = (target: CanvasTarget) => [
  locationIdentity(target),
  target.occurrence ? locationIdentity(target.occurrence) : null,
];

export const canvasSelectionKey = (selection: CanvasSelection) =>
  JSON.stringify([selection.kind, targetIdentity(selection.target)]);

// Empty fields render no annotation of their own; the deepest annotated ancestor stands in.
export const nearestOwner = <T extends { target: { address: string } }>(
  nodes: readonly T[],
  address: string,
) =>
  nodes
    .filter(
      (node) =>
        address === node.target.address ||
        address.startsWith(`${node.target.address}.`) ||
        address.startsWith(`${node.target.address}[`),
    )
    .sort((a, b) => b.target.address.length - a.target.address.length)[0];

export const historyDirection = (event: KeyboardEvent) => {
  if (!event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y') return 'redo';
};

export const editableTarget = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);
