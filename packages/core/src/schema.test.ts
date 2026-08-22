import { expect, test } from 'vitest';
import { fieldsFrom, formOf, type JsonSchema } from './schema.js';

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

test('a nested object is a group whose fields are relative to it', () => {
  const schema = obj({ address: obj({ street: { type: 'string' } }, ['street']) }, ['address']);
  expect(fieldsFrom('default', schema)).toEqual([
    {
      path: ['address'],
      type: 'group',
      required: true,
      fields: [{ path: ['street'], type: 'text', required: true }],
    },
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

test('schemas tagged image, file, embed and seo are fields of that type', () => {
  const schema = obj({
    hero: { type: 'object', properties: {}, handover: 'image' },
    brochure: { type: 'object', properties: {}, handover: 'file' },
    video: { type: 'object', properties: {}, handover: 'embed' },
    seo: { type: 'object', properties: {}, handover: 'seo' },
  });
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['hero'], type: 'image', required: false },
    { path: ['brochure'], type: 'file', required: false },
    { path: ['video'], type: 'embed', required: false },
    { path: ['seo'], type: 'seo', required: false },
  ]);
});

test('a schema tagged reference carries its collection', () => {
  const schema = obj({ agent: { type: 'string', handover: 'reference', collection: 'agents' } }, [
    'agent',
  ]);
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['agent'], type: 'reference', required: true, collection: 'agents' },
  ]);
});

test('other leaves are marked unsupported, not rejected', () => {
  const schema = obj(
    {
      tags: { type: 'array', prefixItems: [{ type: 'string' }] },
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

test('an array of objects is an array field whose item fields have no prefix', () => {
  const schema = obj(
    {
      rooms: {
        type: 'array',
        items: obj({ name: { type: 'string' }, beds: { type: 'integer' } }, ['name']),
      },
    },
    ['rooms'],
  );
  expect(fieldsFrom('default', schema)).toEqual([
    {
      path: ['rooms'],
      type: 'array',
      required: true,
      item: [
        { path: ['name'], type: 'text', required: true },
        { path: ['beds'], type: 'number', required: false },
      ],
    },
  ]);
});

test('an array of scalars is an array field with one unnamed item field', () => {
  const schema = obj({ tags: { type: 'array', items: { type: 'string' } } });
  expect(fieldsFrom('default', schema)).toEqual([
    {
      path: ['tags'],
      type: 'array',
      required: false,
      item: [{ path: [], type: 'text', required: true }],
    },
  ]);
});

test('an array of arrays is unsupported, the serialiser rejects it anyway', () => {
  const schema = obj({
    grid: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
  });
  expect(fieldsFrom('default', schema)).toEqual([{ path: ['grid'], type: 'unsupported' }]);
});

test('a schema tagged blocks is a blocks field carrying its block types', () => {
  const schema = obj({ blocks: { type: 'array', handover: 'blocks', types: ['hero', 'cta'] } }, [
    'blocks',
  ]);
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['blocks'], type: 'blocks', required: true, types: ['hero', 'cta'] },
  ]);
});

test('a string tagged richtext is a richtext field carrying its tier', () => {
  const schema = obj(
    {
      body: { type: 'string', handover: 'richtext', tier: 'full' },
      note: { type: 'string', handover: 'richtext', tier: 'basic' },
    },
    ['body'],
  );
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['body'], type: 'richtext', required: true, tier: 'full' },
    { path: ['note'], type: 'richtext', required: false, tier: 'basic' },
  ]);
});

test('a custom tagged with a scalar name is a field of that type', () => {
  const schema = obj({ when: { handover: 'date' }, count: { handover: 'number' } }, ['when']);
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['when'], type: 'date', required: true },
    { path: ['count'], type: 'number', required: false },
  ]);
});

test('a $ref is resolved against the root $defs', () => {
  const schema: JsonSchema = {
    ...obj({ hero: { $ref: '#/$defs/__schema0' } }, ['hero']),
    $defs: { __schema0: obj({ heading: { type: 'string' } }, ['heading']) },
  };
  expect(fieldsFrom('default', schema)).toEqual([
    {
      path: ['hero'],
      type: 'group',
      required: true,
      fields: [{ path: ['heading'], type: 'text', required: true }],
    },
  ]);
});

// The shape `blocks()` from astro-handover produces: a ref block or one of the registered
// block objects, the recursive one through $defs.
const blockList = (types: string[]): JsonSchema => ({
  type: 'array',
  handover: 'blocks',
  types,
  items: {
    anyOf: [
      obj({ _type: { type: 'string' }, _ref: { type: 'string' } }, ['_type', '_ref']),
      {
        anyOf: [
          obj({ _type: { type: 'string', const: 'hero' }, heading: { type: 'string' } }, ['_type']),
          { $ref: '#/$defs/__schema0' },
        ],
      },
    ],
  },
});

test('formOf lists each block type once with its own fields, recursion included', () => {
  const schema: JsonSchema = {
    ...obj({ blocks: blockList(['hero', 'columns']) }, ['blocks']),
    $defs: {
      __schema0: obj(
        {
          _type: { type: 'string', const: 'columns' },
          columns: { type: 'array', items: obj({ blocks: blockList(['hero', 'columns']) }) },
        },
        ['_type', 'columns'],
      ),
    },
  };
  expect(formOf('default', schema)).toEqual({
    fields: [{ path: ['blocks'], type: 'blocks', required: true, types: ['hero', 'columns'] }],
    blocks: {
      hero: [{ path: ['heading'], type: 'text', required: false }],
      columns: [
        {
          path: ['columns'],
          type: 'array',
          required: true,
          item: [{ path: ['blocks'], type: 'blocks', required: false, types: ['hero', 'columns'] }],
        },
      ],
    },
  });
});

test('formOf of a schema without blocks has an empty block map', () => {
  expect(formOf('default', obj({ title: { type: 'string' } }))).toEqual({
    fields: [{ path: ['title'], type: 'text', required: false }],
    blocks: {},
  });
});
