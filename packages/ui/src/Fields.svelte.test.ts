import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Field } from '@handover/core';
import { parseEntry, stringifyEntry } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
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
});

const golden = (name: string) =>
  readFileSync(resolve(__dirname, `../../core/test/golden/${name}.yaml`), 'utf8');
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

test('link: URL and entry modes write the two shapes from the link golden', () => {
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
  type('input#f-more\\.ref', 'listings/mill-house');
  expect(stringifyEntry('default', $state.snapshot(root))).toBe(golden('link'));
});

test('link: switching type drops the other target; new tab off leaves no key', () => {
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
  type('input#f-button\\.ref', 'pages/contact');
  expect(roundTrip()).toEqual({ _version: 1, button: { type: 'entry', ref: 'pages/contact' } });
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

test('array: moving a row emits the reordered YAML and both _ids survive', () => {
  show([rooms, tags], arrayData());
  expect(document.querySelectorAll('#f-rooms .row-card')).toHaveLength(2);
  click('[aria-label="Move Rooms row 1 down"]');
  expect(stringifyEntry('default', snap())).toBe(
    `_version: 1
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
`,
  );
  click('[aria-label="Move Rooms row 2 up"]');
  expect(stringifyEntry('default', snap())).toBe(golden('array'));
});

test('array: the first row cannot move up and the last cannot move down', () => {
  show([rooms], arrayData());
  expect(q<HTMLButtonElement>('[aria-label="Move Rooms row 1 up"]').disabled).toBe(true);
  expect(q<HTMLButtonElement>('[aria-label="Move Rooms row 1 down"]').disabled).toBe(false);
  expect(q<HTMLButtonElement>('[aria-label="Move Rooms row 2 up"]').disabled).toBe(false);
  expect(q<HTMLButtonElement>('[aria-label="Move Rooms row 2 down"]').disabled).toBe(true);
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

test('blocks: moving a block keeps every nested _id and moving back restores the file', () => {
  show(pageFields, blocksData(), registry);
  expect(q<HTMLButtonElement>('[aria-label="Move hero up"]').disabled).toBe(true);
  expect(q<HTMLButtonElement>('[aria-label="Move Two columns down"]').disabled).toBe(true);
  click('[aria-label="Move hero down"]');
  const order = (snap() as unknown as { blocks: { _type: string; _id: string }[] }).blocks;
  expect(order.map((b) => `${b._type} ${b._id}`)).toEqual(['columns a1b2c3d4', 'hero k3nf9a2p']);
  click('[aria-label="Move hero up"]');
  expect(stringifyEntry('default', snap())).toBe(golden('blocks'));
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

test.each([
  ['embed', 'Embeds can be changed from Phase 4. Shown as stored.'],
  ['seo', 'SEO settings can be changed from Phase 4. Shown as stored.'],
  ['reference', 'References can be changed from Phase 2. Shown as stored.'],
] as const)('structured types: %s says why it is read-only', (type, sentence) => {
  show([{ path: ['thing'], label: 'Thing', type, required: false } as Field], {});
  const hint = q('#f-thing-hint');
  expect(hint.textContent).toBe(sentence);
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
    {
      presenter: 'Required',
    },
  );
  expect(q('#f-presenter').getAttribute('aria-describedby')).toBe(
    'f-presenter-hint f-presenter-err',
  );
  expect(q('#f-presenter-err').textContent).toBe('Required');
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
const settle = async () => {
  await new Promise((r) => setTimeout(r));
  flushSync();
};
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
