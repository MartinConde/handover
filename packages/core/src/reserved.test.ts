import { expect, test } from 'vitest';
import { parseEntry, stringifyEntry } from './content.js';
import { filterLive, isLive, newId, regenerateIds } from './reserved.js';

const roundTrip = (data: unknown) => parseEntry('default', stringifyEntry('default', data));

test.each([
  ['_version', { _version: 1, title: 'Home' }],
  ['_id', { blocks: [{ _type: 'cta', _id: 'k3nf9a2p', heading: 'Hi' }] }],
  ['_status', { _status: 'hidden', title: 'Sold' }],
  ['_machine', { _machine: ['body', 'blocks[_id=k3nf9a2p].heading'], body: 'x' }],
  ['_locales', { blocks: [{ _type: 'cta', _id: 'p8xk2m4q', _locales: ['de'] }] }],
  ['_locales on the entry', { _locales: ['en'], title: 'Seaview Cottage' }],
  ['_ref', { blocks: [{ _type: 'cta', _id: 'k3nf9a2p', _ref: 'globals/cta-newsletter' }] }],
  [
    '_i18n',
    {
      _i18n: {
        sourceLocale: 'en',
        sourceBlob: '3f9c2e1a7b',
        sourceHash: '8f3a1c',
        translatedAt: '2026-08-20T10:14:00Z',
      },
    },
  ],
])('%s survives a serialise → parse round trip', (_key, data) => {
  expect(roundTrip(data)).toEqual(data);
});

test.each([
  ['_version: "1"', '_version'],
  ['_status: draft', '_status'],
  ['_status: hidden\nblocks:\n  - _id: "k3nf9a2p"\n    _status: hidden', 'blocks[0]._status'],
  ['blocks:\n  - _id: "ABCDEFGH"', 'blocks[0]._id'],
  ['blocks:\n  - _id: "k3nf9a2p"\n    _locales: []', 'blocks[0]._locales'],
  ['_machine: "body"', '_machine'],
  ['_ref: 7', '_ref'],
  ['_i18n: "en"', '_i18n'],
  ['_locales: []', '_locales'],
])('parse rejects malformed %j naming the path', (yaml, path) => {
  expect(() => parseEntry('default', yaml)).toThrow(path);
});

test('newId is eight lowercase alphanumerics', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newId('default')));
  for (const id of ids) expect(id).toMatch(/^[0-9a-z]{8}$/);
  expect(ids.size).toBe(200);
});

const page = {
  _version: 1,
  _machine: ['blocks[_id=k3nf9a2p].heading', 'blocks[_id=q1w2e3r4].columns[_id=z9y8x7w6].body'],
  blocks: [
    { _type: 'cta', _id: 'k3nf9a2p', heading: 'Hi' },
    {
      _type: 'columns',
      _id: 'q1w2e3r4',
      columns: [{ _id: 'z9y8x7w6', blocks: [{ _type: 'cta', _id: 'a1b2c3d4' }] }],
    },
  ],
};
const collectIds = (value: unknown, out: string[] = []): string[] => {
  if (Array.isArray(value)) for (const v of value) collectIds(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value))
      k === '_id' ? out.push(v as string) : collectIds(v, out);
  }
  return out;
};

test('regenerateIds replaces every _id at every depth and keeps the rest', () => {
  const copy = regenerateIds('default', page);
  const before = collectIds(page);
  const after = collectIds(copy);
  expect(before).toHaveLength(4);
  expect(after).toHaveLength(4);
  expect(after.filter((id) => before.includes(id))).toEqual([]);
  for (const id of after) expect(id).toMatch(/^[0-9a-z]{8}$/);
  expect(new Set(after).size).toBe(4);
  expect(copy.blocks[0]?.heading).toBe('Hi');
  expect(collectIds(page)).toEqual(before);
});

test('regenerateIds rewrites _machine paths to the new ids', () => {
  const copy = regenerateIds('default', page);
  const [cta, columns, inner] = collectIds(copy.blocks);
  expect(copy._machine).toEqual([
    `blocks[_id=${cta}].heading`,
    `blocks[_id=${columns}].columns[_id=${inner}].body`,
  ]);
});

// A hand-written template arrives with no `_id` anywhere — the form gives every row it adds
// one, so an entry made from that file owes its rows the same.
test('regenerateIds gives an array item that never had an _id one of its own', () => {
  const copy = regenerateIds('default', {
    title: 'New listing',
    blocks: [{ _type: 'hero', heading: 'Move to the coast' }],
    tags: ['sea', 'devon'],
  });
  const [id, ...rest] = collectIds(copy);
  expect(id).toMatch(/^[0-9a-z]{8}$/);
  expect(rest).toEqual([]);
  // A scalar has nothing to hang an id on, and gets none.
  expect(copy.tags).toEqual(['sea', 'devon']);
});

test('a shared map gives two locale files the same new ids', () => {
  const ids = new Map<string, string>();
  const en = regenerateIds('default', page, ids);
  const de = regenerateIds('default', { ...page, blocks: [page.blocks[0]] }, ids);
  expect(collectIds(de)).toEqual(collectIds(en).slice(0, 1));
});

test('isLive is true only when _status is absent', () => {
  expect(isLive('default', { title: 'x' })).toBe(true);
  expect(isLive('default', { _status: 'hidden' })).toBe(false);
});

test('filterLive drops entries with a _status', () => {
  const live = { id: 'en/a', data: { title: 'a' } };
  const hidden = { id: 'en/b', data: { _status: 'hidden', title: 'b' } };
  expect(filterLive('default', [live, hidden])).toEqual([live]);
});

test('a locale the entry is not offered in is not live in it', () => {
  const both = { title: 'x' };
  const english = { _locales: ['en'], title: 'x' };
  expect(isLive('default', both, 'de')).toBe(true);
  expect(isLive('default', english, 'de')).toBe(false);
  expect(isLive('default', english, 'en')).toBe(true);
  expect(isLive('default', { _status: 'hidden', _locales: ['en', 'de'] }, 'de')).toBe(false);
});
