import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Drift from './Drift.svelte';

// Testing: the answers each row allows, which come from what has the block against what should
// have it and not from a fixed three; and what Apply sends for the one that was picked.
// Not testing: the banner above it or the chrome the panel sits in.

const STRAY = {
  path: 'blocks[_id=z9y8x7w6]',
  type: 'quote',
  in: ['de'],
  expected: ['en', 'de'],
  values: { de: ['Ein seltener Fund.'] },
};
const MARKED = {
  path: 'blocks[_id=p8xk2m4q]',
  type: 'compliance',
  in: ['en', 'de'],
  expected: ['de'],
  values: { en: ['Right to cancel'], de: ['Widerrufsbelehrung'] },
};

let app: ReturnType<typeof mount>;
const resolved = vi.fn();
const show = (drift = [STRAY]) => {
  app = mount(Drift, {
    target: document.body,
    props: {
      collection: 'pages',
      slug: 'home',
      drift,
      locales: ['en', 'de'],
      onresolved: resolved,
    },
  });
  flushSync();
  return document.body;
};
afterEach(() => {
  unmount(app);
  resolved.mockClear();
  vi.unstubAllGlobals();
});

const labels = (root: ParentNode, card = 0) =>
  Array.from(
    root.querySelectorAll(`.block-card:nth-of-type(${card + 1}) .choice > span:first-of-type`),
    (n) => n.textContent,
  );
const tick = () => new Promise((r) => setTimeout(r, 0));
const columns = (root: ParentNode) =>
  Array.from(root.querySelectorAll('.drift-cols > div'), (n) =>
    (n.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

test('a block nothing says is one language’s can be added, dropped or marked', () => {
  expect(labels(show())).toEqual([
    'Add it to English',
    'Keep it in German only',
    'Remove it from German',
  ]);
});

test('a block in a language its mark leaves out has the two answers the mark allows', () => {
  expect(labels(show([MARKED]))).toEqual(['Remove it from English', 'Let it be in every language']);
});

test('Apply sends the languages the answer picked means', async () => {
  const fetchMock = vi.fn(async () => Response.json({}));
  vi.stubGlobal('fetch', fetchMock);
  const root = show([STRAY, MARKED]);

  root.querySelectorAll<HTMLInputElement>('.choice input')[1]?.click();
  root.querySelectorAll<HTMLInputElement>('.choice input')[4]?.click();
  flushSync();
  root.querySelector<HTMLButtonElement>('.actions .btn-primary')?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith(
    '/admin/api/drift/pages/home',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        choices: [
          { path: STRAY.path, locales: ['de'] },
          { path: MARKED.path, locales: ['en', 'de'] },
        ],
      }),
    }),
  );
  expect(resolved).toHaveBeenCalled();
});

test('Apply waits until every block has been answered', () => {
  const root = show([STRAY, MARKED]);
  const apply = root.querySelector<HTMLButtonElement>('.actions .btn-primary');

  expect(apply?.disabled).toBe(true);
  expect(root.querySelector('.actions .left')?.textContent).toBe('0 of 2 answered');

  root.querySelector<HTMLInputElement>('.choice input')?.click();
  flushSync();

  expect(apply?.disabled).toBe(true);
  expect(root.querySelector('.actions .left')?.textContent).toBe('1 of 2 answered');
});

// A card names files until it can name words: removing a block from English is losing what is
// written there, and nobody should answer that against a file name.
test('a card shows what each language says in the block it is deciding about', () => {
  const root = show([MARKED]);

  expect(columns(root)).toEqual(['English Right to cancel', 'German Widerrufsbelehrung']);
});

test('a language that does not have the block says so rather than showing nothing', () => {
  const root = show([STRAY]);

  expect(columns(root)).toEqual(['English Not in this language', 'German Ein seltener Fund.']);
});
