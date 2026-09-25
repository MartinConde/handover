import { DragDropManager } from '@dnd-kit/dom';
import { Sortable } from '@dnd-kit/dom/sortable';
import { expect, test, vi } from 'vitest';
import { createReorderAnimationLookup } from './canvas-drag';

test('the reorder-animation lookup runs getAnimations once per synchronous pass', async () => {
  const manager = new DragDropManager();
  const element = document.createElement('div');
  const getAnimations = vi.fn(() => [] as Animation[]);
  element.getAnimations = getAnimations;
  const sortable = new Sortable({ id: 'a', index: 0, element }, manager);
  const lookup = createReorderAnimationLookup(() => sortable.draggable);

  lookup();
  lookup();
  lookup();
  expect(getAnimations).toHaveBeenCalledTimes(1);

  await Promise.resolve();
  lookup();
  expect(getAnimations).toHaveBeenCalledTimes(2);

  sortable.destroy();
  manager.destroy();
});
