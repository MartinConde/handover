import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Resolve from './Resolve.svelte';

// Testing: the two questions a report can ask — a value and a sentence — the answers Done sends
// back, Done staying off until every one of them is answered, the shortcut that answers them all
// at once, the merged list naming which side moved each field, and a report with nothing to
// answer. Not testing: the loading line or the panel's chrome.

const QUESTIONS = [
  {
    path: 'price',
    label: 'Price',
    base: '450000',
    ours: { path: 'price', label: 'Price', kind: 'value', before: '450000', after: '435000' },
    theirs: { path: 'price', label: 'Price', kind: 'value', before: '450000', after: '440000' },
  },
  {
    path: 'summary',
    label: 'Summary',
    locale: 'en',
    base: 'A cottage above the harbour',
    ours: {
      path: 'summary',
      label: 'Summary',
      kind: 'words',
      parts: [
        { text: 'A cottage above the ' },
        { text: 'harbour', mark: 'del' },
        { text: 'fish market', mark: 'ins' },
      ],
    },
    theirs: {
      path: 'summary',
      label: 'Summary',
      kind: 'words',
      parts: [{ text: 'A whitewashed cottage', mark: 'ins' }],
    },
  },
];
const MERGED = [
  {
    locale: 'de',
    label: 'Zusammenfassung',
    side: 'ours',
    change: { path: 'summary', label: 'Zusammenfassung', kind: 'words', parts: [] },
  },
  {
    label: 'Bedrooms',
    side: 'theirs',
    change: { path: 'bedrooms', label: 'Bedrooms', kind: 'value', before: '2', after: '3' },
  },
];

let app: ReturnType<typeof mount>;
const resolved = vi.fn();
const closed = vi.fn();
const answering = (questions: unknown[] = QUESTIONS, merged: unknown[] = MERGED) => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? Response.json({})
      : Response.json({ head: 'a1c9f2b0000', questions, merged }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const show = () => {
  app = mount(Resolve, {
    target: document.body,
    props: {
      entry: 'listings/seaview-cottage',
      title: 'Seaview Cottage',
      updated: 1755864000000,
      onclose: closed,
      onresolved: resolved,
    },
  });
  flushSync();
  return document.body;
};
afterEach(() => {
  unmount(app);
  resolved.mockClear();
  closed.mockClear();
  vi.unstubAllGlobals();
});

const q = <T extends Element>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const all = (root: ParentNode, sel: string) => Array.from(root.querySelectorAll(sel));
const tick = () => new Promise((r) => setTimeout(r, 0));
const sides = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLInputElement>('.resolve-field .choice input'));

test('a question names what both sides started from before it offers the two answers', async () => {
  answering();
  const root = show();
  await tick();
  flushSync();

  expect(all(root, '.resolve-field .head .name').map((n) => n.textContent)).toEqual([
    'Price',
    'Summary',
  ]);
  expect(q(root, '.resolve-field .base')?.textContent).toBe('You both started from 450000');
  // A value is short enough to read on the answer itself; a sentence is quoted under it.
  expect(all(root, '.resolve-field .choice b').map((n) => n.textContent?.trim())).toEqual([
    'Yours — 435000',
    'Theirs — 440000',
    'Yours',
    'Theirs',
  ]);
  // The side says what it *is*, with what it added marked — the words it took out are not
  // drawn twice against the base line above.
  expect(q(root, '.resolve-field .quote ins')?.textContent).toBe('fish market');
  expect(q(root, '.resolve-field .quote')?.textContent).toBe('A cottage above the fish market');
  expect(q(root, '.resolve-field .quote del')).toBe(null);
  // The shared value says so, and the one language's own says which language.
  expect(q(root, '.resolve-field .badge')?.textContent).toBe('Same in every language');
  expect(q(root, '.resolve-field .chip')?.textContent).toBe('EN');
});

test('Done stays off until every question is answered, and sends one answer each', async () => {
  const fetchMock = answering();
  const root = show();
  await tick();
  flushSync();
  const done = q<HTMLButtonElement>(root, '.actions .btn-primary');

  expect(done?.disabled).toBe(true);
  expect(done?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Done — 0 of 2 answered');
  sides(root)[0]?.click();
  flushSync();
  expect(done?.disabled).toBe(true);
  expect(done?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Done — 1 of 2 answered');
  sides(root)[3]?.click();
  flushSync();
  expect(done?.disabled).toBe(false);

  done?.click();
  await tick();

  expect(fetchMock).toHaveBeenLastCalledWith('/admin/api/conflict/listings/seaview-cottage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      answers: [
        { path: 'price', side: 'ours' },
        { path: 'summary', locale: 'en', side: 'theirs' },
      ],
    }),
  });
  expect(resolved).toHaveBeenCalled();
});

test('Keep all mine answers every question at once and says what that costs', async () => {
  const fetchMock = answering();
  const root = show();
  await tick();
  flushSync();

  expect(q(root, '.resolve-shortcuts .sub')?.textContent?.replace(/\s+/g, ' ')).toContain(
    "Keep all mine undoes the developer's change to 2 fields.",
  );
  q<HTMLButtonElement>(root, '.resolve-shortcuts .btn')?.click();
  await tick();

  expect(JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body))).toEqual({
    answers: [
      { path: 'price', side: 'ours' },
      { path: 'summary', locale: 'en', side: 'ours' },
    ],
  });
});

test('what was merged says which side moved it, and is counted rather than read', async () => {
  answering();
  const root = show();
  await tick();
  flushSync();

  expect(q(root, '.group > summary')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Merged for you 2',
  );
  expect(
    all(root, '.merged-list .sub').map((n) => n.textContent?.replace(/\s+/g, ' ').trim()),
  ).toEqual(['rewritten — only you changed it', '2 → 3 — only the code changed it']);
});

test('a conflict where nobody wrote over anybody is one press with nothing to answer', async () => {
  answering([]);
  const root = show();
  await tick();
  flushSync();

  expect(q(root, '.resolve > header p')?.textContent?.replace(/\s+/g, ' ')).toContain(
    'Nothing was changed by both of you, so there is nothing to answer.',
  );
  expect(q(root, '.resolve-shortcuts')).toBe(null);
  const done = q<HTMLButtonElement>(root, '.actions .btn-primary');
  expect(done?.disabled).toBe(false);
  expect(done?.textContent?.trim()).toBe('Done');
});

test('a conflict somebody else has already settled says so in the server’s words', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('This entry has not changed in the repository since it was opened', {
          status: 409,
        }),
    ),
  );
  const root = show();
  await tick();
  flushSync();

  expect(q(root, '[role="alert"]')?.textContent).toBe(
    'This entry has not changed in the repository since it was opened',
  );
  expect(q(root, '.resolve-list')).toBe(null);
});
