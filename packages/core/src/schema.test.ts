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
    { path: ['title'], label: 'Title', type: 'text', required: true },
  ]);
});

test('optional strings are text fields with required false', () => {
  expect(fieldsFrom('default', obj({ note: { type: 'string' } }))).toEqual([
    { path: ['note'], label: 'Note', type: 'text', required: false },
  ]);
});

test('a nested object is a group whose fields are relative to it', () => {
  const schema = obj({ address: obj({ street: { type: 'string' } }, ['street']) }, ['address']);
  expect(fieldsFrom('default', schema)).toEqual([
    {
      path: ['address'],
      label: 'Address',
      type: 'group',
      required: true,
      fields: [{ path: ['street'], label: 'Street', type: 'text', required: true }],
    },
  ]);
});

test('number and integer schemas become number fields', () => {
  const schema = obj({ area: { type: 'number' }, beds: { type: 'integer', minimum: 0 } }, ['area']);
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['area'], label: 'Area', type: 'number', required: true },
    { path: ['beds'], label: 'Beds', type: 'number', required: false },
  ]);
});

test('boolean schemas become boolean fields', () => {
  expect(fieldsFrom('default', obj({ sold: { type: 'boolean' } }, ['sold']))).toEqual([
    { path: ['sold'], label: 'Sold', type: 'boolean', required: true },
  ]);
});

test('a string with format date is a date field', () => {
  const schema = obj({ from: { type: 'string', format: 'date', pattern: '^x$' } }, ['from']);
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['from'], label: 'From', type: 'date', required: true },
  ]);
});

test('a string enum is a select field carrying its options', () => {
  const schema = obj({ status: { type: 'string', enum: ['sale', 'rent'] } }, ['status']);
  expect(fieldsFrom('default', schema)).toEqual([
    {
      path: ['status'],
      label: 'Status',
      type: 'select',
      required: true,
      options: ['sale', 'rent'],
    },
  ]);
});

test('a schema tagged handover: link is a link field, whatever its shape', () => {
  const schema = obj({ button: { oneOf: [obj({ href: { type: 'string' } })], handover: 'link' } });
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['button'], label: 'Button', type: 'link', required: false },
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
    { path: ['hero'], label: 'Hero', type: 'image', required: false },
    { path: ['brochure'], label: 'Brochure', type: 'file', required: false },
    { path: ['video'], label: 'Video', type: 'embed', required: false },
    { path: ['seo'], label: 'Seo', type: 'seo', required: false },
  ]);
});

test('a schema tagged reference carries its collection', () => {
  const schema = obj({ agent: { type: 'string', handover: 'reference', collection: 'agents' } }, [
    'agent',
  ]);
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['agent'], label: 'Agent', type: 'reference', required: true, collection: 'agents' },
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
    { path: ['tags'], label: 'Tags', type: 'unsupported' },
    { path: ['nick'], label: 'Nick', type: 'unsupported' },
    { path: ['when'], label: 'When', type: 'unsupported' },
    { path: ['title'], label: 'Title', type: 'text', required: true },
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
    { path: ['title'], label: 'Title', type: 'text', required: true },
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
      label: 'Rooms',
      type: 'array',
      required: true,
      item: [
        { path: ['name'], label: 'Name', type: 'text', required: true },
        { path: ['beds'], label: 'Beds', type: 'number', required: false },
      ],
    },
  ]);
});

test('an array of scalars is an array field with one unnamed item field', () => {
  const schema = obj({ tags: { type: 'array', items: { type: 'string' } } });
  expect(fieldsFrom('default', schema)).toEqual([
    {
      path: ['tags'],
      label: 'Tags',
      type: 'array',
      required: false,
      item: [{ path: [], label: '', type: 'text', required: true }],
    },
  ]);
});

test('an array of arrays is unsupported, the serialiser rejects it anyway', () => {
  const schema = obj({
    grid: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
  });
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['grid'], label: 'Grid', type: 'unsupported' },
  ]);
});

test('a schema tagged blocks is a blocks field carrying its block types', () => {
  const schema = obj({ blocks: { type: 'array', handover: 'blocks', types: ['hero', 'cta'] } }, [
    'blocks',
  ]);
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['hero', 'cta'] },
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
    { path: ['body'], label: 'Body', type: 'richtext', required: true, tier: 'full' },
    { path: ['note'], label: 'Note', type: 'richtext', required: false, tier: 'basic' },
  ]);
});

test('a custom tagged with a scalar name is a field of that type', () => {
  const schema = obj({ when: { handover: 'date' }, count: { handover: 'number' } }, ['when']);
  expect(fieldsFrom('default', schema)).toEqual([
    { path: ['when'], label: 'When', type: 'date', required: true },
    { path: ['count'], label: 'Count', type: 'number', required: false },
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
      label: 'Hero',
      type: 'group',
      required: true,
      fields: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
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
    fields: [
      {
        path: ['blocks'],
        label: 'Blocks',
        type: 'blocks',
        required: true,
        types: ['hero', 'columns'],
      },
    ],
    blocks: {
      hero: [{ path: ['heading'], label: 'Heading', type: 'text', required: false }],
      columns: [
        {
          path: ['columns'],
          label: 'Columns',
          type: 'array',
          required: true,
          item: [
            {
              path: ['blocks'],
              label: 'Blocks',
              type: 'blocks',
              required: false,
              types: ['hero', 'columns'],
            },
          ],
        },
      ],
    },
  });
});

test('formOf of a schema without blocks has an empty block map', () => {
  expect(formOf('default', obj({ title: { type: 'string' } }))).toEqual({
    fields: [{ path: ['title'], label: 'Title', type: 'text', required: false }],
    blocks: {},
  });
});

// F3: a camelCase key read as code in the form ("AvailableFrom"). The key is humanised
// unless the schema names the field.
test.each([
  ['title', 'Title'],
  ['availableFrom', 'Available from'],
  ['publishedAt', 'Published at'],
  ['heroImageAlt', 'Hero image alt'],
  ['seo_title', 'Seo title'],
  ['seo-title', 'Seo title'],
])('the key %s is labelled %s', (key, label) => {
  expect(fieldsFrom('default', obj({ [key]: { type: 'string' } }))[0]?.label).toBe(label);
});

test('a label in the schema wins over the humanised key', () => {
  const schema = obj({ seo: { type: 'object', properties: {}, handover: 'seo', label: 'SEO' } });
  expect(fieldsFrom('default', schema)[0]?.label).toBe('SEO');
});

test('groups, arrays, blocks and unsupported leaves are labelled too', () => {
  const schema = obj({
    mainContact: obj({ phoneNumber: { type: 'string' } }),
    openDays: { type: 'array', items: obj({ dayName: { type: 'string' } }) },
    pageBlocks: { type: 'array', handover: 'blocks', types: ['hero'] },
    oddOne: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  });
  const fields = fieldsFrom('default', schema);
  expect(fields.map((f) => f.label)).toEqual([
    'Main contact',
    'Open days',
    'Page blocks',
    'Odd one',
  ]);
  const group = fields[0];
  const array = fields[1];
  if (group?.type !== 'group' || array?.type !== 'array') throw new Error('shape changed');
  expect(group.fields[0]?.label).toBe('Phone number');
  expect(array.item[0]?.label).toBe('Day name');
});

test('the item of an array of scalars has no label of its own', () => {
  const schema = obj({ tags: { type: 'array', items: { type: 'string' } } });
  const array = fieldsFrom('default', schema)[0];
  if (array?.type !== 'array') throw new Error('shape changed');
  expect(array.item[0]?.label).toBe('');
});

test('a field says how it translates only when it is not the default', () => {
  const schema = obj({
    heading: { type: 'string' },
    price: { type: 'number', i18n: 'duplicate' },
    notes: { type: 'string', i18n: false },
    tagline: { type: 'string', i18n: true },
  });
  expect(fieldsFrom('default', schema).map((f) => f.i18n)).toEqual([
    undefined,
    'duplicate',
    false,
    true,
  ]);
});

test('a nested property carries its own mode, whatever its group says', () => {
  const schema = obj({
    contact: {
      ...obj({ name: { type: 'string' }, phone: { type: 'string', i18n: true } }),
      i18n: 'duplicate',
    },
  });
  const group = fieldsFrom('default', schema)[0];
  if (group?.type !== 'group') throw new Error('shape changed');
  expect(group.i18n).toBe('duplicate');
  expect(group.fields.map((f) => f.i18n)).toEqual([undefined, true]);
});

test('a mode that is not one of the three is ignored', () => {
  const schema = obj({ price: { type: 'number', i18n: 'duplicated' } });
  expect(fieldsFrom('default', schema)[0]?.i18n).toBeUndefined();
});
