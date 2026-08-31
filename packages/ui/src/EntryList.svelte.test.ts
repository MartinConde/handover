import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import EntryList from './EntryList.svelte';

// Testing: one row per entry with the title the API returned, the derived file name the new
// entry dialog shows, what create / duplicate / rename / delete / hide send, which entries are
// offered the unpublished-changes question, the empty state, and the Deleted view's two rows — the one that can come back and the one that cannot.
// Not testing: which collection the sidebar routed here, the shell around the list, the bulk
// bar's own markup, or how one answer becomes a rule per language — that is the route's, and
// api.test.ts holds it to each of the four answers. Which rows the Deleted view gets, and why a
// row is blocked, are the route's too.

const ENTRIES = [
  {
    id: 'mill-house',
    locales: { en: { title: 'The Mill House', path: 'src/content/listings/en/mill-house.yaml' } },
  },
  {
    id: 'seaview-cottage',
    locales: {
      en: { title: 'Seaview Cottage', path: 'src/content/listings/en/seaview-cottage.yaml' },
    },
  },
];

let app: ReturnType<typeof mount>;
const changed = vi.fn();
// Loading the list is a bare GET; every action carries an init, which is what tells them apart.
const api = (
  entries: unknown[],
  reply: Record<string, unknown> = {},
  locales = ['en'],
  templates: string[] = [],
) => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    init
      ? Response.json(reply)
      : url === '/admin/api/entries'
        ? Response.json({ entries: [], locales })
        : Response.json({ entries, locales, index: '/listings', templates }),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};

const show = () => {
  app = mount(EntryList, {
    target: document.body,
    props: { collection: 'listings', onchanged: changed },
  });
  flushSync();
  return document.body;
};
afterEach(() => {
  unmount(app);
  changed.mockClear();
  vi.unstubAllGlobals();
});

const q = <T extends Element>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const tick = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const click = async (root: ParentNode, sel: string) => {
  q<HTMLButtonElement>(root, sel)?.click();
  await tick();
};
// The row's actions live behind one ⋯, as on Members: open it, then press the item by its words.
const menuItems = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('.row .menu button'), (b) =>
    b.textContent?.trim(),
  );
const act = async (root: ParentNode, title: string, item: string) => {
  await click(root, `.row [aria-label="Actions for ${title}"]`);
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>('.row .menu button')).find(
    (b) => b.textContent?.trim() === item,
  );
  if (!found) throw new Error(`no ${item} for ${title}`);
  found.click();
  await tick();
};
const input = (root: ParentNode, sel: string) => {
  const found = q<HTMLInputElement>(root, sel);
  if (!found) throw new Error(`no input matching ${sel}`);
  return found;
};
const type = (root: ParentNode, sel: string, value: string) => {
  const found = input(root, sel);
  found.value = value;
  found.dispatchEvent(new Event('input'));
  flushSync();
};

test('the list is one row per entry, titled and linked by file name', async () => {
  api(ENTRIES);
  const root = show();
  await tick();
  expect(q(root, '.list-toolbar .count')?.textContent).toBe('2');
  expect(Array.from(root.querySelectorAll('.row .td.title a'), (a) => a.textContent)).toEqual([
    'The Mill House',
    'Seaview Cottage',
  ]);
  expect(q<HTMLAnchorElement>(root, '.row .td.title a')?.getAttribute('href')).toBe(
    '/admin/c/listings/mill-house',
  );
});

test('a collection with no entries offers the one action that makes sense', async () => {
  api([]);
  const root = show();
  await tick();
  expect(root.querySelectorAll('.row').length).toBe(0);
  expect(q(root, '.empty h2')?.textContent).toBe('No listings yet');
  expect(q(root, '.empty .btn-primary')?.textContent?.trim()).toBe('New listing');
});

test('the new entry dialog shows the file name the title will produce', async () => {
  api(ENTRIES);
  const root = show();
  await tick();
  await click(root, '.list-toolbar .btn-primary');
  type(root, '.dialog input#new-title', 'Café & Bar / 2026');
  expect(q(root, '.dialog .filename')?.textContent).toBe('cafe-bar-2026');
});

test('a title already used in the collection previews the collision suffix', async () => {
  api(ENTRIES);
  const root = show();
  await tick();
  await click(root, '.list-toolbar .btn-primary');
  type(root, '.dialog input#new-title', 'Seaview Cottage');
  expect(q(root, '.dialog .filename')?.textContent).toBe('seaview-cottage-2');
});

test('creating sends the title and opens the entry the server named', async () => {
  const fetcher = api(ENTRIES, { slug: 'cafe-bar-2026' });
  const root = show();
  await tick();
  await click(root, '.list-toolbar .btn-primary');
  type(root, '.dialog input#new-title', 'Café & Bar / 2026');
  await click(root, '.dialog .btn-primary');

  expect(fetcher).toHaveBeenCalledWith('/admin/api/entries/listings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Café & Bar / 2026' }),
  });
});

test("the collection's starters are offered beside Blank, and the chosen one is sent", async () => {
  const fetcher = api(ENTRIES, { slug: 'strandhaus-nord' }, ['en'], ['house', 'flat-by-the-sea']);
  const root = show();
  await tick();
  await click(root, '.list-toolbar .btn-primary');

  expect(
    Array.from(root.querySelectorAll('.dialog fieldset .choice'), (c) =>
      c.textContent?.replace(/\s+/g, ' ').trim(),
    ),
  ).toEqual(['Blank', 'House template', 'Flat by the sea template']);

  type(root, '.dialog input#new-title', 'Strandhaus Nord');
  await click(root, '.dialog input[value="house"]');
  await click(root, '.dialog .btn-primary');

  expect(fetcher).toHaveBeenCalledWith('/admin/api/entries/listings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Strandhaus Nord', template: 'house' }),
  });
});

// A collection that ships none has nothing to choose between, so the question is not asked.
test('a collection with no starters has no Start from choice', async () => {
  api(ENTRIES);
  const root = show();
  await tick();
  await click(root, '.list-toolbar .btn-primary');
  expect(q(root, '.dialog fieldset')).toBeNull();
});

test('duplicating sends the pre-filled copy name and opens the copy', async () => {
  const fetcher = api(ENTRIES, { slug: 'mill-house-copy' });
  const root = show();
  await tick();
  await act(root, 'The Mill House', 'Duplicate');
  expect(input(root, '.dialog input#copy-to').value).toBe('mill-house-copy');
  await click(root, '.dialog .btn-primary');

  expect(fetcher).toHaveBeenCalledWith('/admin/api/entries/listings/mill-house/duplicate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'mill-house-copy' }),
  });
});

// The question only makes sense about an entry that has something unpublished to carry.
test('only an entry with unpublished changes is asked whether to include them', async () => {
  const fetcher = api([{ ...ENTRIES[0], pending: true }, ENTRIES[1]], { slug: 'x' });
  const root = show();
  await tick();
  await act(root, 'Seaview Cottage', 'Duplicate');
  expect(q(root, '.dialog input[type="checkbox"]')).toBeNull();
  await click(root, '.dialog .btn:not(.btn-primary)');

  await act(root, 'The Mill House', 'Duplicate');
  await click(root, '.dialog input[type="checkbox"]');
  await click(root, '.dialog .btn-primary');

  expect(fetcher).toHaveBeenCalledWith('/admin/api/entries/listings/mill-house/duplicate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'mill-house-copy', drafts: true }),
  });
});

test('renaming sends the new file name and reloads the list', async () => {
  const fetcher = api(ENTRIES, { slug: 'the-old-mill' });
  const root = show();
  await tick();
  await act(root, 'The Mill House', 'Rename');
  expect(input(root, '.dialog input#rename-to').value).toBe('mill-house');
  type(root, '.dialog input#rename-to', 'The Old Mill');
  await click(root, '.dialog .btn-primary');

  expect(fetcher).toHaveBeenCalledWith('/admin/api/entries/listings/mill-house/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'The Old Mill' }),
  });
  expect(changed).toHaveBeenCalled();
  expect(q(root, '.dialog')).toBeNull();
});

// A delete takes a page off the site the way a hide does, so it asks the same question — and
// answers it in the commit that removes the files rather than at the next publish.
test('deleting asks where its readers go and sends the answer with the DELETE', async () => {
  const fetcher = api(ENTRIES);
  const root = show();
  await tick();
  await act(root, 'The Mill House', 'Delete');
  expect(q(root, '.dialog h2')?.textContent).toBe('Where should visitors to this page go now?');
  expect(q(root, '.dialog .btn-danger')?.textContent?.trim()).toBe('Delete this listing');
  await click(root, '.dialog .btn-danger');

  expect(fetcher).toHaveBeenCalledWith('/admin/api/entries/listings/mill-house', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect: { kind: 'index' } }),
  });
  expect(changed).toHaveBeenCalled();
});

// Principle #5: the client will want it back. The dialog says so before the question.
test('the delete dialog leads with Hide it instead?, and Hide instead asks the hide question', async () => {
  const fetcher = api(ENTRIES);
  const root = show();
  await tick();
  await act(root, 'The Mill House', 'Delete');
  expect(q(root, '.dialog p')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Hide it instead? Hidden entries come off the site but can be brought back.',
  );
  Array.from(root.querySelectorAll<HTMLButtonElement>('.dialog button'))
    .find((b) => b.textContent?.trim() === 'Hide instead')
    ?.click();
  await tick();

  expect(q(root, '.dialog p')?.textContent).not.toContain('Hide it instead?');
  expect(q(root, '.dialog .btn-primary')?.textContent?.trim()).toBe('Hide this listing');
  await click(root, '.dialog .btn-primary');
  expect(fetcher).toHaveBeenCalledWith('/admin/api/status/listings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: ['mill-house'], hidden: true, redirect: { kind: 'index' } }),
  });
});

// "Nowhere" is one of the four answers, and the only one that leaves the old URL a 404.
test('a delete answered "nowhere" says so in the body', async () => {
  const fetcher = api(ENTRIES);
  const root = show();
  await tick();
  await act(root, 'The Mill House', 'Delete');
  const nowhere = Array.from(
    root.querySelectorAll<HTMLInputElement>('.dialog input[type="radio"]'),
  ).at(-1);
  nowhere?.click();
  await tick();
  await click(root, '.dialog .btn-danger');

  expect(fetcher).toHaveBeenCalledWith('/admin/api/entries/listings/mill-house', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect: { kind: 'none' } }),
  });
});

test('a refused rename says so and keeps the dialog open', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init
        ? new Response('Publish this entry before renaming it', { status: 409 })
        : Response.json({ entries: ENTRIES }),
    ),
  );
  const root = show();
  await tick();
  await act(root, 'The Mill House', 'Rename');
  await click(root, '.dialog .btn-primary');

  expect(q(root, '.dialog [role="alert"]')?.textContent).toContain('Publish this entry');
  expect(q(root, '.dialog')).not.toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

// Which languages an entry has a file in, one chip each in the order the site declares them.
// One language declared and the column is not drawn at all — nor emptied, nor always 1/1.
test('a row says which languages it has been written in', async () => {
  api(
    [
      ENTRIES[0],
      { id: 'impressum', locales: { de: { title: 'Impressum', path: 'x/de/impressum.yaml' } } },
    ],
    {},
    ['en', 'de'],
  );
  const root = show();
  await tick();

  expect(
    Array.from(root.querySelectorAll('.row'), (row) =>
      Array.from(
        row.querySelectorAll('.chips .chip'),
        (chip) =>
          `${chip.textContent?.trim()}${chip.classList.contains('chip-missing') ? '?' : ''}`,
      ),
    ),
  ).toEqual([
    ['EN', 'DE?'],
    ['EN?', 'DE'],
  ]);
});

// A language somebody turned off for the entry has no file and never will: struck through
// rather than listed as one still to write.
// A bare span may not carry an aria-label; the word is in the sentence instead, as History
// already had it, and axe stops flagging every row.
test('the language chips are introduced by a word, not labelled on a span', async () => {
  api(ENTRIES, {}, ['en', 'de']);
  const root = show();
  await tick();

  const chips = q(root, '.row .chips');
  expect(chips?.hasAttribute('aria-label')).toBe(false);
  expect(chips?.previousElementSibling?.textContent).toBe('Languages:');
});

test('a language turned off for an entry is struck through, not counted as missing', async () => {
  api([{ ...ENTRIES[0], offered: ['en'] }], {}, ['en', 'de']);
  const root = show();
  await tick();

  const de = root.querySelectorAll('.chips .chip')[1];
  expect(de?.classList.contains('chip-disabled')).toBe(true);
  expect(de?.classList.contains('chip-missing')).toBe(false);
});

test('a site that declares one language has no languages column', async () => {
  api(ENTRIES);
  const root = show();
  await tick();

  expect(q(root, '.chips')).toBeNull();
  expect(Array.from(root.querySelectorAll('.th'), (th) => th.textContent)).not.toContain(
    'Languages',
  );
});

test('an entry written only in a second language is listed by the words it has', async () => {
  api(
    [{ id: 'impressum', locales: { de: { title: 'Impressum', path: 'x/de/impressum.yaml' } } }],
    {},
    ['en', 'de'],
  );
  const root = show();
  await tick();

  expect(q(root, '.row .td.title a')?.textContent).toBe('Impressum');
});

const HIDDEN = [
  {
    id: 'mill-house',
    locales: {
      en: {
        title: 'The Mill House',
        path: 'src/content/listings/en/mill-house.yaml',
        status: 'hidden',
      },
    },
  },
  ENTRIES[1],
];

// The walker's own open entry, seen from the list in another tab: the badge names the holder.
test('a row somebody has open says who is editing it', async () => {
  api([{ ...ENTRIES[0], editing: { id: 'u2', name: 'Anna Berg' } }, ENTRIES[1] as object]);
  const root = show();
  await tick();

  expect(
    Array.from(
      root.querySelectorAll('.row .td.title'),
      (td) => td.querySelector('.badge')?.textContent,
    ),
  ).toEqual(['Being edited by Anna Berg', undefined]);
});

// The dashboard's line, on the row itself: who typed the draft, or who published the last one.
test('each row says who last touched it, and with which verb', async () => {
  const now = Date.now();
  api([
    { ...ENTRIES[0], edited: { at: now - 2 * 3_600_000, by: 'Anna Berg', kind: 'edit' } },
    { ...ENTRIES[1], edited: { at: now - 30 * 60_000, by: null, kind: 'publish' } },
  ]);
  const root = show();
  await tick();

  expect(
    Array.from(root.querySelectorAll('.row .td.edited'), (td) =>
      td.textContent?.replace(/\s+/g, ' ').trim(),
    ),
  ).toEqual(['Edited by Anna Berg 2h ago', 'Published 30 min ago']);
});

const titles = (root: ParentNode) =>
  Array.from(root.querySelectorAll('.row .td.title a'), (a) => a.textContent);

test('the status filter narrows the list to the hidden rows, or to the live ones', async () => {
  api(HIDDEN);
  const root = show();
  await tick();
  const status = q<HTMLSelectElement>(root, 'select#list-status');
  if (!status) throw new Error('status filter missing');

  status.value = 'hidden';
  status.dispatchEvent(new Event('change'));
  await tick();
  expect(titles(root)).toEqual(['The Mill House']);

  status.value = 'live';
  status.dispatchEvent(new Event('change'));
  await tick();
  expect(titles(root)).toEqual(['Seaview Cottage']);
});

test('a hidden entry is badged and offers to be shown again', async () => {
  api(HIDDEN);
  const root = show();
  await tick();

  expect(Array.from(root.querySelectorAll('.row .td.title .badge'), (b) => b.textContent)).toEqual([
    'Hidden',
  ]);
  await click(root, '.row [aria-label="Actions for The Mill House"]');
  expect(menuItems(root)).toEqual(['Duplicate', 'Rename', 'Show', 'Delete']);
  await click(root, '.row [aria-label="Actions for Seaview Cottage"]');
  expect(menuItems(root)).toEqual(['Duplicate', 'Rename', 'Hide', 'Delete']);
});

// One ⋯ per row where there were four buttons, which is what the design set draws and what
// stopped fitting on a phone. A disclosure, as on Members: Escape and a click elsewhere close it.
test("a row's actions are one menu, closed by Escape and by a click outside", async () => {
  api(ENTRIES);
  const root = show();
  await tick();
  expect(root.querySelectorAll('.row .menu-cell button')).toHaveLength(2);

  await click(root, '.row [aria-label="Actions for The Mill House"]');
  expect(
    q(root, '.row [aria-label="Actions for The Mill House"]')?.getAttribute('aria-expanded'),
  ).toBe('true');
  expect(root.querySelectorAll('.row .menu')).toHaveLength(1);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  flushSync();
  expect(root.querySelectorAll('.row .menu')).toHaveLength(0);

  await click(root, '.row [aria-label="Actions for The Mill House"]');
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();
  expect(root.querySelectorAll('.row .menu')).toHaveLength(0);
});

// The one status change with a consequence outside the CMS, so the row never just makes it.
test('hiding a row asks where its readers go and sends the answer', async () => {
  const fetcher = api(ENTRIES);
  const root = show();
  await tick();

  await act(root, 'The Mill House', 'Hide');
  expect(q(root, '.dialog h2')?.textContent).toBe('Where should visitors to this page go now?');
  expect(q(root, '.dialog .choice .desc')?.textContent).toBe('/listings');
  await click(root, '.dialog .btn-primary');

  expect(fetcher).toHaveBeenCalledWith('/admin/api/status/listings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: ['mill-house'], hidden: true, redirect: { kind: 'index' } }),
  });
  expect(changed).toHaveBeenCalled();
});

// Nothing goes away, so there is nothing to ask about: the page comes back at its own address.
test('showing an entry again asks nothing', async () => {
  const fetcher = api(HIDDEN);
  const root = show();
  await tick();

  await act(root, 'The Mill House', 'Show');

  expect(q(root, '.dialog')).toBeNull();
  expect(fetcher).toHaveBeenCalledWith('/admin/api/status/listings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: ['mill-house'], hidden: false, redirect: undefined }),
  });
});

// Sold listings arrive in batches, so the question is asked once and answered for all of them.
test('a bulk hide asks once and names every selected entry', async () => {
  const fetcher = api(ENTRIES);
  const root = show();
  await tick();

  for (const box of Array.from(
    root.querySelectorAll<HTMLInputElement>('.row input[type="checkbox"]'),
  )) {
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await tick();
  expect(q(root, '.bulk-bar')?.textContent).toContain('2 selected');

  await click(root, '.bulk-bar .btn-sm:not(.btn-ghost)');
  expect(q(root, '.dialog .btn-primary')?.textContent?.trim()).toBe('Hide 2 listings');
  await click(root, '.dialog .btn-primary');

  expect(fetcher).toHaveBeenCalledWith('/admin/api/status/listings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      entries: ['mill-house', 'seaview-cottage'],
      hidden: true,
      redirect: { kind: 'index' },
    }),
  });
});

const DELETED = [
  {
    id: 'a1',
    at: Date.UTC(2026, 7, 12, 9, 14),
    by: 'Martin',
    slug: 'old-mill-house',
    locales: ['en', 'de'],
    whole: true,
    commit_sha: 'del111',
  },
  {
    id: 'a2',
    at: Date.UTC(2026, 7, 2, 11, 40),
    by: 'Anna',
    slug: 'cliff-road-cabin',
    locales: ['en'],
    whole: false,
    commit_sha: 'off222',
    blocked:
      'There is a file at src/content/listings/en/cliff-road-cabin.yaml again, so this cannot be put back over it.',
  },
];

// The tab answers from the log rather than from the list, so it is its own request.
const withDeleted = (reply: Record<string, unknown> = {}) => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    init
      ? Response.json(reply)
      : url === '/admin/api/deleted/listings'
        ? Response.json({ deleted: DELETED })
        : Response.json({ entries: ENTRIES, locales: ['en'], index: '/listings' }),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};

test('the deleted view says what went and who took it away', async () => {
  withDeleted();
  const root = show();
  await tick();
  await click(root, '.tabs button:last-child');
  await tick();

  const rows = Array.from(root.querySelectorAll('.table .row:not(.row-note)'));
  expect(q(rows[0] as ParentNode, '.td.title')?.textContent).toBe('old-mill-house');
  expect(q(rows[0] as ParentNode, '.td:nth-child(2)')?.textContent).toContain('The whole listing');
  expect(q(rows[0] as ParentNode, '.td.num')?.textContent).toContain('Martin');
});

// Greyed rather than gone, with the reason under the row: a disabled button takes no focus, and
// a keyboard user would arrow past the sentence without ever hearing it.
test('a row whose file is there again keeps its button and says why', async () => {
  const fetcher = withDeleted();
  const root = show();
  await tick();
  await click(root, '.tabs button:last-child');
  await tick();

  const blocked = root.querySelectorAll('.table .row:not(.row-note)')[1] as ParentNode;
  const button = q<HTMLButtonElement>(blocked, 'button');
  expect(button?.getAttribute('aria-disabled')).toBe('true');
  expect(q(root, '.row-note .notice')?.textContent).toContain("Can't be restored");
  button?.click();
  await tick();
  expect(q(root, '.dialog')).toBeNull();
  expect(fetcher).not.toHaveBeenCalledWith('/admin/api/restore', expect.anything());
});

test('restoring undoes the commit the row names', async () => {
  const fetcher = withDeleted({ commit_sha: 'res888' });
  const root = show();
  await tick();
  await click(root, '.tabs button:last-child');
  await tick();
  await click(root, '.table .row .menu-cell button');
  expect(q(root, '.dialog h2')?.textContent).toBe('Restore old-mill-house?');
  await click(root, '.dialog .btn-primary');

  expect(fetcher).toHaveBeenCalledWith('/admin/api/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commit_sha: 'del111' }),
  });
  expect(changed).toHaveBeenCalled();
});
