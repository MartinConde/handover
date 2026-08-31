import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import History from './History.svelte';

// Testing: what a version row says, the locale filter, the empty and error states, what opening
// a version and picking a pair ask for, and the cap on the pair.
// Not testing: the per-field diff, which is Diff.svelte's own, or the tab that mounts this.

type Version = {
  sha: string;
  date: string;
  summary: string;
  locales: string[];
  author?: string;
};

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

let app: ReturnType<typeof mount>;
let asked: string[] = [];
let versions: Version[] = [];
let more = false;
let refusal: number | undefined;

const show = async (locales = ['en', 'de']) => {
  asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      if (refusal) return new Response('nope', { status: refusal });
      if (url.includes('/diff?')) return Response.json({ groups: [] });
      return Response.json({ versions, more });
    }),
  );
  app = mount(History, {
    target: document.body,
    props: { collection: 'listings', slug: 'mill-house', locales },
  });
  await settle();
  return document.body;
};

const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  versions = [];
  more = false;
  refusal = undefined;
});

const q = <T extends Element>(sel: string) => {
  const el = document.body.querySelector<T>(sel);
  if (!el) throw new Error(`${sel} missing`);
  return el;
};
const all = (sel: string) => Array.from(document.body.querySelectorAll(sel));
const click = async (el: Element) => {
  (el as HTMLElement).click();
  await settle();
};
const rows = () =>
  all('.version-row').map((row) => [
    row.querySelector('.summary')?.textContent?.trim(),
    row.querySelector('.sub')?.textContent?.trim().replace(/\s+/g, ' '),
  ]);

// The entry is one thing to the client, so a commit that wrote both files wears both chips —
// and the sha is a tooltip rather than a column, because this is an editor's history.
test('a version says what changed, when, who and which languages', async () => {
  versions = [
    {
      sha: 'aaa111bbb222',
      date: ago(2),
      summary: 'Update price',
      locales: ['en', 'de'],
      author: 'Anna Weber',
    },
  ];
  await show();

  expect(rows()).toEqual([['Update price', '2h ago · Anna Weber Languages: ENDE']]);
  expect(q('.summary').getAttribute('title')).toBe('Commit aaa111b');
  expect(q('.avatar').textContent).toBe('AW');
});

// A commit the App made whose activity row has aged out has nobody against it, and a blank is
// honest where the App's own name would not be.
test('a version nobody is recorded against says only when it happened', async () => {
  versions = [
    { sha: 'aaa111', date: ago(3), summary: 'Update listings/en/mill-house', locales: ['en'] },
  ];
  await show();

  expect(rows()).toEqual([['Update listings/en/mill-house', '3h ago Languages: EN']]);
  expect(all('.version-row .avatar')).toHaveLength(0);
});

test('the locale filter leaves the commits that touched that language', async () => {
  versions = [
    { sha: 'aaa111', date: ago(2), summary: 'Update price', locales: ['en', 'de'] },
    { sha: 'bbb222', date: ago(5), summary: 'Translate', locales: ['de'] },
    { sha: 'ccc333', date: ago(9), summary: 'Create', locales: ['en'] },
  ];
  await show();

  const [, , de] = all('.version-tools .seg button');
  await click(de as Element);

  expect(rows().map((r) => r[0])).toEqual(['Update price', 'Translate']);
});

// Not an error and not an empty filter: the tab is reachable so the client learns where history
// will be, and the sentence says what it is waiting for.
test('an entry with no commits says nothing is published yet', async () => {
  await show();

  expect(q('.empty h2').textContent).toBe('Nothing published yet');
  expect(q<HTMLAnchorElement>('.empty a').getAttribute('href')).toBe(
    '/admin/c/listings/mill-house',
  );
});

test('a GitHub that would not answer is a notice with a way to ask again', async () => {
  refusal = 403;
  await show();

  expect(q('.notice-danger').textContent).toContain('Try again in a few minutes');
  refusal = undefined;
  versions = [{ sha: 'aaa111', date: ago(2), summary: 'Update price', locales: ['en'] }];
  await click(q('.notice-danger button'));

  expect(rows().map((r) => r[0])).toEqual(['Update price']);
});

// What is marked is what restoring this version would change, so the version is asked for on
// its own and the other side is what is live now.
test('opening a version asks for its changes against what is live now', async () => {
  versions = [{ sha: 'aaa111', date: ago(50), summary: 'Update price', locales: ['en'] }];
  await show();

  await click(q('.summary'));

  expect(asked.at(-1)).toBe('/admin/api/history/listings/mill-house/diff?to=aaa111');
  expect(q('.version-head h2').textContent).toContain('Version from 2 days ago');
  expect(q('.version-head .by').textContent).toContain('compared with what is live now');
});

// Two chosen is a pair, and the older of them is the side the newer is read against.
test('a pair is compared oldest first', async () => {
  versions = [
    { sha: 'aaa111', date: ago(2), summary: 'Update price', locales: ['en'] },
    { sha: 'bbb222', date: ago(50), summary: 'Create', locales: ['en'] },
  ];
  await show();
  const [first, second] = all('.version-row input') as HTMLInputElement[];

  first?.click();
  await settle();
  second?.click();
  await settle();

  expect(asked.at(-1)).toBe('/admin/api/history/listings/mill-house/diff?to=aaa111&from=bbb222');
  expect(q('.version-head h2').textContent).toBe('Two versions compared');
  // Both of these would read "2 days ago" on a busy afternoon, so the pair is named by what
  // each version says.
  expect(q('.version-head .by').textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'From Create, 2 days ago, to Update price, 2h ago',
  );
});

// A third would be a comparison of nothing: the count line says how many are chosen and the
// rest of the boxes stop offering.
test('a third version cannot be added to a pair', async () => {
  versions = [
    { sha: 'aaa111', date: ago(2), summary: 'Update price', locales: ['en'] },
    { sha: 'bbb222', date: ago(30), summary: 'Translate', locales: ['en'] },
    { sha: 'ccc333', date: ago(50), summary: 'Create', locales: ['en'] },
  ];
  await show();
  const boxes = all('.version-row input') as HTMLInputElement[];

  boxes[0]?.click();
  await settle();
  boxes[1]?.click();
  await settle();

  expect(boxes.map((b) => b.disabled)).toEqual([false, false, true]);
  expect(q('.version-tools [role="status"]').textContent).toBe('2 of 2 chosen to compare');
});

test('a site with one language has no filter to draw', async () => {
  versions = [{ sha: 'aaa111', date: ago(2), summary: 'Update price', locales: ['en'] }];
  await show(['en']);

  expect(all('.version-tools .seg')).toHaveLength(0);
});

test('older versions are asked for by page', async () => {
  versions = [{ sha: 'aaa111', date: ago(2), summary: 'Update price', locales: ['en'] }];
  more = true;
  await show();

  await click(q('.load-more button'));

  expect(asked.at(-1)).toBe('/admin/api/history/listings/mill-house?page=2');
});
