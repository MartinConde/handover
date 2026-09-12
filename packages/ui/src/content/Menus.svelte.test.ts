import { parseEntry, stringifyEntry } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { invalidateEntryDirectory } from '../entry-directory.js';
import Menus, { type Menu } from './Menus.svelte';

// Not tested: the Fields dispatch (glue) or styling.

/** Everything the picker offers, as `/admin/api/entries` answers it. */
const OFFERED = [
  {
    collection: 'pages',
    path: 'pages/contact',
    title: 'Contact',
    locales: ['en', 'de'],
    urls: { en: '/contact', de: '/de/kontakt' },
  },
  {
    collection: 'pages',
    path: 'pages/impressum',
    title: 'Impressum',
    locales: ['de'],
    urls: { de: '/de/impressum' },
  },
  {
    collection: 'listings',
    path: 'listings/mill-house',
    title: 'Old Mill House',
    titles: { en: 'Old Mill House', de: 'Das Mühlenhaus' },
    hiddenLocales: ['en'],
    locales: ['en', 'de'],
    hidden: true,
    urls: { en: '/listings/mill-house', de: '/de/objekte/muehlenhaus' },
  },
];

/** The collections with an index page, which a menu can point at though no file is one. */
const INDEXES = [
  {
    collection: 'listings',
    index: true,
    path: 'listings',
    title: 'Listings',
    locales: ['en', 'de'],
    urls: { en: '/listings', de: '/de/listings' },
  },
];

let app: ReturnType<typeof mount>;
let menus: Menu[] = $state([]);
const show = (items: unknown[] = [], keys = ['header'], translating = false, locale = 'en') => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ entries: OFFERED, indexes: INDEXES, locales: ['en', 'de'] })),
  );
  menus = keys.map((key, i) => ({
    _id: `menu${i}aaa`,
    key,
    items: i === 0 ? items : [],
  })) as Menu[];
  app = mount(Menus, {
    target: document.body,
    props: {
      id: 'f-menus',
      labelId: 'f-menus-l',
      locale,
      menus,
      translating,
      sourceLabel: 'English',
    },
  });
  flushSync();
  return document.body;
};
afterEach(() => {
  unmount(app);
  invalidateEntryDirectory();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('an unavailable catalogue does not label stored menu targets as missing', async () => {
  invalidateEntryDirectory();
  let attempts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('unavailable', { status: 503 })
        : Response.json({ entries: OFFERED, indexes: INDEXES, locales: ['en', 'de'] });
    }),
  );
  menus = [
    {
      _id: 'menu0aaa',
      key: 'header',
      items: [item({ label: 'Gone', link: { type: 'entry', ref: 'pages/nowhere' } })],
    },
  ] as Menu[];
  app = mount(Menus, {
    target: document.body,
    props: { id: 'f-menus', labelId: 'f-menus-l', locale: 'en', menus },
  });
  await loaded();

  expect(document.body.textContent).not.toContain('Page missing');
  expect(q('.menu-directory-error').textContent).toContain('Page details are unavailable');
  q<HTMLButtonElement>('.menu-directory-error button').click();
  await loaded();

  expect(document.body.textContent).toContain('Page missing');
  expect(document.querySelector('.menu-directory-error')).toBeNull();
});

/** The list has been read, and whatever it changed on screen has settled. */
const loaded = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const q = <T extends Element = HTMLElement>(sel: string): T => {
  const found = document.querySelector<T>(sel);
  if (!found) throw new Error(`no ${sel}`);
  return found;
};
const byLabel = (label: string) => q<HTMLButtonElement>(`[aria-label="${label}"]`);
const click = (el: HTMLElement) => {
  el.click();
  flushSync();
};
/** A row's move or remove, which lives in its ⋯: opened if it is not already. */
const action = (name: string, label: string) => {
  const more = byLabel(`Actions for ${name}`);
  if (more.getAttribute('aria-expanded') !== 'true') click(more);
  return byLabel(label);
};
/** The first row's name, which is the button that opens its editor. */
const rowOpen = () => q<HTMLButtonElement>('.menu-item .row-open');
const labels = () =>
  Array.from(document.querySelectorAll('.menu-item .lbl')).map((el) =>
    (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
/** The tree as the file would hold it. */
const written = () => stringifyEntry('default', { menus: $state.snapshot(menus) });

const item = (over: Record<string, unknown>) => ({
  _id: 'a1b2c3d4',
  label: 'Home',
  link: { type: 'url', href: '/' },
  ...over,
});
/** The persistent library reads its entries on mount. */
const openAdd = async () => {
  await loaded();
};
const pickRow = (path: string) => {
  const row = Array.from(document.querySelectorAll<HTMLButtonElement>('.picker-list button')).find(
    (b) => b.querySelector('.path')?.textContent === path,
  );
  if (!row) throw new Error(`no row for ${path}`);
  click(row);
};
const type = (sel: string, value: string) => {
  const input = q<HTMLInputElement>(sel);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};

test('a page chosen from the list joins the menu, named by the page until somebody renames it', async () => {
  show();
  await openAdd();
  pickRow('pages/contact');

  expect(labels()).toEqual(['Contact']);
  expect(document.querySelector('.nav-library')).not.toBeNull();
  // The title is the row's, not the file's, so renaming the page moves the menu with it.
  const added = menus[0]?.items[0] as { _id: string };
  expect(written()).toBe(`menus:
  - _id: "menu0aaa"
    key: "header"
    items:
      - _id: "${added._id}"
        label: ""
        link:
          type: "entry"
          ref: "pages/contact"
`);
});

// The index is not an entry, so each language links its own index page.
test("a collection's index chosen from the list is written as an index item", async () => {
  show();
  await openAdd();
  pickRow('listings');

  expect(labels()).toEqual(['Listings']);
  expect(q('.menu-item .kind').textContent).toBe('Listings index');
  click(rowOpen());
  expect(q('.link-summary .sub code').textContent).toBe('/listings');
  const added = menus[0]?.items[0] as { _id: string };
  expect(written()).toBe(`menus:
  - _id: "menu0aaa"
    key: "header"
    items:
      - _id: "${added._id}"
        label: ""
        link:
          type: "index"
          collection: "listings"
`);
});

test('a custom link is written as a url item, and a scheme that runs code is refused', async () => {
  show();
  await openAdd();
  type('#f-menus-pick-url', 'javascript:alert(1)');

  expect(q('#f-menus-pick-url-err').textContent).toContain('links are not allowed');
  expect(q<HTMLButtonElement>('.nav-library .actions .btn-primary').disabled).toBe(true);

  type('#f-menus-pick-url', '/contact');
  click(q('.nav-library .actions .btn-primary'));

  // An address has no title to fall back on, so the row opens for its label at once.
  expect(document.querySelector('.nav-library')).not.toBeNull();
  await loaded();
  expect(document.activeElement?.id).toBe('f-menus-ed-label');
  type('#f-menus-ed-label', 'Book a viewing');
  click(q('.item-editor .actions .btn-primary'));

  expect(labels()).toEqual(['Book a viewing']);
  expect(menus[0]?.items).toHaveLength(1);
  expect($state.snapshot(menus[0]?.items[0])).toMatchObject({
    label: 'Book a viewing',
    link: { type: 'url', href: '/contact' },
  });
});

// The renderer drops these items; the editor is where somebody can see that it is going to.
test('an item the site will skip says so on the row', async () => {
  show([
    item({ label: 'Impressum', link: { type: 'page', ref: 'pages/impressum' } }),
    item({
      _id: 'b2c3d4e5',
      label: 'Mill House',
      link: { type: 'entry', ref: 'listings/mill-house' },
    }),
    item({ _id: 'c3d4e5f6', label: 'Gone', link: { type: 'entry', ref: 'pages/nowhere' } }),
  ]);
  await loaded();

  const chips = Array.from(document.querySelectorAll<HTMLElement>('.menu-item .badge-warn'));
  expect(chips.map((b) => b.textContent)).toEqual(['Not in EN', 'Hidden', 'Page missing']);
  expect(chips.map((b) => b.title)).toEqual([
    'Not available in EN — the site skips this item here',
    'Hidden — the site skips this item',
    'That page is gone — the site skips this item',
  ]);
  click(rowOpen());
  expect(q('.item-editor .notice-warn').textContent).toBe(
    'Not available in EN — the site skips this item here',
  );
});

const three = () => [
  item({ label: 'Home' }),
  item({ _id: 'b2c3d4e5', label: 'Listings', link: { type: 'url', href: '/listings' } }),
  item({ _id: 'c3d4e5f6', label: 'Contact', link: { type: 'url', href: '/contact' } }),
];

test('the move buttons reorder a level, and the ends of it cannot be moved off', async () => {
  show(three());

  expect(action('Home', 'Move Home up').disabled).toBe(true);
  expect(action('Contact', 'Move Contact down').disabled).toBe(true);
  click(action('Listings', 'Move Listings up'));
  expect(labels()).toEqual(['Listings', 'Home', 'Contact']);
  expect(document.querySelector('.row-menu .menu')).toBeNull();
  await loaded();
  expect(document.activeElement).toBe(byLabel('Actions for Listings'));
  click(action('Listings', 'Move Listings down'));
  expect(labels()).toEqual(['Home', 'Listings', 'Contact']);
});

test('indent makes the row a sub-item of the one above it, and outdent brings it back', () => {
  show(three());
  const flat = written();

  click(action('Listings', 'Indent Listings — make it a sub-item'));
  expect(document.querySelectorAll('.branch .branch .menu-item')).toHaveLength(1);
  expect(menus[0]?.items).toHaveLength(2);
  expect($state.snapshot(menus[0]?.items[0]?.children?.[0])).toMatchObject({ label: 'Listings' });

  click(action('Listings', 'Outdent Listings'));
  expect(written()).toBe(flat);
});

// The cap counts what is under the row too, so indenting cannot quietly flatten a sub-menu.
test('the third level is the last: indent is off for a row that would push past it', () => {
  show([
    item({
      label: 'Listings',
      children: [
        item({ _id: 'b2c3d4e5', label: 'For sale', link: { type: 'url', href: '/sale' } }),
        item({
          _id: 'c3d4e5f6',
          label: 'Sold',
          link: { type: 'url', href: '/sold' },
          children: [
            item({ _id: 'd4e5f6a7', label: 'Last year', link: { type: 'url', href: '/y' } }),
          ],
        }),
      ],
    }),
  ]);

  // 'Sold' is two levels of its own at depth 2: indenting it would put 'Last year' at four.
  expect(action('Sold', 'Indent Sold — make it a sub-item').disabled).toBe(true);
  click(action('Last year', 'Remove Last year'));
  expect(action('Sold', 'Indent Sold — make it a sub-item').disabled).toBe(false);
  click(action('Sold', 'Indent Sold — make it a sub-item'));
  expect(action('Sold', 'Indent Sold — make it a sub-item').disabled).toBe(true);
});

test('a row with sub-items is not removed until somebody says so; a leaf goes at once', () => {
  show([
    item({
      label: 'Listings',
      children: [
        item({ _id: 'b2c3d4e5', label: 'For sale', link: { type: 'url', href: '/sale' } }),
      ],
    }),
    item({ _id: 'c3d4e5f6', label: 'Contact', link: { type: 'url', href: '/contact' } }),
  ]);

  click(action('Contact', 'Remove Contact'));
  expect(labels()).toEqual(['Listings', 'For sale']);

  click(action('Listings', 'Remove Listings'));
  expect(q('[role="alertdialog"] h2').textContent).toContain(
    'Remove Listings and what is under it?',
  );
  expect(menus[0]?.items).toHaveLength(1);

  click(
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')).at(
      -1,
    ) as HTMLElement,
  );
  expect(menus[0]?.items).toHaveLength(0);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

test('the label typed over the page title is what gets stored, and Cancel puts the row back', async () => {
  show([item({ label: '', link: { type: 'entry', ref: 'pages/contact' } })]);
  await loaded();

  click(rowOpen());
  expect(rowOpen().getAttribute('aria-expanded')).toBe('true');
  expect(q<HTMLInputElement>('#f-menus-ed-label').placeholder).toBe('Contact');
  type('#f-menus-ed-label', 'Talk to us');
  click(q<HTMLElement>('.item-editor .actions .btn-primary'));
  expect(document.querySelector('.item-editor')).toBeNull();
  expect(labels()).toEqual(['Talk to us']);

  click(rowOpen());
  type('#f-menus-ed-label', 'Something else');
  click(
    Array.from(document.querySelectorAll<HTMLButtonElement>('.item-editor .actions button')).at(
      -1,
    ) as HTMLElement,
  );
  expect(labels()).toEqual(['Talk to us']);
});

test('a site with several menus edits one at a time, and the arrow keys walk the tabs', () => {
  show(three(), ['header', 'footer']);

  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  expect(tabs.map((t) => t.textContent)).toEqual(['Header', 'Footer']);
  expect(labels()).toEqual(['Home', 'Listings', 'Contact']);

  tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  flushSync();
  expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
  expect(labels()).toEqual([]);
  expect(q('.tree-empty h2').textContent).toBe('Nothing in this menu yet');
});

// jsdom lays nothing out, so rows are stacked 60 px tall in document order for dnd-kit.
const ROW = '.menu-item';
const laidOut = () =>
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    // dnd-kit moves the overlay through custom properties, so its box is wherever the drag is.
    const overlay = this.closest('[data-dnd-overlay]');
    if (overlay instanceof HTMLElement) {
      const at = (prop: string) => parseFloat(overlay.style.getPropertyValue(prop)) || 0;
      const [tx = 0, ty = 0] = overlay.style
        .getPropertyValue('--dnd-translate')
        .split(' ')
        .map((v) => parseFloat(v) || 0);
      return new DOMRect(at('--dnd-left') + tx, at('--dnd-top') + ty, 400, 60);
    }
    const row = this.closest(ROW);
    if (!row) return new DOMRect(0, 0, 1024, 4096);
    const rows = Array.from(document.querySelectorAll(ROW));
    return new DOMRect(0, rows.indexOf(row) * 60, 400, 60);
  });
const settle = async () => {
  await new Promise((r) => setTimeout(r, 40));
  flushSync();
};
const key = async (target: Element | Document, code: string) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  await settle();
};
const grip = (name: string) =>
  q<HTMLButtonElement>(`[aria-label="Reorder ${name} — press space, then the arrow keys"]`);
const lifted = () => !!document.querySelector('[data-dnd-overlay] .drag-proxy');
const marked = () => !!document.querySelector('.drop-line, .drop-into, .drop-blocked');
const until = async (ready: () => boolean, what: string) => {
  for (let n = 0; n < 150; n++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 10));
    flushSync();
  }
  throw new Error(`never ${what}`);
};
// A keydown can land in the rAF gap before the lift on a slow machine, so it is pressed again.
const arrow = async (dir: 'ArrowUp' | 'ArrowDown') => {
  for (let attempt = 0; attempt < 5; attempt++) {
    await key(document, dir);
    for (let n = 0; n < 30; n++) {
      if (marked()) return;
      await new Promise((r) => setTimeout(r, 10));
      flushSync();
    }
  }
  throw new Error(`no slot after ${dir}`);
};
const keyMove = async (name: string, steps: number) => {
  await until(() => !lifted(), 'settled from the drag before');
  await key(grip(name), 'Space');
  await until(lifted, 'lifted');
  for (let n = 0; n < Math.abs(steps); n++) await arrow(steps > 0 ? 'ArrowDown' : 'ArrowUp');
  await key(document, 'Space');
  await until(() => !lifted(), 'dropped');
};
const pointer = async (target: Element | Document, type: string, y: number, x = 20) => {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      isPrimary: true,
      pointerId: 1,
      button: 0,
      pointerType: 'mouse',
      clientX: x,
      clientY: y,
    }),
  );
  await settle();
};
const mouseMove = async (name: string, by: number) => {
  const handle = grip(name);
  const y = handle.getBoundingClientRect().y + 30;
  await pointer(handle, 'pointerdown', y);
  await pointer(document, 'pointermove', y + by / 2);
  await pointer(document, 'pointermove', y + by);
  await pointer(document, 'pointerup', y + by);
};

test('reordering by keyboard and by mouse write the same menu', async () => {
  laidOut();
  show(three());
  const start = written();

  await keyMove('Home', 1);
  const moved = written();
  expect(labels()).toEqual(['Listings', 'Home', 'Contact']);

  await keyMove('Home', -1);
  expect(written()).toBe(start);

  await mouseMove('Home', 60);
  expect(written()).toBe(moved);
});

test('the library stays visible, preserves search, and marks pages already in any menu level', async () => {
  show([
    item({
      label: 'Home',
      children: [
        item({ _id: 'child001', label: 'Contact', link: { type: 'entry', ref: 'pages/contact' } }),
      ],
    }),
  ]);
  await loaded();
  expect(document.querySelector('.nav-library')).not.toBeNull();
  expect(document.activeElement?.id).not.toBe('f-menus-pick-q');
  expect(byLabel('Add Contact again').textContent).toContain('In menu');

  type('#f-menus-pick-q', 'Impressum');
  pickRow('pages/impressum');
  expect(labels()).toEqual(['Home', 'Contact', 'Impressum']);
  expect(q<HTMLInputElement>('#f-menus-pick-q').value).toBe('Impressum');
  expect(byLabel('Add Impressum again').textContent).toContain('In menu');
  expect(q('[role="status"]').textContent).toContain('Impressum added');

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  click(document.body);
  expect(document.querySelector('.nav-library')).not.toBeNull();
});

test('the library reflects removal and the active menu when switching tabs', async () => {
  show(
    [item({ label: 'Contact', link: { type: 'entry', ref: 'pages/contact' } })],
    ['header', 'footer'],
  );
  await loaded();
  expect(byLabel('Add Contact again').textContent).toContain('In menu');
  click(action('Contact', 'Remove Contact'));
  expect(byLabel('Add Contact').textContent).not.toContain('In menu');
  pickRow('pages/contact');
  const tabs = document.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  click(tabs[1] as HTMLButtonElement);
  expect(byLabel('Add Contact').textContent).not.toContain('In menu');
  pickRow('pages/contact');
  expect(menus[0]?.items).toHaveLength(1);
  expect(menus[1]?.items).toHaveLength(1);
});

// The slot's depth follows the pointer, which has not moved sideways.
test('a sub-item is dragged within its own branch', async () => {
  laidOut();
  show([
    item({
      label: 'Listings',
      children: [
        item({ _id: 'b2c3d4e5', label: 'For sale', link: { type: 'url', href: '/sale' } }),
        item({ _id: 'c3d4e5f6', label: 'Sold', link: { type: 'url', href: '/sold' } }),
      ],
    }),
  ]);

  await mouseMove('For sale', 60);

  expect(labels()).toEqual(['Listings', 'Sold', 'For sale']);
  expect(menus[0]?.items).toHaveLength(1);
  expect(menus[0]?.items[0]?.children?.map((c) => c.label)).toEqual(['Sold', 'For sale']);
});

const nested = () => [
  item({
    label: 'Listings',
    link: { type: 'url', href: '/listings' },
    children: [
      item({ _id: 'b2c3d4e5', label: 'For sale', link: { type: 'url', href: '/sale' } }),
      item({ _id: 'c3d4e5f6', label: 'Sold', link: { type: 'url', href: '/sold' } }),
    ],
  }),
  item({ _id: 'd4e5f6a7', label: 'Contact', link: { type: 'url', href: '/contact' } }),
];

// Nothing moves while the drag is live; the slot it would land in is drawn instead.
test('carried right over a sub-menu, the well names the slot and the drop nests the row', async () => {
  laidOut();
  show(nested());

  await pointer(grip('Contact'), 'pointerdown', 210);
  await pointer(document, 'pointermove', 180, 40);
  await pointer(document, 'pointermove', 150, 56);

  expect(q('[data-dnd-overlay] .drag-proxy').textContent).toContain('Contact');
  expect(q('.drop-into').textContent).toBe('Add inside Listings, after Sold');

  await pointer(document, 'pointerup', 150, 56);

  expect(document.querySelector('.drop-into')).toBeNull();
  expect(menus[0]?.items).toHaveLength(1);
  expect(menus[0]?.items[0]?.children?.map((c) => c.label)).toEqual([
    'For sale',
    'Sold',
    'Contact',
  ]);
});

test('a sibling slot is a hairline, and the drop lands the row there', async () => {
  laidOut();
  show(three());

  await pointer(grip('Home'), 'pointerdown', 30);
  await pointer(document, 'pointermove', 70);
  await pointer(document, 'pointermove', 95);

  expect(document.querySelectorAll('.drop-line')).toHaveLength(1);
  expect(document.querySelector('.drop-into')).toBeNull();

  await pointer(document, 'pointerup', 95);

  expect(labels()).toEqual(['Listings', 'Home', 'Contact']);
});

test('one level too deep is refused at the position, in so many words', async () => {
  laidOut();
  show([
    item({
      label: 'Listings',
      link: { type: 'url', href: '/listings' },
      children: [
        item({
          _id: 'b2c3d4e5',
          label: 'For sale',
          link: { type: 'url', href: '/sale' },
          children: [
            item({ _id: 'd4e5f6a7', label: 'Devon', link: { type: 'url', href: '/devon' } }),
          ],
        }),
      ],
    }),
    item({ _id: 'c3d4e5f6', label: 'Contact', link: { type: 'url', href: '/contact' } }),
  ]);
  const start = written();

  await pointer(grip('Contact'), 'pointerdown', 210);
  await pointer(document, 'pointermove', 180, 60);
  await pointer(document, 'pointermove', 150, 128);

  expect(q('.drop-blocked').textContent).toBe(
    "Can't go here — three levels is as deep as a menu goes",
  );

  await pointer(document, 'pointerup', 150, 128);

  expect(document.querySelector('.drop-blocked')).toBeNull();
  expect(written()).toBe(start);
});

test('an escaped drag leaves the menu untouched and takes the indicator with it', async () => {
  laidOut();
  show(three());
  const start = written();

  await key(grip('Home'), 'Space');
  await until(lifted, 'lifted');
  await arrow('ArrowDown');
  expect(document.querySelector('.drop-line')).not.toBeNull();

  await key(document, 'Escape');

  expect(document.querySelector('.drop-line')).toBeNull();
  expect(written()).toBe(start);
});

test('a keyboard drag crosses into a sub-menu: the slot between two of its rows', async () => {
  laidOut();
  show(nested());

  await key(grip('Contact'), 'Space');
  await until(lifted, 'lifted');
  await arrow('ArrowUp');
  await key(document, 'Space');

  expect(menus[0]?.items).toHaveLength(1);
  expect(menus[0]?.items[0]?.children?.map((c) => c.label)).toEqual([
    'For sale',
    'Contact',
    'Sold',
  ]);
});

test('→ during a keyboard drag asks for one level deeper, ← brings it back', async () => {
  laidOut();
  show([
    item({ label: 'Home' }),
    item({ _id: 'b2c3d4e5', label: 'Listings', link: { type: 'url', href: '/listings' } }),
  ]);

  await key(grip('Home'), 'Space');
  await until(lifted, 'lifted');
  await arrow('ArrowDown');
  expect(document.querySelector('.drop-line')).not.toBeNull();

  await key(document, 'ArrowRight');
  expect(q('.drop-into').textContent).toBe('Add inside Listings');

  await key(document, 'ArrowLeft');
  expect(document.querySelector('.drop-line')).not.toBeNull();

  await key(document, 'ArrowRight');
  await key(document, 'Space');

  expect(menus[0]?.items.map((i) => i.label)).toEqual(['Listings']);
  expect(menus[0]?.items[0]?.children?.map((c) => c.label)).toEqual(['Home']);
});

test('the parsed file survives the round trip through the tree', () => {
  const file = `menus:
  - _id: "menu0aaa"
    key: "header"
    items:
      - _id: "a1b2c3d4"
        label: "Home"
        link:
          type: "url"
          href: "/"
`;
  const parsed = parseEntry('default', file) as { menus: Menu[] };
  show(parsed.menus[0]?.items ?? []);
  expect(written()).toBe(file);
});

// A save of a translation carries the labels and nothing else.
const translated = [
  { _id: 'a1b2c3d4', label: 'Kontakt', link: { type: 'entry', ref: 'pages/contact' } },
  {
    _id: 'l1i2s3t4',
    label: 'Angebote',
    link: { type: 'url', href: '/listings' },
    children: [{ _id: 'm1i2l3l4', label: '', link: { type: 'entry', ref: 'listings/mill-house' } }],
  },
];
const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>('.menu-item .input'));

test('the second language types one label a row and cannot move anything', async () => {
  show(translated, ['header'], true);
  await loaded();

  expect(boxes().map((b) => b.value)).toEqual(['Kontakt', 'Angebote', '']);
  expect(document.querySelectorAll('.grip')).toHaveLength(0);
  expect(document.querySelectorAll('.item-actions')).toHaveLength(0);
  expect(document.querySelector('.nav-library')).toBeNull();

  type('#f-menus-lbl-a1b2c3d4', 'Kontakt und Anfahrt');

  expect(written()).toBe(`menus:
  - _id: "menu0aaa"
    key: "header"
    items:
      - _id: "a1b2c3d4"
        label: "Kontakt und Anfahrt"
        link:
          type: "entry"
          ref: "pages/contact"
      - _id: "l1i2s3t4"
        label: "Angebote"
        link:
          type: "url"
          href: "/listings"
        children:
          - _id: "m1i2l3l4"
            label: ""
            link:
              type: "entry"
              ref: "listings/mill-house"
`);
});

test('a label box is named by the page it points at, and empty means that page’s own title', async () => {
  show(translated, ['header'], true);
  await loaded();

  const [, , child] = boxes();
  expect(
    Array.from(document.querySelectorAll('.menu-item .lbl')).map((l) => l.textContent),
  ).toEqual(['Contact', '/listings', 'Old Mill House']);
  expect(child?.placeholder).toBe('Old Mill House');
  // A row the site skips is one nobody should spend a translation on.
  expect(document.querySelector<HTMLElement>('.menu-item .badge-warn')?.title).toBe(
    'Hidden — the site skips this item',
  );
});

test('German label fallbacks and hidden status belong to German, with clear source-language guidance', async () => {
  show(translated, ['header'], true, 'de');
  await loaded();
  expect(boxes()[2]?.placeholder).toBe('Das Mühlenhaus');
  expect(document.querySelector('.menu-item .badge-warn')).toBeNull();
  expect(q('.nav-structure-heading h2').textContent).toBe('German menu labels');
  expect(q('.notice-info').textContent).toContain('switch to English');
  expect(q('.notice-info').textContent).not.toContain('other column');
});

test('language visibility is an optional exception and Cancel restores the original setting', async () => {
  show([item({ label: 'Contact', link: { type: 'entry', ref: 'pages/contact' } })]);
  await loaded();
  click(rowOpen());
  expect(q<HTMLDetailsElement>('.nav-visibility').open).toBe(false);
  expect(q('.nav-visibility summary').textContent).toContain('All languages');
  const german = Array.from(
    document.querySelectorAll<HTMLLabelElement>('.nav-visibility label'),
  ).find((label) => label.textContent === 'German only');
  click(german?.querySelector('input') as HTMLInputElement);
  expect(menus[0]?.items[0]?._locales).toEqual(['de']);
  expect(q('.nav-visibility summary').textContent).toContain('German only');
  click(q('.item-editor .actions button:last-child'));
  expect(menus[0]?.items[0]?._locales).toBeUndefined();
});
