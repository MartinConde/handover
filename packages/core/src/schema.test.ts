import { expect, test } from 'vitest';
import { fieldsFrom, type JsonSchema } from './schema.js';

// Hand-written `z.toJSONSchema()` output: core never holds a Zod object.
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
});

test('top-level required strings become text fields', () => {
  expect(fieldsFrom('default', obj({ title: { type: 'string' } }, ['title']))).toEqual([
    { path: ['title'], type: 'text', required: true },
  ]);
});

test('optional strings are text fields with required false', () => {
  expect(fieldsFrom('default', obj({ note: { type: 'string' } }))).toEqual([
    { path: ['note'], type: 'text', required: false },
  ]);
});

test('strings inside nested objects get the full path', () => {
  const schema = obj({ address: obj({ street: { type: 'string' } }, ['street']) }, ['address']);
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['address', 'street'], type: 'text', required: true },
  ]);
});

test('number and integer schemas become number fields', () => {
  const schema = obj({ area: { type: 'number' }, beds: { type: 'integer', minimum: 0 } }, ['area']);
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['area'], type: 'number', required: true },
    { path: ['beds'], type: 'number', required: false },
  ]);
});

test('boolean schemas become boolean fields', () => {
  expect(fieldsFrom('default', obj({ sold: { type: 'boolean' } }, ['sold']))).toEqual([
    { path: ['sold'], type: 'boolean', required: true },
  ]);
});

test('a string with format date is a date field', () => {
  const schema = obj({ from: { type: 'string', format: 'date', pattern: '^x$' } }, ['from']);
  expect(fieldsFrom('default', schema)).toEqual([{ path: ['from'], type: 'date', required: true }]);
});

test('a string enum is a select field carrying its options', () => {
  const schema = obj({ status: { type: 'string', enum: ['sale', 'rent'] } }, ['status']);
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['status'], type: 'select', required: true, options: ['sale', 'rent'] },
  ]);
});

test('a schema tagged handover: link is a link field, whatever its shape', () => {
  const schema = obj({ button: { oneOf: [obj({ href: { type: 'string' } })], handover: 'link' } });
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['button'], type: 'link', required: false },
  ]);
});

test('other leaves are marked unsupported, not rejected', () => {
  const schema = obj(
    {
      tags: { type: 'array', items: { type: 'string' } },
      nick: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      when: {},
      title: { type: 'string' },
    },
    ['tags', 'nick', 'when', 'title'],
  );
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['tags'], type: 'unsupported' },
    { path: ['nick'], type: 'unsupported' },
    { path: ['when'], type: 'unsupported' },
    { path: ['title'], type: 'text', required: true },
  ]);
});

test('a schema that is not an object has no fields', () => {
  expect(fieldsFrom('default', { type: 'string' })).toEqual([]);
});

test('reserved _ keys are metadata, not form fields', () => {
  const schema = obj(
    { _version: { type: 'number' }, _status: { type: 'string' }, title: { type: 'string' } },
    ['title'],
  );
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['title'], type: 'text', required: true },
  ]);
});
