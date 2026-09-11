import type { Field } from '@handover/core';
import { expect, test } from 'vitest';
import { requiredFieldProblems } from './required-fields';

const heading = {
  path: ['heading'],
  label: 'Heading',
  type: 'text',
  required: true,
} satisfies Field;
const blocks = {
  cta: [heading, { path: ['button'], label: 'Button', type: 'link', required: true }],
  columns: [
    {
      path: ['columns'],
      label: 'Columns',
      type: 'array',
      required: true,
      item: [{ path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['cta'] }],
    },
  ],
} satisfies Record<string, Field[]>;
const fields = [
  { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['cta', 'columns'] },
] satisfies Field[];

test('new nested blocks wait for their required content, but shared references are resolved by the server', () => {
  const cta = { _type: 'cta', _id: 'cta1', heading: '', button: { type: 'entry', ref: '' } };
  const data = {
    blocks: [
      { _type: 'columns', columns: [{ blocks: [cta] }] },
      { _type: 'cta', _ref: 'globals/shared' },
    ],
  };
  expect(Object.keys(requiredFieldProblems(fields, data, blocks))).toEqual([
    'blocks.0.columns.0.blocks.0.heading',
    'blocks.0.columns.0.blocks.0.button',
  ]);
  cta.heading = 'Visit us';
  cta.button.ref = 'pages/contact';
  expect(requiredFieldProblems(fields, data, blocks)).toEqual({});
});

test('empty optional groups and untranslated source fields do not block translation previews', () => {
  const fields: Field[] = [
    { path: ['optional'], label: 'Optional', type: 'group', required: false, fields: [heading] },
    { ...heading, i18n: false },
    { path: ['enabled'], label: 'Enabled', type: 'boolean', required: true },
    { path: ['count'], label: 'Count', type: 'number', required: true },
  ];
  expect(requiredFieldProblems(fields, { enabled: false, count: 0 }, {}, [], true)).toEqual({});
  expect(
    requiredFieldProblems(fields, { optional: {}, enabled: false, count: 0 }, {}, [], true),
  ).toEqual({
    'optional.heading': 'Heading is required',
  });
});
