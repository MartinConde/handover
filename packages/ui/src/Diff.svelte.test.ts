import type { DiffGroup } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';
import Diff from './Diff.svelte';

// Testing: the two rules a reader would notice going wrong — a language with nothing in it saying
// so out loud, and a moved block reading as one move rather than as a deletion and an addition.
// Not testing: the other change shapes, which are the walker's output rendered straight.

let app: ReturnType<typeof mount>;
const show = (groups: DiffGroup[]) => {
  app = mount(Diff, { target: document.body, props: { groups } });
  flushSync();
  return document.body;
};
afterEach(() => unmount(app));

test('a language nothing happened in says so, because silence reads as not loaded', () => {
  const body = show([
    { locale: 'en', changes: [{ path: 'title', label: 'Title', kind: 'whole' }] },
    { locale: 'de', changes: [] },
  ]);

  expect(Array.from(body.querySelectorAll('h4')).map((h) => h.textContent)).toEqual([
    'English',
    'German',
  ]);
  expect(body.querySelector('.is-quiet')?.textContent).toBe('Everything elseunchanged');
});

test('a block that moved is one row, not a deletion and an addition', () => {
  const body = show([
    {
      locale: 'en',
      changes: [
        {
          path: 'blocks[_id=cccc3333]',
          label: 'Gallery',
          kind: 'row',
          type: 'Hero',
          at: 'moved-up',
          above: 'Seaview Cottage',
          changes: [],
        },
      ],
    },
  ]);

  expect(body.querySelectorAll('.diff .row')).toHaveLength(1);
  expect(body.querySelector('.badge')?.textContent).toBe('moved up');
  expect(body.querySelector('.row')?.textContent).toContain('now above Seaview Cottage');
  expect(body.querySelector('del')).toBe(null);
  expect(body.querySelector('ins')).toBe(null);
});
