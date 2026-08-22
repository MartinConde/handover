import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Field } from '@handover/core';
import { parseEntry, stringifyEntry } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';
import Fields from './Fields.svelte';

// Testing: every scalar widget and `group` writes the documented value shape, proven by
// state → YAML → state against the golden for the type; labels on every control.
// Not testing: Editor wiring (Editor.test.ts) or styling.

// jsdom has no layout; ProseMirror asks for it when it scrolls the selection into view.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

let app: ReturnType<typeof mount>;
let root: Record<string, unknown> = $state({});
const show = (fields: Field[], data: Record<string, unknown>) => {
  root = data;
  app = mount(Fields, {
    target: document.body,
    props: {
      fields,
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
afterEach(() => unmount(app));

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
  show([{ path: ['title'], type: 'text', required: true }], { _version: 1 });
  expect(q('label[for="f-title"]').textContent).toBe('Title*');
  type('input#f-title', 'Seaview Cottage');
  expect(root).toEqual({ _version: 1, title: 'Seaview Cottage' });
  expect(roundTrip()).toEqual(root);
});

test('text: a value with line breaks is a textarea and survives the round trip', () => {
  show([{ path: ['summary'], type: 'text', required: false }], {
    _version: 1,
    summary: 'First line.\nSecond line.',
  });
  type('textarea#f-summary', 'First line.\n\nThird line.');
  expect(roundTrip()).toEqual({ _version: 1, summary: 'First line.\n\nThird line.' });
});

test('number: writes a number, never a string; clearing removes the key', () => {
  show([{ path: ['price'], type: 'number', required: false }], { _version: 1 });
  fire('input#f-price', 'input', (el) => {
    el.value = '82.5';
  });
  expect(root).toEqual({ _version: 1, price: 82.5 });
  expect(stringifyEntry('default', $state.snapshot(root))).toBe('_version: 1\nprice: 82.5\n');
  type('input#f-price', '');
  expect(root).toEqual({ _version: 1 });
});

test('boolean: a switch with the label as its text writes true / false', () => {
  show([{ path: ['featured'], type: 'boolean', required: false }], { _version: 1 });
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
  show([{ path: ['availableFrom'], type: 'date', required: false }], { _version: 1 });
  expect(q<HTMLInputElement>('input#f-availableFrom').type).toBe('date');
  type('input#f-availableFrom', '2026-09-01');
  expect(stringifyEntry('default', $state.snapshot(root))).toBe(golden('date'));
  type('input#f-availableFrom', '');
  expect(root).toEqual({ _version: 1 });
});

test('select: five options or fewer are radios and store the value', () => {
  show([{ path: ['status'], type: 'select', required: true, options: ['sale', 'rent'] }], {
    _version: 1,
  });
  expect(q('fieldset legend').textContent).toBe('Status*');
  expect(document.querySelectorAll('input[type="radio"][name="f-status"]')).toHaveLength(2);
  fire('input[type="radio"][value="sale"]', 'change', (el) => {
    el.checked = true;
  });
  expect(stringifyEntry('default', $state.snapshot(root))).toBe(golden('select'));
});

test('select: more than five options is a dropdown; Choose… removes the key', () => {
  const options = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  show([{ path: ['energy'], type: 'select', required: false, options }], {
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
      { path: ['button'], type: 'link', required: true },
      { path: ['more'], type: 'link', required: false },
    ],
    { _version: 1 },
  );
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
  show([{ path: ['button'], type: 'link', required: true }], {
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
    type: 'group',
    required: true,
    fields: [
      { path: ['street'], type: 'text', required: true },
      { path: ['town'], type: 'text', required: true },
      { path: ['postcode'], type: 'text', required: true },
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
  show([{ path: ['body'], type: 'richtext', required: false, tier: 'full' }], {
    _version: 1,
    body,
  });
  expect(document.querySelectorAll('[role="toolbar"] button')).toHaveLength(8);
  expect(q('#f-body[contenteditable="true"]').getAttribute('aria-labelledby')).toBe('f-body-l');
  expect(q('#f-body h2').textContent).toBe('The house');
  expect(stringifyEntry('default', $state.snapshot(root))).toBe(golden('richtext'));
});

test('richtext: a toolbar command writes Markdown back and the button reads as pressed', () => {
  show([{ path: ['summary'], type: 'richtext', required: false, tier: 'basic' }], {
    _version: 1,
    summary: 'Two bedrooms.',
  });
  expect(document.querySelectorAll('[role="toolbar"] button')).toHaveLength(5);
  q<HTMLButtonElement>('[aria-label="Bullet list"]').click();
  flushSync();
  expect(q('[aria-label="Bullet list"]').getAttribute('aria-pressed')).toBe('true');
  expect(roundTrip()).toEqual({ _version: 1, summary: '- Two bedrooms.' });
});

test('richtext: a body outside the tier is shown read-only and left untouched', () => {
  show([{ path: ['summary'], type: 'richtext', required: false, tier: 'basic' }], {
    _version: 1,
    summary: body,
  });
  expect(document.querySelector('[role="toolbar"]')).toBeNull();
  expect(q('[role="region"] pre#f-summary').textContent).toBe(body);
  expect(q('#f-summary-hint').textContent).toContain('edited in code');
  expect(roundTrip()).toEqual({ _version: 1, summary: body });
});

test('every control has a label', () => {
  show(
    [
      { path: ['title'], type: 'text', required: true },
      { path: ['price'], type: 'number', required: false },
      { path: ['featured'], type: 'boolean', required: false },
      { path: ['availableFrom'], type: 'date', required: false },
      { path: ['status'], type: 'select', required: true, options: ['sale', 'rent'] },
      {
        path: ['energy'],
        type: 'select',
        required: false,
        options: ['a', 'b', 'c', 'd', 'e', 'f'],
      },
      { path: ['button'], type: 'link', required: false },
      { path: ['body'], type: 'richtext', required: false, tier: 'full' },
      {
        path: ['address'],
        type: 'group',
        required: true,
        fields: [{ path: ['street'], type: 'text', required: true }],
      },
      { path: ['photos'], type: 'unsupported' },
    ],
    { _version: 1 },
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
