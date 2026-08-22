import { expect, test } from 'vitest';
import { parseEntry, staticSource, stringifyEntry } from './content.js';

const entries = [
  { id: 'en/mill-house', data: { title: 'Mill House' } },
  { id: 'de/mill-house', data: { title: 'Mühlenhaus' } },
  { id: 'english/not-a-locale', data: { title: 'Trap' } },
];

const source = staticSource<{ listings: { title: string } }>('default', {
  getEntry: async (_c, id) => entries.find((e) => e.id === id),
  getCollection: async () => entries,
});

test('getCollection keeps only entries under the locale folder', async () => {
  const got = await source.getCollection('listings', 'en');
  expect(got).toEqual([{ id: 'en/mill-house', data: { title: 'Mill House' } }]);
});

test('getEntry returns undefined for a missing id', async () => {
  expect(await source.getEntry('listings', 'fr/mill-house')).toBeUndefined();
});

test('stringifyEntry writes the demo file shape back unchanged, long lines unfolded', () => {
  const file =
    'title: Seaview Cottage\nlocation: Port Isaac, Cornwall\nprice: £1,200 per week\nsummary: A whitewashed two-bedroom cottage above the harbour, with a slate terrace that catches the evening sun and a five-minute walk down to the fish market.\n';
  expect(stringifyEntry('default', parseEntry('default', file))).toBe(file);
});
