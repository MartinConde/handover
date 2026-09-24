import { expect, test } from 'vitest';
import { createEditContext } from './canvas';

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
