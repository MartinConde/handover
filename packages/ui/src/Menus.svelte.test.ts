import { parseEntry, stringifyEntry } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Menus, { type Menu } from './Menus.svelte';

// Testing: what the tree writes into the global — adding from the picker and from the custom
// link form, reordering by mouse and by keyboard, indent and outdent under the depth cap, an
// item removed with its children, and the label an item does not store; plus the badge on an
// item the site is going to skip.
// Not testing: the Fields dispatch (glue) or styling.

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
    locales: ['en', 'de'],
    hidden: true,
    urls: { en: '/listings/mill-house', de: '/de/objekte/muehlenhaus' },
  },
];

let app: ReturnType<typeof mount>;
let menus: Menu[] = $state([]);
const show = (items: unknown[] = [], keys = ['header'], translating = false) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ entries: OFFERED, locales: ['en', 'de'] })),
  );
  menus = keys.map((key, i) => ({
    _id: `menu${i}aaa`,
    key,
    items: i === 0 ? items : [],
  })) as Menu[];
  app = mount(Menus, {
    target: document.body,
    props: { id: 'f-menus', labelId: 'f-menus-l', locale: 'en', menus, translating },
  });
  flushSync();
  return document.body;
};
afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
/** The row's Edit, which is named by its own text and not by a label. */
const editButton = () => {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.item-actions button'),
  ).find((b) => b.textContent?.trim().startsWith('Edit'));
  if (!found) throw new Error('no Edit button');
  return found;
};
const click = (el: HTMLElement) => {
  el.click();
  flushSync();
};
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
  await loaded();
  pickRow('pages/contact');

  expect(labels()).toEqual(['Contact Uses the page title']);
  // The title is what the row shows and not what the file holds: renaming the page moves the
  // menu with it.
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

test('a custom link is written as a url item, and a scheme that runs code is refused', async () => {
  show();
  await loaded();
  type('#f-menus-cl-label', 'Book a viewing');
  type('#f-menus-cl-url', 'javascript:alert(1)');

  expect(q('#f-menus-cl-err').textContent).toContain('links are not allowed');
  expect(q<HTMLButtonElement>('.custom-link .btn').disabled).toBe(true);

  type('#f-menus-cl-url', '/contact');
  click(q('.custom-link .btn'));

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

  expect(
    Array.from(document.querySelectorAll('.menu-item .badge-warn')).map((b) => b.textContent),
  ).toEqual([
    'Not available in EN — the site skips this item here',
    'Hidden — the site skips this item',
    'That page is gone — the site skips this item',
  ]);
});

const three = () => [
  item({ label: 'Home' }),
  item({ _id: 'b2c3d4e5', label: 'Listings', link: { type: 'url', href: '/listings' } }),
  item({ _id: 'c3d4e5f6', label: 'Contact', link: { type: 'url', href: '/contact' } }),
];

test('the move buttons reorder a level, and the ends of it cannot be moved off', () => {
  show(three());

  expect(byLabel('Move Home up').disabled).toBe(true);
  expect(byLabel('Move Contact down').disabled).toBe(true);
  click(byLabel('Move Listings up'));
  expect(labels()).toEqual(['Listings', 'Home', 'Contact']);
  click(byLabel('Move Listings down'));
  expect(labels()).toEqual(['Home', 'Listings', 'Contact']);
});

test('indent makes the row a sub-item of the one above it, and outdent brings it back', () => {
  show(three());
  const flat = written();

  click(byLabel('Indent Listings — make it a sub-item'));
  expect(document.querySelectorAll('.branch .branch .menu-item')).toHaveLength(1);
  expect(menus[0]?.items).toHaveLength(2);
  expect($state.snapshot(menus[0]?.items[0]?.children?.[0])).toMatchObject({ label: 'Listings' });

  click(byLabel('Outdent Listings'));
  expect(written()).toBe(flat);
});

// The format is recursive; three levels is this editor's cap, and it counts what is under the
// row as well as the row, so indenting cannot quietly flatten a sub-menu.
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
  expect(byLabel('Indent Sold — make it a sub-item').disabled).toBe(true);
  // Take its child away and the same row can be indented.
  click(byLabel('Remove Last year'));
  expect(byLabel('Indent Sold — make it a sub-item').disabled).toBe(false);
  click(byLabel('Indent Sold — make it a sub-item'));
  expect(byLabel('Indent Sold — make it a sub-item').disabled).toBe(true);
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

  click(byLabel('Remove Contact'));
  expect(labels()).toEqual(['Listings', 'For sale']);

  click(byLabel('Remove Listings'));
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

  click(editButton());
  expect(q<HTMLInputElement>('#f-menus-ed-label').placeholder).toBe('Contact');
  type('#f-menus-ed-label', 'Talk to us');
  click(q<HTMLElement>('.nav-main .actions .btn-primary'));
  expect(labels()).toEqual(['Talk to us']);

  click(editButton());
  type('#f-menus-ed-label', 'Something else');
  click(
    Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-main .actions button')).at(
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

// jsdom lays nothing out, and dnd-kit finds the row under the pointer by its box: rows are
// stacked 60 px tall in document order, the way the flattened tree reads. The carried card is
// the overlay, so the rows themselves stay where they are while a drag is live.
const ROW = '.menu-item';
const laidOut = () =>
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    // The carried card is the drag's shape, and dnd-kit places it through its own custom
    // properties — so its box is wherever the drag has moved it.
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
// The lift crosses a requestAnimationFrame and ↑ ↓ resolve their target in a promise, so on a
// slow machine a keydown can land in the gap and be dropped. Walk on state, not on time: wait
// for the lift, and press again if a press fell before the drag was ready to hear it.
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

// On a phone the tree is the screen and the add pane is a sheet opened from a button; the
// stylesheet hides the button wider than that, and the pane is a plain pane. One disclosure
// either way, so the button's state and the focus contract are what is tested here.
test('Add to menu opens the add pane as a sheet, focus lands in it, and Escape gives it back', async () => {
  show(three());
  const open = q<HTMLButtonElement>('.nav-add-open');
  expect(open.getAttribute('aria-expanded')).toBe('false');
  expect(open.getAttribute('aria-controls')).toBe('f-menus-add');

  open.click();
  await loaded();
  expect(q('#f-menus-add').classList.contains('is-open')).toBe(true);
  expect(open.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement?.id).toBe('f-menus-add-h');

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  flushSync();
  expect(q('#f-menus-add').classList.contains('is-open')).toBe(false);
  expect(document.activeElement).toBe(open);
});

test('a tap outside the sheet lands on the scrim, which closes it', async () => {
  show(three());
  q<HTMLButtonElement>('.nav-add-open').click();
  await loaded();
  expect(q('#f-menus-add').classList.contains('is-open')).toBe(true);

  q<HTMLElement>('.nav-scrim').click();
  flushSync();
  expect(q('#f-menus-add').classList.contains('is-open')).toBe(false);
  expect(document.activeElement).toBe(q('.nav-add-open'));
});

test('Done closes the sheet and gives focus back to the button that opened it', async () => {
  show(three());
  q<HTMLButtonElement>('.nav-add-open').click();
  await loaded();

  q<HTMLButtonElement>('.nav-add .nav-add-close').click();
  flushSync();
  expect(q('#f-menus-add').classList.contains('is-open')).toBe(false);
  expect(document.activeElement).toBe(q('.nav-add-open'));
});

// One provider spans the tree now, but a drag that keeps its own indent stays in its own
// branch: the slot's depth follows the pointer, and the pointer has not moved sideways.
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

// One DragDropProvider spans the whole tree, so a drag can land on another level. Nothing moves
// while the drag is live: the slot it would land in is drawn instead — a hairline between
// siblings, a tinted well that names its parent, a refusal at the position that is over the cap.
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

// The second language's column. The tree it draws is the same tree, and the only thing it can
// write is one word per row: a save of a translation carries the labels and nothing else.
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
  expect(document.querySelector('.nav-add')).toBeNull();

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
  // The badge the tree draws is drawn here too: a row the site is going to skip is one nobody
  // should spend a translation on.
  expect(document.querySelector('.menu-item.is-flagged .badge-warn')?.textContent).toBe(
    'Hidden — the site skips this item',
  );
});
