import { expect, test } from 'vitest';
import {
  RICHTEXT_CONSTRUCTS,
  renderRichtext,
  richtextErrors,
  unsafeLinkScheme,
} from './richtext.js';

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

// A link is the one construct that carries a target, and a `javascript:` or `data:` one
// runs in the reader's browser. Browsers ignore ASCII whitespace inside a URL, so the
// mangled forms are the same link.
const unsafeLinks: Record<string, string> = {
  javascript: '[x](javascript:alert(1))',
  mixedCase: '[x](JaVaScRiPt:alert(1))',
  entity: '[x](javascript&#58;alert(1))',
  tabbed: '[x](<java\tscript:alert(1)>)',
  spaced: '[x](<java script:alert(1)>)',
  data: '[x](data:text/html;base64,PHNjcmlwdD4=)',
};

for (const [name, md] of Object.entries(unsafeLinks)) {
  test(`a ${name} link is rejected by both tiers`, () => {
    expect(richtextErrors('default', md, 'basic')).toHaveLength(1);
    expect(richtextErrors('default', md, 'full')[0]).toMatch(/links are not allowed \(line 1\)/);
  });

  test(`a ${name} link renders as text, without an anchor`, () => {
    expect(renderRichtext('default', md)).toBe('<p>x</p>');
  });
}

const safeLinks: Record<string, string> = {
  https: 'https://example.com/plan',
  http: 'http://example.com/plan',
  mailto: 'mailto:hello@example.com',
  tel: 'tel:+34600000000',
  absolutePath: '/listings/mill-house/',
  anchor: '#the-garden',
  relativePath: 'plan.pdf',
  protocolRelative: '//example.com/plan',
};

for (const [name, url] of Object.entries(safeLinks)) {
  test(`a ${name} link is allowed`, () => {
    expect(unsafeLinkScheme('default', url)).toBeUndefined();
    expect(richtextErrors('default', `[x](${url})`, 'basic')).toEqual([]);
  });
}

test('an empty string is valid in both tiers', () => {
  expect(richtextErrors('default', '', 'basic')).toEqual([]);
});

// 1.6's construct list, rendered. Every allowed construct has one expected string, so a
// construct that validates but renders as nothing fails here.
const rendered: Record<string, string> = {
  paragraph: '<p>Two bedrooms, one bathroom.</p>\n<p>Five minutes from the beach.</p>',
  bold: '<p>A <strong>sunny</strong> terrace.</p>',
  italic: '<p>A <em>quiet</em> lane.</p>',
  link: '<p>See the <a href="https://example.com/plan">floor plan</a>.</p>',
  bulletList: '<ul>\n<li>Two bedrooms</li>\n<li>One bathroom</li>\n</ul>',
  numberedList: '<ol>\n<li>Book a viewing</li>\n<li>Make an offer</li>\n</ol>',
  h2: '<h2 id="the-house">The house</h2>',
  h3: '<h3 id="the-garden">The garden</h3>',
  blockquote: '<blockquote>\n<p>A rare find.</p>\n</blockquote>',
};

const fixtures: Record<string, string> = { ...basic, ...full };

for (const [name, html] of Object.entries(rendered)) {
  test(`${name} renders as ${html.split('\n')[0]}`, () => {
    expect(renderRichtext('default', fixtures[name] ?? '')).toBe(html);
  });
}

test('every allowed construct has a render fixture', () => {
  expect(Object.keys(rendered)).toEqual([...RICHTEXT_CONSTRUCTS.full]);
});

// The tiers exist to keep raw HTML out of the page; the renderer is the last place it
// could get back in, so it escapes rather than emits.
test('raw HTML is escaped, never emitted', () => {
  expect(renderRichtext('default', '<script>alert(1)</script>')).not.toContain('<script>');
  expect(renderRichtext('default', 'A <b>bold</b> claim.')).toBe(
    '<p>A &lt;b&gt;bold&lt;/b&gt; claim.</p>',
  );
});

test('a nested list renders inside its parent item', () => {
  expect(renderRichtext('default', '- a\n  - b\n- c')).toBe(
    '<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n<li>c</li>\n</ul>',
  );
});

test('a loose list keeps its paragraphs', () => {
  expect(renderRichtext('default', '- a\n\n- b')).toBe(
    '<ul>\n<li><p>a</p></li>\n<li><p>b</p></li>\n</ul>',
  );
});

// The slug and the URL are editor text in an attribute, so neither may close it early.
test('a heading and a link cannot break out of their attribute', () => {
  expect(renderRichtext('default', '## a" onmouseover="alert(1)')).toBe(
    '<h2 id="a-onmouseoveralert1">a" onmouseover="alert(1)</h2>',
  );
  expect(renderRichtext('default', '[x](https://e.com/?a="><script>)')).toBe(
    '<p><a href="https://e.com/?a=&quot;&gt;&lt;script&gt;">x</a></p>',
  );
});

test('two headings with the same text get different ids', () => {
  expect(renderRichtext('default', '## The house\n\n## The house')).toBe(
    '<h2 id="the-house">The house</h2>\n<h2 id="the-house-1">The house</h2>',
  );
});
