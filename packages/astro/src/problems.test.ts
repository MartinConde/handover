import { z } from 'astro/zod';
import { expect, test } from 'vitest';
import { blocks, defineBlock, link, reference } from './index.js';
import { entryProblems } from './problems.js';

const registry = () => ({
  hero: defineBlock('hero', { heading: z.string(), sub: z.string().optional() }),
  prose: defineBlock('prose', { body: z.string() }),
});

const show = z.object({
  title: z.string(),
  presenter: reference('presenters'),
  minutes: z.number().positive(),
  studio: z.object({ street: z.string() }),
  slot: z.enum(['breakfast', 'evening']),
  cta: link,
  guests: z.array(z.object({ name: z.string() })).optional(),
  body: blocks(registry).optional(),
});

const full = {
  title: 'Morning Drift',
  presenter: 'presenters/rosa-hale',
  minutes: 90,
  studio: { street: 'Quay Lane' },
  slot: 'evening',
  cta: { type: 'url', href: 'https://example.com' },
};

test('an entry the schema accepts has no problems', () => {
  expect(entryProblems(show, full)).toEqual([]);
});

test('a key that is simply absent reads as required, whatever its type', () => {
  expect(entryProblems(show, { studio: {} })).toEqual([
    { path: 'title', message: 'Required', descriptor: { code: 'FIELD_REQUIRED' } },
    { path: 'presenter', message: 'Required', descriptor: { code: 'FIELD_REQUIRED' } },
    { path: 'minutes', message: 'Required', descriptor: { code: 'FIELD_REQUIRED' } },
    { path: 'studio.street', message: 'Required', descriptor: { code: 'FIELD_REQUIRED' } },
    // An enum and a union would otherwise report what they tried.
    { path: 'slot', message: 'Required', descriptor: { code: 'FIELD_REQUIRED' } },
    { path: 'cta', message: 'Required', descriptor: { code: 'FIELD_REQUIRED' } },
  ]);
});

test('built-in scalar type issues carry stable identities and keep their legacy messages', () => {
  const schema = z.object({
    title: z.string(),
    count: z.number().int(),
    featured: z.boolean(),
    availableFrom: z.iso.date(),
    status: z.enum(['draft', 'live']),
  });

  expect(
    entryProblems(schema, {
      title: 4,
      count: 1.5,
      featured: 'yes',
      availableFrom: '13/09/2026',
      status: 'other',
    }),
  ).toEqual([
    {
      path: 'title',
      message: 'Invalid input: expected string, received number',
      descriptor: { code: 'FIELD_EXPECTED_TEXT' },
    },
    {
      path: 'count',
      message: 'Invalid input: expected int, received number',
      descriptor: { code: 'FIELD_EXPECTED_NUMBER' },
    },
    {
      path: 'featured',
      message: 'Invalid input: expected boolean, received string',
      descriptor: { code: 'FIELD_EXPECTED_BOOLEAN' },
    },
    {
      path: 'availableFrom',
      message: 'Invalid ISO date',
      descriptor: { code: 'FIELD_INVALID_DATE' },
    },
    {
      path: 'status',
      message: 'Invalid option: expected one of "draft"|"live"',
      descriptor: { code: 'FIELD_INVALID_SELECTION' },
    },
  ]);
});

test('a one-option enum is a selection while a literal discriminator is not', () => {
  expect(entryProblems(z.enum(['draft']), 'live')[0]?.descriptor).toEqual({
    code: 'FIELD_INVALID_SELECTION',
  });
  expect(entryProblems(z.literal('draft'), 'live')[0]?.descriptor).toBeUndefined();
});

test('built-in scalar bounds carry only safe formatting parameters', () => {
  const schema = z.object({
    short: z.string().min(3),
    long: z.string().max(5),
    exact: z.string().length(4),
    low: z.number().min(2),
    high: z.number().lt(10),
  });

  expect(
    entryProblems(schema, { short: 'x', long: 'abcdef', exact: 'x', low: 1, high: 10 }),
  ).toEqual([
    {
      path: 'short',
      message: 'Too small: expected string to have >=3 characters',
      descriptor: { code: 'FIELD_TEXT_TOO_SMALL', limit: 3 },
    },
    {
      path: 'long',
      message: 'Too big: expected string to have <=5 characters',
      descriptor: { code: 'FIELD_TEXT_TOO_BIG', limit: 5 },
    },
    {
      path: 'exact',
      message: 'Too small: expected string to have >=4 characters',
      descriptor: { code: 'FIELD_TEXT_TOO_SMALL', exact: true, limit: 4 },
    },
    {
      path: 'low',
      message: 'Too small: expected number to be >=2',
      descriptor: { code: 'FIELD_NUMBER_TOO_SMALL', inclusive: true, limit: 2 },
    },
    {
      path: 'high',
      message: 'Too big: expected number to be <10',
      descriptor: { code: 'FIELD_NUMBER_TOO_BIG', inclusive: false, limit: 10 },
    },
  ]);
});

test('schema-authored messages stay unmarked even when they equal a Zod default', () => {
  const schema = z.object({
    title: z.string({ error: 'Required' }),
    summary: z.string().min(5, 'Too small: expected string to have >=5 characters'),
  });

  expect(entryProblems(schema, { summary: 'x' })).toEqual([
    { path: 'title', message: 'Required' },
    { path: 'summary', message: 'Too small: expected string to have >=5 characters' },
  ]);
});

test('a consumer global error map stays authored and unmarked', () => {
  const before = z.config().customError;
  z.config({ customError: () => 'Too small: expected number to be >=2' });
  try {
    expect(entryProblems(z.object({ count: z.number().min(2) }), { count: 1 })).toEqual([
      { path: 'count', message: 'Too small: expected number to be >=2' },
    ]);
  } finally {
    z.config({ customError: before });
  }
});

test('a value the schema refuses keeps the schema’s own words', () => {
  expect(entryProblems(show, { ...full, minutes: 0 })).toEqual([
    {
      path: 'minutes',
      message: 'Too small: expected number to be >0',
      descriptor: { code: 'FIELD_NUMBER_TOO_SMALL', inclusive: false, limit: 0 },
    },
  ]);
  expect(entryProblems(show, { ...full, presenter: 'rosa-hale' })).toEqual([
    { path: 'presenter', message: 'reference must be collection/slug' },
  ]);
});

test('a row of an array is named by its index', () => {
  expect(entryProblems(show, { ...full, guests: [{ name: 'Ada' }, {}] })).toEqual([
    {
      path: 'guests.1.name',
      message: 'Required',
      descriptor: { code: 'FIELD_REQUIRED' },
    },
  ]);
});

// A blocks() union reports every branch; the right one is the branch that did not fail on `_type`.
test('a missing field inside a block is named on the field, not on the block', () => {
  const body = [
    { _type: 'prose', _id: 'b1', body: 'Hello' },
    { _type: 'hero', _id: 'b2' },
  ];
  expect(entryProblems(show, { ...full, body })).toEqual([
    {
      path: 'body.1.heading',
      message: 'Required',
      descriptor: { code: 'FIELD_REQUIRED' },
    },
  ]);
});

test('a block whose type is in no branch is named on the block itself', () => {
  const body = [{ _type: 'gallery', _id: 'b1' }];
  expect(entryProblems(show, { ...full, body })).toEqual([
    { path: 'body.0', message: 'Invalid input' },
  ]);
});
