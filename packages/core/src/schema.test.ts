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

test('non-string leaves are marked unsupported, not rejected', () => {
  const schema = obj(
    {
      price: { type: 'number' },
      tags: { type: 'array', items: { type: 'string' } },
      nick: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      when: {},
      title: { type: 'string' },
    },
    ['price', 'tags', 'nick', 'when', 'title'],
  );
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['price'], type: 'unsupported' },
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
