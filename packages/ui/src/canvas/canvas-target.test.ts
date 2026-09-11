import { expect, test } from 'vitest';
import type { CanvasSelection, CanvasTarget } from './canvas-bridge';
import {
  canvasSelectionKey,
  canvasTargetKey,
  sameCanvasLocation,
  sameCanvasSelection,
  sameCanvasTarget,
} from './canvas-target';

const target: CanvasTarget = {
  document: { collection: 'pages', id: 'home' },
  locale: 'en',
  address: 'blocks[_id=hero].heading',
  occurrence: {
    document: { collection: 'globals', id: 'navigation' },
    locale: 'en',
    address: 'items[_id=home]',
  },
};

const reordered: CanvasTarget = {
  address: target.address,
  locale: target.locale,
  document: { id: target.document.id, collection: target.document.collection },
  occurrence: {
    address: target.occurrence!.address,
    locale: target.occurrence!.locale,
    document: {
      id: target.occurrence!.document.id,
      collection: target.occurrence!.document.collection,
    },
  },
};

test('compares and keys equivalent targets independently of property order', () => {
  expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(target));
  expect(sameCanvasTarget(target, reordered)).toBe(true);
  expect(canvasTargetKey(target)).toBe(canvasTargetKey(reordered));
  expect(canvasSelectionKey({ kind: 'field', target })).toBe(
    canvasSelectionKey({ kind: 'field', target: reordered }),
  );
});

test.each([
  ['document', { ...target, document: { ...target.document, id: 'about' } }],
  ['locale', { ...target, locale: 'de' }],
  ['address', { ...target, address: 'blocks[_id=hero].eyebrow' }],
  [
    'occurrence document',
    {
      ...target,
      occurrence: {
        ...target.occurrence!,
        document: { ...target.occurrence!.document, id: 'footer' },
      },
    },
  ],
  ['occurrence locale', { ...target, occurrence: { ...target.occurrence!, locale: 'de' } }],
  [
    'occurrence address',
    { ...target, occurrence: { ...target.occurrence!, address: 'items[_id=about]' } },
  ],
  ['missing occurrence', { ...target, occurrence: undefined }],
] satisfies [string, CanvasTarget][])('keeps a different %s distinct', (_label, other) => {
  expect(sameCanvasTarget(target, other)).toBe(false);
  expect(canvasTargetKey(target)).not.toBe(canvasTargetKey(other));
});

test('uses the annotation kind as part of selection identity', () => {
  const field: CanvasSelection = { kind: 'field', target };
  const block: CanvasSelection = { kind: 'block', target: reordered };

  expect(sameCanvasSelection(field, block)).toBe(false);
  expect(canvasSelectionKey(field)).not.toBe(canvasSelectionKey(block));
  expect(sameCanvasSelection(undefined, undefined)).toBe(true);
  expect(sameCanvasLocation(undefined, target.occurrence)).toBe(false);
});
