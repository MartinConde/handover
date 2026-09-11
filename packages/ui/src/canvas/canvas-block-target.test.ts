import { expect, test } from 'vitest';
import { resolveStagedBlockIndex, type StagedBlockTarget } from './canvas-block-target';

const replacement: StagedBlockTarget = {
  mode: 'replace',
  targetId: 'second',
  original: { _id: 'second', _type: 'quote', quote: 'Original words' },
};

test('a staged replacement follows its block identity through a reorder', () => {
  expect(
    resolveStagedBlockIndex(replacement, [
      { _id: 'second', _type: 'quote', quote: 'Original words' },
      { _id: 'first', _type: 'hero' },
    ]),
  ).toEqual({ ok: true, index: 0 });
});

test('a staged replacement explicitly refuses a deleted or replaced target', () => {
  expect(
    resolveStagedBlockIndex(replacement, [
      { _id: 'first', _type: 'hero' },
      { _id: 'replacement', _type: 'quote' },
    ]),
  ).toEqual({ ok: false, reason: 'deleted' });
});

test('unrelated changes cannot redirect a staged replacement', () => {
  expect(
    resolveStagedBlockIndex(replacement, [
      { _id: 'first', _type: 'hero', heading: 'Changed elsewhere' },
      { _id: 'second', _type: 'quote', quote: 'Original words' },
    ]),
  ).toEqual({ ok: true, index: 1 });
});

test('changes to the target itself are refused instead of overwritten', () => {
  expect(
    resolveStagedBlockIndex(replacement, [
      { _id: 'second', _type: 'quote', quote: 'Edited while the drawer was open' },
    ]),
  ).toEqual({ ok: false, reason: 'stale' });
});

test('staged insertion keeps its anchor and before or after intent', () => {
  const rows = [{ _id: 'second' }, { _id: 'first' }];
  expect(
    resolveStagedBlockIndex({ mode: 'insert', placement: 'before', anchorId: 'first' }, rows),
  ).toEqual({ ok: true, index: 1 });
  expect(
    resolveStagedBlockIndex({ mode: 'insert', placement: 'after', anchorId: 'first' }, rows),
  ).toEqual({ ok: true, index: 2 });
});

test('an insertion staged for an empty list refuses a newly populated list', () => {
  expect(resolveStagedBlockIndex({ mode: 'insert', placement: 'empty' }, [{ _id: 'new' }])).toEqual(
    { ok: false, reason: 'stale' },
  );
});
