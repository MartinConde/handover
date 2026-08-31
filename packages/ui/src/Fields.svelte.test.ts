import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Field } from '@handover/core';
import { parseEntry, stringifyEntry } from '@handover/core';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Fields from './Fields.svelte';

// Testing: every widget writes the documented value shape, proven by state → YAML → state
// against the golden for the type; `array` and `blocks` add, remove and reorder while every
// `_id` survives; labels on every control; a read-only structured field says why it is one;
// a field the schema refuses is marked, named and still editable.
// Not testing: Editor wiring (Editor.test.ts) or styling.

// jsdom has no layout; ProseMirror asks for it when it scrolls the selection into view.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

let app: ReturnType<typeof mount>;
let root: Record<string, unknown> = $state({});
const show = (
  fields: Field[],
  data: Record<string, unknown>,
  blocks: Record<string, Field[]> = {},
  problems: Record<string, string> = {},
) => {
  root = data;
  app = mount(Fields, {
    target: document.body,
    props: {
      fields,
      blocks,
      problems,
      // The form is showing English: what a link typed into rich text has to point at.
      locale: 'en',
      get root() {
        return root;
      },
      set root(v) {
        root = v;
      },
    },
  });
  flushSync();
  return document.body;
};
afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const golden = (name: string) =>
  readFileSync(resolve(__dirname, `../../core/test/golden/${name}.yaml`), 'utf8');

// Everything the admin offers a picker, as `/admin/api/entries` answers it. Jane and James
// are in a collection nothing renders, so neither has an address to link to.
const OFFERED = [
  {
    collection: 'pages',
    path: 'pages/contact',
    title: 'Contact',
    locales: ['en', 'de'],
    urls: { en: '/contact', de: '/de/kontakt' },
  },
  {
    collection: 'listings',
    path: 'listings/mill-house',
    title: 'Old Mill House',
    locales: ['en'],
    urls: { en: '/listings/mill-house' },
  },
  {
    collection: 'agents',
    path: 'agents/jane-doe',
    title: 'Jane Doe',
    locales: ['en', 'de'],
    urls: {},
  },
  {
    collection: 'agents',
    path: 'agents/james-hartley',
    title: 'James Hartley',
    locales: ['en'],
    urls: {},
  },
];
/** The picker's one read, answered before the field that opens it is mounted. */
const offering = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ entries: OFFERED, locales: ['en', 'de'] })),
  );
const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.picker-list button'));
/** A link is applied to the selection, so a test that leaves a bare cursor marks nothing. */
const selectAll = (sel: string) => {
  const body = q<HTMLElement>(sel);
  body.focus();
  const range = document.createRange();
  range.selectNodeContents(body);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  flushSync();
};
const pickRow = (path: string) => {
  const row = rows().find((b) => b.querySelector('.path')?.textContent === path);
  if (!row) throw new Error(`no row for ${path}`);
  row.click();
  flushSync();
};
const roundTrip = () => parseEntry('default', stringifyEntry('default', $state.snapshot(root)));

const q = <T extends Element>(sel: string) => {
  const el = document.body.querySelector<T>(sel);
  if (!el) throw new Error(`${sel} missing`);
  return el;
};
const fire = (sel: string, event: string, set: (el: HTMLInputElement) => void) => {
  const el = q<HTMLInputElement>(sel);
  set(el);
  el.dispatchEvent(new Event(event, { bubbles: true }));
  flushSync();
};
const type = (sel: string, value: string) =>
  fire(sel, 'input', (el) => {
    el.value = value;
  });

test('text: a typed value round-trips through the text golden', () => {
  show([{ path: ['title'], label: 'Title', type: 'text', required: true }], { _version: 1 });
  expect(q('label[for="f-title"]').textContent).toBe('Title*');
  type('input#f-title', 'Seaview Cottage');
  expect(root).toEqual({ _version: 1, title: 'Seaview Cottage' });
  expect(roundTrip()).toEqual(root);
});

test('text: a value with line breaks is a textarea and survives the round trip', () => {
  show([{ path: ['summary'], label: 'Summary', type: 'text', required: false }], {
    _version: 1,
    summary: 'First line.\nSecond line.',
  });
  type('textarea#f-summary', 'First line.\n\nThird line.');
  expect(roundTrip()).toEqual({ _version: 1, summary: 'First line.\n\nThird line.' });
});

test('number: writes a number, never a string; clearing removes the key', () => {
  show([{ path: ['price'], label: 'Price', type: 'number', required: false }], { _version: 1 });
  fire('input#f-price', 'input', (el) => {
    el.value = '82.5';
  });
  expect(root).toEqual({ _version: 1, price: 82.5 });
  expect(stringifyEntry('default', $state.snapshot(root))).toBe('_version: 1\nprice: 82.5\n');
  type('input#f-price', '');
  expect(root).toEqual({ _version: 1 });
});

test('boolean: a switch with the label as its text writes true / false', () => {
  show([{ path: ['featured'], label: 'Featured', type: 'boolean', required: false }], {
    _version: 1,
  });
  const box = q<HTMLInputElement>('input#f-featured[role="switch"]');
  expect(q('label[for="f-featured"]').textContent).toBe('Featured');
  expect(box.checked).toBe(false);
  fire('input#f-featured', 'change', (el) => {
    el.checked = true;
  });
  expect(roundTrip()).toEqual({ _version: 1, featured: true });
  fire('input#f-featured', 'change', (el) => {
    el.checked = false;
  });
  expect(roundTrip()).toEqual({ _version: 1, featured: false });
});

test('date: writes the ISO string from the date golden, never a Date', () => {
  show([{ path: ['availableFrom'], label: 'Available from', type: 'date', required: false }], {
    _version: 1,
  });
  expect(q<HTMLInputElement>('input#f-availableFrom').type).toBe('date');
  type('input#f-availableFrom', '2026-09-01');
  expect(stringifyEntry('default', $state.snapshot(root))).toBe(golden('date'));
  type('input#f-availableFrom', '');
  expect(root).toEqual({ _version: 1 });
});

test('select: five options or fewer are radios and store the value', () => {
  show(
    [
      {
        path: ['status'],
        label: 'Status',
        type: 'select',
        required: true,
        options: ['sale', 'rent'],
      },
    ],
    {
      _version: 1,
    },
  );
  expect(q('fieldset legend').textContent).toBe('Status*');
  expect(document.querySelectorAll('input[type="radio"][name="f-status"]')).toHaveLength(2);
  fire('input[type="radio"][value="sale"]', 'change', (el) => {
    el.checked = true;
  });
  expect(stringifyEntry('default', $state.snapshot(root))).toBe(golden('select'));
});

test('select: more than five options is a dropdown; Choose… removes the key', () => {
  const options = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  show([{ path: ['energy'], label: 'Energy', type: 'select', required: false, options }], {
    _version: 1,
    energy: 'c',
  });
  const select = q<HTMLSelectElement>('select#f-energy');
  expect(select.value).toBe('c');
  expect(q('label[for="f-energy"]').textContent).toBe('Energy');
  fire('select#f-energy', 'change', (el) => {
    el.value = 'g';
  });
  expect(roundTrip()).toEqual({ _version: 1, energy: 'g' });
  fire('select#f-energy', 'change', (el) => {
    el.value = '';
  });
  expect(root).toEqual({ _version: 1 });
});

test('link: URL and entry modes write the two shapes from the link golden', async () => {
  offering();
  show(
    [
      { path: ['button'], label: 'Button', type: 'link', required: true },
      { path: ['more'], label: 'More', type: 'link', required: false },
    ],
    { _version: 1 },
  );
  expect(q('#f-button-l').textContent).toBe('Button*');
  q<HTMLButtonElement>('.seg button:nth-child(2)').click();
  flushSync();
  type('input#f-button\\.href', 'https://example.com/viewings');
  type('input#f-button\\.label', 'Book a viewing');
  fire('input#f-button\\.newTab', 'change', (el) => {
    el.checked = true;
  });
  q<HTMLButtonElement>('#f-more\\.ref button').click();
  await settle();
  pickRow('listings/mill-house');
  expect(stringifyEntry('default', $state.snapshot(root))).toBe(golden('link'));
});

test('link: the chosen entry is named, not left as the path it stores', async () => {
  offering();
  show([{ path: ['more'], label: 'More', type: 'link', required: false }], {
    _version: 1,
    more: { type: 'entry', ref: 'listings/mill-house' },
  });
  await settle();
  expect(q('.ref-item .title').textContent).toBe('Old Mill House');
  expect(q('.ref-item .path').textContent).toBe('listings/mill-house');
  // English has a file and German has none: the entry an editor is about to point at says so.
  expect(Array.from(document.querySelectorAll('.ref-item .chip')).map((c) => c.className)).toEqual([
    'chip',
    'chip chip-missing',
  ]);
});

test('link: switching type drops the other target; new tab off leaves no key', async () => {
  offering();
  show([{ path: ['button'], label: 'Button', type: 'link', required: true }], {
    _version: 1,
    button: { type: 'url', href: 'https://example.com', newTab: true },
  });
  expect(q<HTMLButtonElement>('.seg button:nth-child(2)').getAttribute('aria-pressed')).toBe(
    'true',
  );
  fire('input#f-button\\.newTab', 'change', (el) => {
    el.checked = false;
  });
  q<HTMLButtonElement>('.seg button:nth-child(1)').click();
  flushSync();
  q<HTMLButtonElement>('#f-button\\.ref button').click();
  await settle();
  pickRow('pages/contact');
  expect(roundTrip()).toEqual({ _version: 1, button: { type: 'entry', ref: 'pages/contact' } });
});

// The allow-list is 1.20c's, and it is the schema's own: the widget refuses what a save
// would refuse, so nobody types a target that only fails two screens later.
test('link: a scheme the site will not accept is named under the URL as it is typed', () => {
  show([{ path: ['button'], label: 'Button', type: 'link', required: true }], {
    _version: 1,
    button: { type: 'url' },
  });
  type('input#f-button\\.href', 'javascript:alert(1)');
  expect(q('#f-button\\.href-err').textContent).toBe('javascript: links are not allowed');
  expect(q('input#f-button\\.href').getAttribute('aria-invalid')).toBe('true');
  type('input#f-button\\.href', 'https://example.com');
  expect(document.querySelector('#f-button\\.href-err')).toBeNull();
});

test('reference: the picker writes the collection/slug the reference golden holds', async () => {
  offering();
  show(
    [
      {
        path: ['agent'],
        label: 'Agent',
        type: 'reference',
        required: false,
        collection: 'agents',
      },
    ],
    { _version: 1 },
  );
  expect(q('#f-agent button').textContent).toBe('Choose Agent');
  q<HTMLButtonElement>('#f-agent button').click();
  await settle();
  pickRow('agents/jane-doe');
  expect(stringifyEntry('default', $state.snapshot(root))).toBe(golden('reference'));
  expect(q('.ref-item .title').textContent).toBe('Jane Doe');
});

test('reference: only the collection the schema names is offered', async () => {
  offering();
  show(
    [
      {
        path: ['agent'],
        label: 'Agent',
        type: 'reference',
        required: false,
        collection: 'agents',
      },
    ],
    { _version: 1 },
  );
  q<HTMLButtonElement>('#f-agent button').click();
  await settle();
  expect(rows().map((b) => b.querySelector('.path')?.textContent)).toEqual([
    'agents/jane-doe',
    'agents/james-hartley',
  ]);
});

test('group: fields nest under the group key and the object is created on first edit', () => {
  const address: Field = {
    path: ['address'],
    label: 'Address',
    type: 'group',
    required: true,
    fields: [
      { path: ['street'], label: 'Street', type: 'text', required: true },
      { path: ['town'], label: 'Town', type: 'text', required: true },
      { path: ['postcode'], label: 'Postcode', type: 'text', required: true },
    ],
  };
  show([address], { _version: 1 });
  expect(q('details.group summary').textContent).toBe('Address3 fields');
  type('input#f-address\\.street', '12 Harbour Lane');
  type('input#f-address\\.town', 'Salcombe');
  type('input#f-address\\.postcode', 'TQ8 8AA');
  expect(stringifyEntry('default', $state.snapshot(root))).toBe(golden('group'));
});

const body = (parseEntry('default', golden('richtext')) as { body: string }).body;

test('richtext: the full-tier golden loads into TipTap and comes back byte-identical', () => {
  show([{ path: ['body'], label: 'Body', type: 'richtext', required: false, tier: 'full' }], {
    _version: 1,
    body,
  });
  expect(document.querySelectorAll('[role="toolbar"] button')).toHaveLength(8);
  expect(q('#f-body[contenteditable="true"]').getAttribute('aria-labelledby')).toBe('f-body-l');
  expect(q('#f-body h2').textContent).toBe('The house');
  expect(stringifyEntry('default', $state.snapshot(root))).toBe(golden('richtext'));
});

test('richtext: a toolbar command writes Markdown back and the button reads as pressed', () => {
  show(
    [{ path: ['summary'], label: 'Summary', type: 'richtext', required: false, tier: 'basic' }],
    {
      _version: 1,
      summary: 'Two bedrooms.',
    },
  );
  expect(document.querySelectorAll('[role="toolbar"] button')).toHaveLength(5);
  q<HTMLButtonElement>('[aria-label="Bullet list"]').click();
  flushSync();
  expect(q('[aria-label="Bullet list"]').getAttribute('aria-pressed')).toBe('true');
  expect(roundTrip()).toEqual({ _version: 1, summary: '- Two bedrooms.' });
});

test('richtext: a body outside the tier is shown read-only and left untouched', () => {
  show(
    [{ path: ['summary'], label: 'Summary', type: 'richtext', required: false, tier: 'basic' }],
    {
      _version: 1,
      summary: body,
    },
  );
  expect(document.querySelector('[role="toolbar"]')).toBeNull();
  expect(q('[role="region"] pre#f-summary').textContent).toBe(body);
  expect(q('#f-summary-hint').textContent).toContain('edited in code');
  expect(roundTrip()).toEqual({ _version: 1, summary: body });
});

// The toolbar's link button opened a `window.prompt` until 3.26; the picker is where a
// target is chosen now, and both halves of it answer here.
test('rich text: a link points at the address the language being written serves', async () => {
  offering();
  show(
    [{ path: ['summary'], label: 'Summary', type: 'richtext', required: false, tier: 'basic' }],
    {
      _version: 1,
      summary: 'Two bedrooms.',
    },
  );
  selectAll('#f-summary');
  q<HTMLButtonElement>('[aria-label="Link"]').click();
  await settle();
  pickRow('/listings/mill-house');
  expect(roundTrip()).toEqual({
    _version: 1,
    summary: '[Two bedrooms.](/listings/mill-house)',
  });
});

// Nothing selected is the common case — the cursor is where the link should go — and a link
// with no words is nothing to click, so the page's own title is the text.
test("rich text: Link with nothing selected inserts the picked page's title as the link text", async () => {
  offering();
  show(
    [{ path: ['summary'], label: 'Summary', type: 'richtext', required: false, tier: 'basic' }],
    { _version: 1, summary: '' },
  );
  q<HTMLElement>('#f-summary').focus();
  q<HTMLButtonElement>('[aria-label="Link"]').click();
  await settle();
  pickRow('/listings/mill-house');
  expect(roundTrip()).toEqual({
    _version: 1,
    summary: '[Old Mill House](/listings/mill-house)',
  });
});

test('rich text: an entry the language cannot serve is listed with the reason and picks nothing', async () => {
  offering();
  show(
    [{ path: ['summary'], label: 'Summary', type: 'richtext', required: false, tier: 'basic' }],
    {
      _version: 1,
      summary: 'Two bedrooms.',
    },
  );
  selectAll('#f-summary');
  q<HTMLButtonElement>('[aria-label="Link"]').click();
  await settle();
  const jane = rows().find((b) => b.querySelector('.path')?.textContent === 'agents/jane-doe');
  expect(jane?.getAttribute('aria-disabled')).toBe('true');
  expect(q(`#${CSS.escape(jane?.getAttribute('aria-describedby') ?? '')}`).textContent).toBe(
    'Nothing on the site renders this, so it has no address',
  );
  jane?.click();
  flushSync();
  expect(roundTrip()).toEqual({ _version: 1, summary: 'Two bedrooms.' });
});

test('rich text: a scheme the site will not accept is refused where it is typed', async () => {
  offering();
  show(
    [{ path: ['summary'], label: 'Summary', type: 'richtext', required: false, tier: 'basic' }],
    {
      _version: 1,
      summary: 'Two bedrooms.',
    },
  );
  selectAll('#f-summary');
  q<HTMLButtonElement>('[aria-label="Link"]').click();
  await settle();
  type('#f-summary-link-url', 'javascript:alert(1)');
  expect(q('#f-summary-link-url-err').textContent).toBe('javascript: links are not allowed');
  expect(q<HTMLButtonElement>('.picker .actions .btn-primary').disabled).toBe(true);
  expect(roundTrip()).toEqual({ _version: 1, summary: 'Two bedrooms.' });
});

test('every control has a label', () => {
  show(
    [
      { path: ['title'], label: 'Title', type: 'text', required: true },
      { path: ['price'], label: 'Price', type: 'number', required: false },
      { path: ['featured'], label: 'Featured', type: 'boolean', required: false },
      { path: ['availableFrom'], label: 'Available from', type: 'date', required: false },
      {
        path: ['status'],
        label: 'Status',
        type: 'select',
        required: true,
        options: ['sale', 'rent'],
      },
      {
        path: ['energy'],
        label: 'Energy',
        type: 'select',
        required: false,
        options: ['a', 'b', 'c', 'd', 'e', 'f'],
      },
      { path: ['button'], label: 'Button', type: 'link', required: false },
      { path: ['body'], label: 'Body', type: 'richtext', required: false, tier: 'full' },
      {
        path: ['address'],
        label: 'Address',
        type: 'group',
        required: true,
        fields: [{ path: ['street'], label: 'Street', type: 'text', required: true }],
      },
      rooms,
      tags,
      { path: ['hero'], label: 'Hero', type: 'image', required: false, preset: { max: 2400 } },
      { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: TYPES },
      { path: ['photos'], label: 'Photos', type: 'unsupported' },
    ],
    { ...arrayData(), ...blocksData() },
    registry,
  );
  const controls = Array.from(
    document.querySelectorAll<HTMLElement>('input, textarea, select, [contenteditable]'),
  );
  expect(controls.length).toBeGreaterThan(10);
  for (const el of controls) {
    const labelled =
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
      el.closest('label') ||
      el.getAttribute('aria-labelledby');
    expect(labelled, `${el.tagName}#${el.id} has no label`).toBeTruthy();
  }
});

// --- 1.13: arrays, blocks and the read-only structured types ---

const rooms: Field = {
  path: ['rooms'],
  label: 'Rooms',
  type: 'array',
  required: true,
  item: [
    { path: ['name'], label: 'Name', type: 'text', required: true },
    { path: ['area'], label: 'Area', type: 'number', required: true },
  ],
};
const tags: Field = {
  path: ['tags'],
  label: 'Tags',
  type: 'array',
  required: false,
  item: [{ path: [], label: '', type: 'text', required: true }],
};
const arrayData = () => parseEntry('default', golden('array')) as Record<string, unknown>;
const snap = () => $state.snapshot(root) as Record<string, never>;
const click = (sel: string) => {
  q<HTMLButtonElement>(sel).click();
  flushSync();
};

// jsdom lays nothing out, and dnd-kit finds the row under the pointer by its box: cards are
// stacked 100 px tall in DOM order, and everything else is as wide as the viewport. A card
// being dragged floats by the translate dnd-kit gives it; the copy parked in its place holds
// the slot.
const CARD = '.row-card, .block-card';
const laidOut = () =>
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const found = this.closest(CARD);
    const card = found?.hasAttribute('data-dnd-placeholder') ? found.previousElementSibling : found;
    if (!card?.parentElement) return new DOMRect(0, 0, 1024, 4096);
    const cards = Array.from(card.parentElement.children).filter(
      (el) => el.matches(CARD) && !el.hasAttribute('data-dnd-placeholder'),
    );
    const floated =
      this === card ? (card as HTMLElement).style.getPropertyValue('--dnd-translate') : '';
    return new DOMRect(
      0,
      cards.indexOf(card) * 100 + (parseFloat(floated.split(' ')[1] ?? '') || 0),
      400,
      100,
    );
  });
// A fetch answers, a sensor takes its frame: whatever is a step behind the event lands first.
const settle = async () => {
  await new Promise((r) => setTimeout(r, 40));
  flushSync();
};
const key = async (target: Element | Document, code: string) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  await settle();
};
/** Grab a handle with Space, press the arrow `steps` times, let go with Space. */
const keyMove = async (name: string, steps: number) => {
  await key(q(`[aria-label="Reorder ${name}"]`), 'Space');
  for (let n = 0; n < Math.abs(steps); n++)
    await key(document, steps > 0 ? 'ArrowDown' : 'ArrowUp');
  await key(document, 'Space');
};
const pointer = async (target: Element | Document, type: string, y: number) => {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      isPrimary: true,
      pointerId: 1,
      button: 0,
      pointerType: 'mouse',
      clientX: 20,
      clientY: y,
    }),
  );
  await settle();
};
/** Press the handle, drag it `by` pixels down the page, release. */
const mouseMove = async (name: string, by: number) => {
  const handle = q(`[aria-label="Reorder ${name}"]`);
  const y = handle.getBoundingClientRect().y + 50;
  await pointer(handle, 'pointerdown', y);
  await pointer(document, 'pointermove', y + by / 2);
  await pointer(document, 'pointermove', y + by);
  await pointer(document, 'pointerup', y + by);
};
const MOVED = `_version: 1
rooms:
  - _id: "f4a8c3d6"
    name: "Master bedroom"
    area: 22
  - _id: "b7c2d9e1"
    name: "Kitchen"
    area: 18.5
tags:
  - "coastal"
  - "garden"
`;

test('array: reordering by keyboard emits the reordered YAML and both _ids survive', async () => {
  laidOut();
  show([rooms, tags], arrayData());
  expect(document.querySelectorAll('#f-rooms .row-card')).toHaveLength(2);
  await keyMove('Rooms row 1', 1);
  expect(stringifyEntry('default', snap())).toBe(MOVED);
  await keyMove('Rooms row 2', -1);
  expect(stringifyEntry('default', snap())).toBe(golden('array'));
});

test('array: reordering by mouse emits the same YAML as the keyboard', async () => {
  laidOut();
  show([rooms, tags], arrayData());
  await mouseMove('Rooms row 1', 100);
  expect(stringifyEntry('default', snap())).toBe(MOVED);
  await mouseMove('Rooms row 2', -100);
  expect(stringifyEntry('default', snap())).toBe(golden('array'));
});

test('array: the rows make room while the card is still in the air', async () => {
  laidOut();
  show([rooms, tags], arrayData());
  await key(q('[aria-label="Reorder Rooms row 1"]'), 'Space');
  await key(document, 'ArrowDown');
  expect(stringifyEntry('default', snap())).toBe(MOVED);
  expect(document.querySelector('#f-rooms [data-dnd-placeholder]')).not.toBeNull();
  await key(document, 'Space');
  expect(stringifyEntry('default', snap())).toBe(MOVED);
});

test('array of scalars: a row moves as a card, and its words go with it', async () => {
  laidOut();
  show([tags], { _version: 1, tags: ['coastal', 'garden', 'quiet'] });
  await keyMove('Tags row 3', -2);
  expect(roundTrip()).toEqual({ _version: 1, tags: ['quiet', 'coastal', 'garden'] });
  expect(q<HTMLInputElement>('input#f-tags\\.0').value).toBe('quiet');
});

test('array: Escape puts a picked-up row back where it was', async () => {
  laidOut();
  show([rooms, tags], arrayData());
  await key(q('[aria-label="Reorder Rooms row 1"]'), 'Space');
  await key(document, 'ArrowDown');
  await key(document, 'Escape');
  expect(stringifyEntry('default', snap())).toBe(golden('array'));
});

test('array: an added row gets a fresh _id and its own inputs', () => {
  show([rooms], { _version: 1 });
  click('#f-rooms .add');
  const added = (snap() as unknown as { rooms: { _id: string }[] }).rooms;
  expect(added).toHaveLength(1);
  expect(added[0]?._id).toMatch(/^[0-9a-z]{8}$/);
  type('input#f-rooms\\.0\\.name', 'Kitchen');
  fire('input#f-rooms\\.0\\.area', 'input', (el) => {
    el.value = '18.5';
  });
  expect((snap() as unknown as { rooms: unknown[] }).rooms[0]).toEqual({
    _id: added[0]?._id,
    name: 'Kitchen',
    area: 18.5,
  });
});

test('array: removing a row drops that row and leaves the other', () => {
  show([rooms], arrayData());
  click('[aria-label="Remove Rooms row 1"]');
  expect((snap() as unknown as { rooms: { _id: string }[] }).rooms.map((r) => r._id)).toEqual([
    'f4a8c3d6',
  ]);
});

test('array of scalars: rows are numbered, labelled and stay plain strings', () => {
  show([tags], { _version: 1, tags: ['coastal'] });
  // Every item of a `z.array(z.string())` is required, so each row carries the mark.
  expect(q('label[for="f-tags.0"]').textContent).toBe('Tags 1*');
  click('#f-tags .add');
  expect(q('label[for="f-tags.1"]').textContent).toBe('Tags 2*');
  type('input#f-tags\\.1', 'garden');
  expect(roundTrip()).toEqual({ _version: 1, tags: ['coastal', 'garden'] });
});

// The demo's registry, as `formOf` returns it. `textSection.body` is a `text` field so a
// block move is tested on the YAML, not on TipTap's survival of a DOM move.
const TYPES = ['hero', 'textSection', 'cta', 'columns'];
const registry: Record<string, Field[]> = {
  hero: [
    { path: ['heading'], label: 'Heading', type: 'text', required: true },
    {
      path: ['image'],
      label: 'Image',
      type: 'image',
      required: false,
      preset: { ratio: '16:9', max: 2400 },
    },
  ],
  textSection: [{ path: ['body'], label: 'Body', type: 'text', required: true }],
  cta: [
    { path: ['heading'], label: 'Heading', type: 'text', required: true },
    { path: ['button'], label: 'Button', type: 'link', required: false },
  ],
  columns: [
    {
      path: ['columns'],
      label: 'Columns',
      type: 'array',
      required: true,
      item: [{ path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: TYPES }],
    },
  ],
};
const pageFields: Field[] = [
  { path: ['title'], label: 'Title', type: 'text', required: true },
  { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: TYPES },
];
const blocksData = () => parseEntry('default', golden('blocks')) as Record<string, unknown>;

test('blocks: the golden renders through the registry, nesting and all, unchanged', () => {
  show(pageFields, blocksData(), registry);
  expect(q<HTMLInputElement>('input#f-blocks\\.0\\.heading').value).toBe('Move to the coast');
  expect(q('#f-blocks\\.1 header .type').textContent).toBe('columns · a1b2c3d4');
  expect(q('#f-blocks\\.1 header .label').textContent).toBe('Two columns');
  expect(
    q<HTMLTextAreaElement>('textarea#f-blocks\\.1\\.columns\\.0\\.blocks\\.0\\.body').value,
  ).toBe('First paragraph.\n\nSecond paragraph.');
  expect(stringifyEntry('default', snap())).toBe(golden('blocks'));
});

test('blocks: a _ref block is read-only instead of an empty form', () => {
  show(pageFields, blocksData(), registry);
  const at = '#f-blocks\\.1\\.columns\\.1\\.blocks\\.0';
  expect(q(`${at} .ref-note`).textContent).toContain('globals/cta-newsletter');
  expect(document.querySelector(`${at} input`)).toBeNull();
});

test('blocks: moving a block keeps every nested _id and moving back restores the file', async () => {
  laidOut();
  show(pageFields, blocksData(), registry);
  await keyMove('hero', 1);
  const order = (snap() as unknown as { blocks: { _type: string; _id: string }[] }).blocks;
  expect(order.map((b) => `${b._type} ${b._id}`)).toEqual(['columns a1b2c3d4', 'hero k3nf9a2p']);
  await mouseMove('hero', -100);
  expect(stringifyEntry('default', snap())).toBe(golden('blocks'));
});

test('blocks: a collapsed block keeps its header, shows its first words and stays put on a move', async () => {
  laidOut();
  show(pageFields, blocksData(), registry);
  const fold = () => q<HTMLButtonElement>('#f-blocks\\.0 > header .fold');
  expect(fold().getAttribute('aria-expanded')).toBe('true');
  click('#f-blocks\\.0 > header .fold');
  expect(fold().getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('input#f-blocks\\.0\\.heading')).toBeNull();
  expect(q('#f-blocks\\.0 > header .excerpt').textContent).toBe('Move to the coast');
  // The fold belongs to the block, not to its slot: after the move it is the second card.
  await keyMove('hero', 1);
  expect(q('#f-blocks\\.1 > header .fold').getAttribute('aria-expanded')).toBe('false');
  expect(q('#f-blocks\\.0 > header .fold').getAttribute('aria-expanded')).toBe('true');
  click('#f-blocks\\.1 > header .fold');
  expect(q<HTMLInputElement>('input#f-blocks\\.1\\.heading').value).toBe('Move to the coast');
  expect(stringifyEntry('default', snap())).not.toBe(golden('blocks'));
});

test('blocks: the picker lists the registry types and adds one with a fresh _id', () => {
  show(pageFields, { _version: 1, title: 'Home' }, registry);
  expect(document.querySelector('.block-picker')).toBeNull();
  click('#f-blocks .add');
  expect(q('#f-blocks .add').getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelectorAll('.block-picker .type-card')).toHaveLength(4);
  click('.type-card[value="cta"]');
  const added = (snap() as unknown as { blocks: { _type: string; _id: string }[] }).blocks;
  expect(added).toHaveLength(1);
  expect(added[0]?._type).toBe('cta');
  expect(added[0]?._id).toMatch(/^[0-9a-z]{8}$/);
  expect(document.querySelector('.block-picker')).toBeNull();
  type('input#f-blocks\\.0\\.heading', 'Call us');
  expect(q('#f-blocks\\.0 header .label').textContent).toBe('cta');
});

test('blocks: removing a block drops it and its children', () => {
  show(pageFields, blocksData(), registry);
  click('[aria-label="Remove Two columns"]');
  const left = (snap() as unknown as { blocks: { _id: string }[] }).blocks;
  expect(left.map((b) => b._id)).toEqual(['k3nf9a2p']);
});

test('an image inside a block draws what is stored and writes the file back unchanged', () => {
  show(pageFields, blocksData(), registry);
  expect(q<HTMLImageElement>('#f-blocks\\.0 .media-card img').getAttribute('src')).toBe(
    '/media/9f3a2c7e.webp',
  );
  expect(q<HTMLInputElement>('input#f-blocks\\.0\\.image\\.alt').value).toBe('Front of the house');
  expect(stringifyEntry('default', snap())).toBe(golden('blocks'));
});

const embedFields: Field[] = [
  { path: ['video'], label: 'Video', type: 'embed', required: false },
  { path: ['map'], label: 'Map', type: 'embed', required: false },
];
const embedData = () => parseEntry('default', golden('embed')) as Record<string, unknown>;

test('embed: a pasted link and a typed title round-trip through the embed golden', () => {
  show(embedFields, { _version: 1 });
  type('input#f-video', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42');
  expect(q('#f-video .badge').textContent).toBe('YouTube');
  expect(q('#f-video .sub').textContent).toBe('dQw4w9WgXcQ');
  // The still comes straight from the provider: no thumbnail fetch through the Worker.
  expect(q('#f-video .thumb img').getAttribute('src')).toBe(
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  );
  type('input#f-video\\.title', 'Walkthrough video');
  type('input#f-map', 'https://www.google.com/maps/place/Seaview+Cottage,+Devon/@50.5,-4.8,17z');
  expect(q('#f-map .badge').textContent).toBe('Google Maps');
  expect(stringifyEntry('default', snap())).toBe(golden('embed'));
});

// The URL is never what is stored, so a link nobody can read must not empty a field that is
// already filled: the client would have to find the old video again.
test('embed: a link we do not recognise is refused under the box and the video is kept', () => {
  show([embedFields[0] as Field], embedData());
  click('#f-video .actions button');
  type('input#f-video', 'https://www.dailymotion.com/video/x8abc');
  expect(q('#f-video-paste').textContent).toBe(
    'We don’t recognise this link. Supported: YouTube, Vimeo, Google Maps.',
  );
  expect(q('input#f-video').getAttribute('aria-describedby')).toBe('f-video-paste f-video-keep');
  expect(root.video).toEqual({
    provider: 'youtube',
    id: 'dQw4w9WgXcQ',
    title: 'Walkthrough video',
    start: 42,
  });
  expect(q('.media-card .badge').textContent).toBe('YouTube');
  click('.media-card .actions button');
  expect(document.querySelector('#f-video-paste')).toBeNull();
  expect(q('#f-video .badge').textContent).toBe('YouTube');
});

test('embed: a recognised link replaces the whole value, title and all', () => {
  show([embedFields[0] as Field], embedData());
  click('#f-video .actions button');
  type('input#f-video', 'https://vimeo.com/76979871');
  expect(root.video).toEqual({ provider: 'vimeo', id: '76979871' });
  expect(q('#f-video .badge').textContent).toBe('Vimeo');
  expect(document.querySelector('#f-video .thumb img')).toBeNull();
});

// axe scores nothing on this: a control that replaces itself takes the reader's place with it,
// so a keyboard is left on the body in the middle of a long form.
test('embed: Change takes the focus into the box and Keep this one gives it back', async () => {
  show([embedFields[0] as Field], embedData());
  click('#f-video-change');
  await tick();
  await tick();
  expect(document.activeElement?.id).toBe('f-video');
  click('.media-card .actions button');
  await tick();
  await tick();
  expect(document.activeElement?.id).toBe('f-video-change');
});

test('embed: Remove empties the field', () => {
  show([embedFields[0] as Field], embedData());
  click('#f-video .actions button:last-of-type');
  expect(snap().video).toBeUndefined();
  expect(q('input#f-video').getAttribute('placeholder')).toBe(
    'Paste a YouTube, Vimeo or Google Maps link',
  );
});

// The provider and the id are the same in every language; the title is what the shipped
// `<Embed />` puts on the iframe for a screen reader, so it is the half a translation owns.
test('embed: a translation is offered the title and nothing else', () => {
  root = embedData();
  app = mount(Fields, {
    target: document.body,
    props: {
      fields: [embedFields[0] as Field],
      translating: true,
      locale: 'de',
      get root() {
        return root;
      },
      set root(v) {
        root = v;
      },
    },
  });
  flushSync();
  expect(q('#f-video .badge').textContent).toBe('YouTube');
  expect(document.querySelector('input#f-video')).toBeNull();
  expect(document.querySelector('#f-video .actions')).toBeNull();
  expect(document.querySelector('input#f-video\\.start')).toBeNull();
  type('input#f-video\\.title', 'Rundgang');
  expect(root.video).toEqual({
    provider: 'youtube',
    id: 'dQw4w9WgXcQ',
    title: 'Rundgang',
    start: 42,
  });
});

test('seo says why it is read-only', () => {
  show([{ path: ['thing'], label: 'Thing', type: 'seo', required: false } as Field], {});
  expect(q('#f-thing-hint').textContent).toBe(
    'SEO settings can be changed from Phase 4. Shown as stored.',
  );
  expect(q('#f-thing').getAttribute('aria-describedby')).toBe('f-thing-hint');
});

test('a field the schema refuses is marked, described and still editable', () => {
  show(
    [{ path: ['title'], label: 'Title', type: 'text', required: true }],
    {},
    {},
    {
      title: 'Required',
    },
  );
  expect(q('#f-title').closest('.field')?.classList.contains('is-invalid')).toBe(true);
  expect(q('#f-title').getAttribute('aria-invalid')).toBe('true');
  expect(q('#f-title').getAttribute('aria-describedby')).toBe('f-title-err');
  expect(q('#f-title-err').textContent).toBe('Required');
  type('#f-title', 'Morning Drift');
  expect(root).toEqual({ title: 'Morning Drift' });
});

// The one an editor cannot fix from the form: the widget is read-only until its phase, so
// saying what is wrong is all the screen can do — and it must not lose the hint that says so.
test('a read-only structured field keeps its hint next to the error', () => {
  show(
    [{ path: ['tour'], label: 'Tour', type: 'seo', required: true }],
    {},
    {},
    {
      tour: 'Required',
    },
  );
  expect(q('#f-tour').getAttribute('aria-describedby')).toBe('f-tour-hint f-tour-err');
  expect(q('#f-tour-err').textContent).toBe('Required');
});

// A reference has a picker now, so what an empty required one owes is the message and a way
// to fill it in — not a hint about a release that has arrived.
test('a required reference nobody has filled in says so on the box that opens the picker', () => {
  show(
    [
      {
        path: ['presenter'],
        label: 'Presenter',
        type: 'reference',
        required: true,
        collection: 'presenters',
      },
    ],
    {},
    {},
    { presenter: 'Required' },
  );
  expect(q('#f-presenter').getAttribute('aria-describedby')).toBe('f-presenter-err');
  expect(q('#f-presenter-err').textContent).toBe('Required');
  expect(q('#f-presenter button').textContent).toBe('Choose Presenter');
});

test('a field inside a block is marked by its own path, not the block’s', () => {
  show(pageFields, blocksData(), registry, { 'blocks.0.heading': 'Required' });
  expect(q('#f-blocks\\.0\\.heading-err').textContent).toBe('Required');
  expect(document.querySelector('#f-blocks\\.1\\.heading-err')).toBeNull();
});

test('a field with nothing wrong carries no error markup', () => {
  show([{ path: ['title'], label: 'Title', type: 'text', required: true }], { title: 'x' });
  expect(q('#f-title').getAttribute('aria-invalid')).toBeNull();
  expect(q('#f-title').getAttribute('aria-describedby')).toBeNull();
  expect(document.querySelector('.field.is-invalid')).toBeNull();
});

// TipTap owns the editable node, so the two attributes that change with the entry's problems
// are written onto it rather than declared in the markup.
test('an invalid richtext body is marked on the editable node itself', () => {
  show(
    [{ path: ['summary'], label: 'Summary', type: 'richtext', required: true, tier: 'basic' }],
    {},
    {},
    { summary: 'Required' },
  );
  const body = q('#f-summary');
  expect(body.getAttribute('aria-invalid')).toBe('true');
  expect(body.getAttribute('aria-describedby')).toBe('f-summary-err');
  expect(q('#f-summary-err').textContent).toBe('Required');
});

// --- 3.15: the image and file widgets ---

const heroField: Field = {
  path: ['hero'],
  label: 'Hero image',
  type: 'image',
  required: false,
  preset: { ratio: '16:9', max: 2400, min: 1600 },
};
const brochureField: Field = {
  path: ['brochure'],
  label: 'Brochure',
  type: 'file',
  required: false,
  accept: ['application/pdf'],
};
const imageData = () => parseEntry('default', golden('image')) as Record<string, unknown>;
/** The library endpoint the picker opens on, and a turn of the loop for it to arrive. */
const library = (media: unknown[]) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ media })),
  );
const fileData = () => parseEntry('default', golden('file')) as Record<string, unknown>;

test('an empty image field offers the library, and its two numbers are two lines', () => {
  show([heroField], { _version: 1 });
  const hints = Array.from(document.querySelectorAll('.dropzone .hint')).map((h) => h.textContent);
  // The floor is what a client can act on while choosing; the cap is what happens on the way in.
  expect(hints).toEqual([
    '16:9 · at least 1600 px wide',
    'JPEG, PNG or WebP · saved at up to 2400 px wide',
  ]);
  expect(q('.dropzone button').textContent).toBe('Choose from library');
});

// The menus are one tree for the whole site: the second column draws the same tree with one
// box a row, because the labels are the one thing in it that language owns.
test('menus: the translated column draws the tree as labels, with nothing to move', () => {
  const field: Field = {
    path: ['menus'],
    label: 'Menus',
    type: 'menus',
    required: true,
    i18n: 'duplicate',
  };
  const items = [{ _id: 'a1b2c3d4', label: 'Home', link: { type: 'url', href: '/' } }];
  show([field], { _version: 1, menus: [{ _id: 'menu0aaa', key: 'header', items }] });
  expect(document.querySelector('#f-menus.nav-build')).not.toBeNull();
  expect(document.querySelector('.nav-build.is-labels')).toBeNull();
  expect(document.querySelectorAll('.grip')).toHaveLength(1);

  unmount(app);
  app = mount(Fields, {
    target: document.body,
    props: {
      fields: [field],
      translating: true,
      locale: 'de',
      get root() {
        return root;
      },
      set root(v) {
        root = v;
      },
    },
  });
  flushSync();
  expect(document.querySelector('.nav-build.is-labels')).not.toBeNull();
  expect(document.querySelectorAll('.grip')).toHaveLength(0);
  expect(q<HTMLInputElement>('.menu-item .input').value).toBe('Home');
  expect(q('#f-menus').textContent).toContain('The shape of this menu is shared');
});

test('a picked image is written as the format stores it, and Remove empties the field', async () => {
  library([
    {
      id: 'a'.repeat(64),
      src: 'media/9f3a2c7e.webp',
      filename: 'front.webp',
      width: 2400,
      height: 1600,
    },
  ]);
  show([heroField], { _version: 1 });
  click('.dropzone button');
  await settle();
  click('.tile');
  click('.picker-foot .btn-primary');
  expect(stringifyEntry('default', snap())).toBe(
    `_version: 1
hero:
  src: "media/9f3a2c7e.webp"
  width: 2400
  height: 1600
`,
  );
  // The alt lands where the format puts it, rather than after the numbers: the widget wrote the
  // whole shape and left it as a hole until somebody typed one.
  type('input#f-hero\\.alt', 'Front of the house');
  expect(stringifyEntry('default', snap())).toBe(
    `_version: 1
hero:
  src: "media/9f3a2c7e.webp"
  alt: "Front of the house"
  width: 2400
  height: 1600
`,
  );
  click('.media-card .btn-ghost');
  expect(snap().hero).toBeUndefined();
});

// An array whose row is the picture: the picker takes several at once and each becomes a row,
// so a client fills a gallery in one pass rather than Add-then-choose per picture.
test('a gallery field inserts every picked image as a row of its own', async () => {
  const galleryField: Field = {
    path: ['gallery'],
    label: 'Gallery',
    type: 'array',
    required: false,
    item: [{ path: [], label: 'Gallery', type: 'image', required: true, preset: { ratio: '4:3' } }],
  };
  library([
    { id: 'a'.repeat(64), src: 'media/a.webp', filename: 'harbour.jpg', width: 2400, height: 1800 },
    { id: 'b'.repeat(64), src: 'media/b.webp', filename: 'garden.jpg', width: 2000, height: 1500 },
  ]);
  show([galleryField], { _version: 1 });
  click('.list .add');
  await settle();
  click(`.tile input[value="${'b'.repeat(64)}"]`);
  click(`.tile input[value="${'a'.repeat(64)}"]`);
  click('.picker-foot .btn-primary');
  expect(stringifyEntry('default', snap())).toBe(
    `_version: 1
gallery:
  - src: "media/b.webp"
    width: 2000
    height: 1500
  - src: "media/a.webp"
    width: 2400
    height: 1800
`,
  );
});

test('the file card names the download, and Remove empties the field', () => {
  show([brochureField], fileData());
  expect(q('.media-card .sub').textContent).toBe('files/3e8a1b9c.pdf · 2.4 MB · application/pdf');
  expect(q<HTMLInputElement>('input#f-brochure\\.name').value).toBe('Seaview Cottage brochure.pdf');
  click('.media-card .btn-ghost');
  expect(snap().brochure).toBeUndefined();
});

test('a translator gets the words and not the picture', () => {
  root = imageData();
  app = mount(Fields, {
    target: document.body,
    props: {
      fields: [heroField],
      translating: true,
      get root() {
        return root;
      },
      set root(v) {
        root = v;
      },
    },
  });
  flushSync();
  expect(q<HTMLInputElement>('input#f-hero\\.alt').value).toBe('Front of the house');
  // Nothing that would change the picture itself: that is the source language's.
  expect(document.querySelector('.media-card .actions')).toBeNull();
  expect(document.body.textContent).toContain('The picture is the same in every language.');
});

// --- 4.4: the focal point on the field ---

// The dot a page sets is this page's, and it wins over the library's default for it. The middle
// is not a choice: a page cropping around the centre is a page saying nothing about the crop.
test('the dot a page moves is written after the numbers, and centring it takes the key out', async () => {
  show([heroField], imageData());
  click('.media-card .actions .btn-sm');
  await settle();
  expect(q<HTMLInputElement>('input#focal-y').value).toBe('35');
  type('input#focal-y', '60');
  click('.focal-dialog .btn-primary');
  expect(stringifyEntry('default', snap())).toBe(
    `_version: 1
hero:
  src: "media/9f3a2c7e.webp"
  alt: "Front of the house"
  width: 2400
  height: 1600
  focal:
    - 0.5
    - 0.6
`,
  );
  click('.media-card .actions .btn-sm');
  await settle();
  type('input#focal-y', '50');
  click('.focal-dialog .btn-primary');
  expect(stringifyEntry('default', snap())).toBe(
    `_version: 1
hero:
  src: "media/9f3a2c7e.webp"
  alt: "Front of the house"
  width: 2400
  height: 1600
`,
  );
});

// The row's own dot comes with the picture: a client who framed it in the library does not
// frame it again on every page that uses it.
test('a picked picture brings the library’s dot with it, unless it is the middle', async () => {
  library([
    {
      id: 'a'.repeat(64),
      src: 'media/9f3a2c7e.webp',
      filename: 'front.webp',
      width: 2400,
      height: 1600,
      focal: [0.42, 0.3],
    },
  ]);
  show([heroField], { _version: 1 });
  click('.dropzone button');
  await settle();
  click('.tile');
  click('.picker-foot .btn-primary');
  expect(snap().hero).toMatchObject({ focal: [0.42, 0.3] });
  unmount(app);

  library([
    {
      id: 'b'.repeat(64),
      src: 'media/b.webp',
      filename: 'garden.webp',
      width: 2400,
      height: 1600,
      focal: [0.5, 0.5],
    },
  ]);
  show([heroField], { _version: 1 });
  click('.dropzone button');
  await settle();
  click('.tile');
  click('.picker-foot .btn-primary');
  // The key is a hole like `alt`, so what it is written as is what the file says: nothing.
  expect(stringifyEntry('default', snap())).toBe(
    `_version: 1
hero:
  src: "media/b.webp"
  width: 2400
  height: 1600
`,
  );
});
