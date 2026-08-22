import { expect, test } from 'vitest';
import { RICHTEXT_CONSTRUCTS, richtextErrors } from './richtext.js';

// One fixture per allowed construct, exactly as the editor will store it.
const basic: Record<string, string> = {
  paragraph: 'Two bedrooms, one bathroom.\n\nFive minutes from the beach.',
  bold: 'A **sunny** terrace.',
  italic: 'A *quiet* lane.',
  link: 'See the [floor plan](https://example.com/plan).',
  bulletList: '- Two bedrooms\n- One bathroom',
  numberedList: '1. Book a viewing\n2. Make an offer',
};
const full: Record<string, string> = {
  h2: '## The house',
  h3: '### The garden',
  blockquote: '> A rare find.',
};

for (const [name, md] of Object.entries(basic)) {
  test(`${name} is accepted by both tiers`, () => {
    expect(richtextErrors('default', md, 'basic')).toEqual([]);
    expect(richtextErrors('default', md, 'full')).toEqual([]);
  });
}

for (const [name, md] of Object.entries(full)) {
  test(`${name} is accepted by the full tier only`, () => {
    expect(richtextErrors('default', md, 'full')).toEqual([]);
    expect(richtextErrors('default', md, 'basic')).toHaveLength(1);
  });
}

test('the construct lists match the fixtures', () => {
  expect(RICHTEXT_CONSTRUCTS.basic).toEqual(Object.keys(basic));
  expect(RICHTEXT_CONSTRUCTS.full).toEqual([...Object.keys(basic), ...Object.keys(full)]);
});

// Each disallowed construct is named in the error, so the editor can say what was dropped.
const rejected: Record<string, [string, string]> = {
  h1: ['# Title', 'heading level 1'],
  h4: ['#### Small', 'heading level 4'],
  image: ['![Front](media/front.webp)', 'image'],
  htmlBlock: ['<div>raw</div>', 'html'],
  inlineHtml: ['A <b>bold</b> claim.', 'html'],
  codeBlock: ['```\nlet x = 1;\n```', 'code'],
  inlineCode: ['Run `pnpm build`.', 'inlineCode'],
  thematicBreak: ['Above\n\n---\n\nBelow', 'thematicBreak'],
  table: ['| a | b |\n|---|---|\n| 1 | 2 |', 'table'],
  strikethrough: ['~~old price~~', 'delete'],
  footnote: ['Claim[^1]\n\n[^1]: Source', 'footnoteReference'],
  taskList: ['- [ ] viewing', 'task list item'],
};

for (const [name, [md, construct]] of Object.entries(rejected)) {
  test(`${name} is rejected by the full tier as "${construct}"`, () => {
    const errors = richtextErrors('default', md, 'full');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain(construct);
  });
}

test('an error names the line of the offending construct', () => {
  expect(richtextErrors('default', 'Fine.\n\n# Not fine', 'full')).toEqual([
    'heading level 1 is not allowed (line 3)',
  ]);
});

test('blockquote and heading errors in the basic tier say which tier allows them', () => {
  expect(richtextErrors('default', '> Quote', 'basic')).toEqual([
    'blockquote needs richtext: full (line 1)',
  ]);
  expect(richtextErrors('default', '## Head', 'basic')).toEqual([
    'heading needs richtext: full (line 1)',
  ]);
});

test('a nested list is a list, not a new construct', () => {
  expect(richtextErrors('default', '- a\n  - b\n- c', 'basic')).toEqual([]);
});

test('an empty string is valid in both tiers', () => {
  expect(richtextErrors('default', '', 'basic')).toEqual([]);
});
