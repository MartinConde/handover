import type {
  CanvasDocumentIdentity,
  CanvasSelection,
  CanvasTarget,
} from './canvas-bridge';

type CanvasLocation = Omit<CanvasTarget, 'occurrence'>;

export const sameCanvasDocument = (
  a: CanvasDocumentIdentity,
  b: CanvasDocumentIdentity,
) => a === b || (a.collection === b.collection && a.id === b.id);

export const sameCanvasLocation = (
  a: CanvasLocation | undefined,
  b: CanvasLocation | undefined,
) =>
  a === b ||
  (!!a &&
    !!b &&
    sameCanvasDocument(a.document, b.document) &&
    a.locale === b.locale &&
    a.address === b.address);

export const sameCanvasTarget = (a: CanvasTarget, b: CanvasTarget) =>
  a === b ||
  (sameCanvasLocation(a, b) && sameCanvasLocation(a.occurrence, b.occurrence));

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

/** Stable across object property order and explicit about every field that defines target identity. */
export const canvasTargetKey = (target: CanvasTarget) => JSON.stringify(targetIdentity(target));

export const canvasSelectionKey = (selection: CanvasSelection) =>
  JSON.stringify([selection.kind, targetIdentity(selection.target)]);
