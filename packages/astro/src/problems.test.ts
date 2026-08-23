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
    { path: 'title', message: 'Required' },
    { path: 'presenter', message: 'Required' },
    { path: 'minutes', message: 'Required' },
    { path: 'studio.street', message: 'Required' },
    // An enum reports the options it wanted and a union reports every branch it tried; a key
    // that is not there is still just missing.
    { path: 'slot', message: 'Required' },
    { path: 'cta', message: 'Required' },
  ]);
});

test('a value the schema refuses keeps the schema’s own words', () => {
  expect(entryProblems(show, { ...full, minutes: 0 })).toEqual([
    { path: 'minutes', message: 'Too small: expected number to be >0' },
  ]);
  expect(entryProblems(show, { ...full, presenter: 'rosa-hale' })).toEqual([
    { path: 'presenter', message: 'reference must be collection/slug' },
  ]);
});

test('a row of an array is named by its index', () => {
  expect(entryProblems(show, { ...full, guests: [{ name: 'Ada' }, {}] })).toEqual([
    { path: 'guests.1.name', message: 'Required' },
  ]);
});

// A blocks() field is a union, so every block type reports on every block. The one the
// editor is looking at is the branch that did not fail on a reserved key.
test('a missing field inside a block is named on the field, not on the block', () => {
  const body = [
    { _type: 'prose', _id: 'b1', body: 'Hello' },
    { _type: 'hero', _id: 'b2' },
  ];
  expect(entryProblems(show, { ...full, body })).toEqual([
    { path: 'body.1.heading', message: 'Required' },
  ]);
});

test('a block whose type is in no branch is named on the block itself', () => {
  const body = [{ _type: 'gallery', _id: 'b1' }];
  expect(entryProblems(show, { ...full, body })).toEqual([
    { path: 'body.0', message: 'Invalid input' },
  ]);
});
