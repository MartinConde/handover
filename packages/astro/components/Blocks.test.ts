import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Block, parseEntry } from '@handover/core';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { expect, test } from 'vitest';
import Columns from '../test/blocks/Columns.astro';
import Cta from '../test/blocks/Cta.astro';
import EditableBlocks from '../test/blocks/EditableBlocks.astro';
import Hero from '../test/blocks/Hero.astro';
import TextSection from '../test/blocks/TextSection.astro';
import Blocks from './Blocks.astro';

const golden = readFileSync(
  join(import.meta.dirname, '../../core/test/golden/blocks.yaml'),
  'utf8',
);
const components = { hero: Hero, textSection: TextSection, columns: Columns, cta: Cta };
const en = { 'cta-newsletter': { heading: 'Ready to move?', href: '/contact' } };
const de = { 'cta-newsletter': { heading: 'Bereit umzuziehen?', href: '/de/kontakt' } };
const blocksOf = (source: string) => (parseEntry('default', source) as { blocks: Block[] }).blocks;
const canvas = {
  protocol: 1 as const,
  requestId: 'render-22',
  epoch: 'session-22',
  entry: { collection: 'pages', id: 'canvas-fixture' },
  locale: 'en',
  contentVersion: 22,
};

test('<Blocks /> renders the 1.5 golden through the components, three levels deep', async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Blocks, {
    props: { blocks: blocksOf(golden), components, globals: en },
  });

  expect(html).toContain('<h1>Move to the coast</h1>');
  expect(html).toContain('<div class="column"><p>First paragraph.\n\nSecond paragraph.</p></div>');
  expect(html.trim().startsWith('<h1>')).toBe(true);
});

// The `_ref` sits three levels down and the nesting component passes on `components` alone.
test('<Blocks /> fills a nested _ref block from the globals of the language it is given', async () => {
  const container = await AstroContainer.create();
  const render = (globals: Record<string, unknown>) =>
    container.renderToString(Blocks, { props: { blocks: blocksOf(golden), components, globals } });

  expect(await render(en)).toContain('<a class="cta" href="/contact">Ready to move?</a>');
  expect(await render(de)).toContain('<a class="cta" href="/de/kontakt">Bereit umzuziehen?</a>');
});

test("<Blocks /> keeps the page's own _type and _id over the global's", async () => {
  const container = await AstroContainer.create();
  const blocks = [{ _type: 'cta', _id: 'q7r8s9t0', _ref: 'globals/cta-newsletter' }];
  const html = await container.renderToString(Blocks, {
    props: {
      blocks,
      components,
      globals: { 'cta-newsletter': { ...en['cta-newsletter'], _type: 'hero', _id: 'zzzzzzzz' } },
    },
  });

  expect(html).toContain('<a class="cta" href="/contact">Ready to move?</a>');
});

test('<Blocks /> names the global a _ref points at when this language has no such file', async () => {
  const container = await AstroContainer.create();
  await expect(
    container.renderToString(Blocks, {
      props: { blocks: blocksOf(golden), components, globals: {} },
    }),
  ).rejects.toThrow(
    'No global "cta-newsletter" in this language: a _ref block is filled from src/content/globals/<locale>/cta-newsletter.yaml',
  );
});

test('<Blocks /> names the block type it has no component for', async () => {
  const container = await AstroContainer.create();
  const blocks = [{ _type: 'video', _id: 'k3nf9a2p' }];
  await expect(container.renderToString(Blocks, { props: { blocks, components } })).rejects.toThrow(
    'No component for block type "video"',
  );
});

test('<Blocks /> passes stable edit contexts through nested and empty lists without wrappers', async () => {
  const container = await AstroContainer.create();
  const blocks = [
    {
      _type: 'repeated',
      _id: 'repeat01',
      _label: 'Opening words',
      heading: 'Repeated source field',
    },
    {
      _type: 'columns',
      _id: 'columns1',
      columns: [
        {
          _id: 'column01',
          blocks: [{ _type: 'promo', _id: 'promo001', _ref: 'globals/shared-promo' }],
        },
        { _id: 'column02', blocks: [] },
      ],
    },
  ];
  const html = await container.renderToString(EditableBlocks, {
    props: { blocks, globals: { 'shared-promo': { heading: 'Shared promotion' } } },
    locals: { handoverCanvas: canvas },
  });

  expect(html.match(/data-repeated-heading/g)).toHaveLength(2);
  expect(html.match(/data-handover-field=/g)).toHaveLength(3);
  expect(html.match(/data-handover-list=/g)).toHaveLength(4);
  expect(html.match(/data-handover-block=/g)).toHaveLength(5);
  expect(html).toContain('&quot;address&quot;:&quot;blocks[_id=repeat01].heading&quot;');
  expect(html).toContain(
    '&quot;address&quot;:&quot;blocks[_id=columns1].columns[_id=column02].blocks&quot;',
  );
  expect(html).not.toContain('<astro-fragment');
  // Structure names a block by its label where the author gave one, else by its type.
  expect(html).toContain('data-handover-name="Opening words"');
  expect(html).toContain('data-handover-name="Columns"');
  expect(html).toContain('data-handover-name="Promo"');
});

test('<Blocks /> keeps a nested reference field owned by its global and names its occurrence', async () => {
  const container = await AstroContainer.create();
  const blocks = [
    {
      _type: 'columns',
      _id: 'columns1',
      columns: [
        {
          _id: 'column01',
          blocks: [{ _type: 'promo', _id: 'promo001', _ref: 'globals/shared-promo' }],
        },
        {
          _id: 'column02',
          blocks: [{ _type: 'promo', _id: 'promo002', _ref: 'globals/shared-promo' }],
        },
      ],
    },
  ];
  const html = await container.renderToString(EditableBlocks, {
    props: { blocks, globals: { 'shared-promo': { heading: 'Shared promotion' } } },
    locals: { handoverCanvas: canvas },
  });
  const markers = [...html.matchAll(/data-handover-field="([^"]+)" data-shared-promo/g)].map(
    (match) => match[1] ?? '',
  );

  expect(markers).toHaveLength(2);
  expect(markers[0]).toContain('&quot;collection&quot;:&quot;globals&quot;');
  expect(markers[0]).toContain('&quot;id&quot;:&quot;shared-promo&quot;');
  expect(markers[0]).toContain('&quot;address&quot;:&quot;heading&quot;');
  expect(markers[0]).toContain('&quot;occurrence&quot;:');
  expect(markers[0]).toContain(
    '&quot;address&quot;:&quot;blocks[_id=columns1].columns[_id=column01].blocks[_id=promo001]&quot;',
  );
  expect(markers[1]).toContain(
    '&quot;address&quot;:&quot;blocks[_id=columns1].columns[_id=column02].blocks[_id=promo002]&quot;',
  );
});

test('<Blocks /> emits no edit markers for the same template outside Canvas', async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(EditableBlocks, {
    props: {
      blocks: [{ _type: 'repeated', _id: 'repeat01', heading: 'Public heading' }],
    },
    locals: {},
  });

  expect(html).toContain('Public heading');
  expect(html).not.toContain('data-handover-');
});

test('<Blocks /> refuses ambiguous block ids in Canvas without changing public rendering', async () => {
  const container = await AstroContainer.create();
  const blocks = [
    { _type: 'repeated', _id: 'same-id', heading: 'First' },
    { _type: 'repeated', _id: 'same-id', heading: 'Second' },
  ];

  await expect(
    container.renderToString(EditableBlocks, {
      props: { blocks },
      locals: { handoverCanvas: canvas },
    }),
  ).rejects.toThrow('Canvas cannot annotate duplicate block _id "same-id".');
  expect(
    await container.renderToString(EditableBlocks, { props: { blocks }, locals: {} }),
  ).toContain('Second');
});
