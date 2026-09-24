import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ContentError } from '@handover/core';
import { expect, test } from 'vitest';
import { CANVAS_ADDRESS_LIMIT, CANVAS_PROTOCOL, createEditContext } from './canvas';

const astro = {
  locals: {
    handoverCanvas: {
      protocol: 1,
      requestId: 'request',
      epoch: 'epoch',
      entry: { collection: 'pages', id: 'home' },
      locale: 'en',
      contentVersion: 1,
    },
  },
};

test('plain array rows are containers while typed and shared blocks retain their editors', () => {
  const list = createEditContext(astro).list('blocks');
  const column = list
    .block({ _id: 'columns', _type: 'columns' })
    .list('columns')
    .block({ _id: 'right' });
  expect(column['data-handover-container']).toBe('true');
  expect(column['data-handover-block']).toBeDefined();
  expect(column.field('heading')['data-handover-container']).toBeUndefined();
  expect(column.list('blocks')['data-handover-list']).toBeDefined();
  expect(list.block({ _id: 'hero', _type: 'hero' })['data-handover-container']).toBeUndefined();
  expect(
    list.block({ _id: 'shared', _ref: 'globals/cta' })['data-handover-container'],
  ).toBeUndefined();
  expect(Object.keys(createEditContext({}).list('columns').block({ _id: 'right' }))).toEqual([]);
});

test('nested stable-row addresses remain annotated until the documented protocol bound', () => {
  let context = createEditContext(astro).list('blocks');
  for (let index = 0; index < 12; index += 1) context = context.block('abcdefgh').list('blocks');
  const annotation = context.field('heading')['data-handover-field'];
  expect(JSON.parse(annotation ?? '{}').address.length).toBeGreaterThan(200);
  expect(JSON.parse(annotation ?? '{}').address).toContain('[_id=abcdefgh]');
});

test('an address beyond the browser protocol bound fails while the template renders', () => {
  expect(() => createEditContext(astro).field('a'.repeat(4_097))).toThrow(/Canvas address/);
  // A ContentError, not a bare Error: the same family the preview route already renders readably.
  expect(() => createEditContext(astro).field('a'.repeat(4_097))).toThrow(ContentError);
});

test('a long authored block label is bounded for Structure transport', () => {
  const context = createEditContext(astro)
    .list('blocks')
    .block({
      _id: 'hero',
      _type: 'hero',
      _label: 'A'.repeat(201),
    });
  expect(context['data-handover-name']).toHaveLength(200);
});

test('trimming a label to its bound never splits a surrogate pair', () => {
  const context = createEditContext(astro)
    .list('blocks')
    .block({
      _id: 'hero',
      _type: 'hero',
      _label: `${'A'.repeat(199)}😀`,
    });
  // A 200-unit cut would land inside the emoji's surrogate pair; the whole emoji is dropped instead.
  expect(context['data-handover-name']).toBe('A'.repeat(199));
});

// Reads the sibling package's source directly, rather than importing @handover/ui: that package
// has no built entry point for a plain Node test to resolve, in CI or otherwise.
test('protocol and address-limit constants match the browser bridge exactly', () => {
  const bridgePath = fileURLToPath(
    new URL('../../ui/src/canvas/canvas-bridge.ts', import.meta.url),
  );
  const source = readFileSync(bridgePath, 'utf8');
  const constant = (name: string) => {
    const match = source.match(new RegExp(`export const ${name} = ([\\d_]+)`));
    if (!match?.[1]) throw new Error(`${name} not found in canvas-bridge.ts`);
    return Number(match[1].replace(/_/g, ''));
  };
  expect(constant('CANVAS_PROTOCOL')).toBe(CANVAS_PROTOCOL);
  expect(constant('CANVAS_ADDRESS_LIMIT')).toBe(CANVAS_ADDRESS_LIMIT);
});
