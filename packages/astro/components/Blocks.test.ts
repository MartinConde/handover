import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Block, parseEntry } from '@handover/core';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { expect, test } from 'vitest';
import Columns from '../test/blocks/Columns.astro';
import Hero from '../test/blocks/Hero.astro';
import TextSection from '../test/blocks/TextSection.astro';
import Blocks from './Blocks.astro';

const golden = readFileSync(
  join(import.meta.dirname, '../../core/test/golden/blocks.yaml'),
  'utf8',
);
const components = { hero: Hero, textSection: TextSection, columns: Columns };

test('<Blocks /> renders the 1.5 golden through the components, three levels deep', async () => {
  const container = await AstroContainer.create();
  const { blocks } = parseEntry('default', golden) as { blocks: Block[] };
  const html = await container.renderToString(Blocks, { props: { blocks, components } });

  expect(html).toContain('<h1>Move to the coast</h1>');
  expect(html).toContain('<div class="column"><p>First paragraph.\n\nSecond paragraph.</p></div>');
  expect(html).not.toContain('cta');
  expect(html.trim().startsWith('<h1>')).toBe(true);
});

test('<Blocks /> names the block type it has no component for', async () => {
  const container = await AstroContainer.create();
  const blocks = [{ _type: 'video', _id: 'k3nf9a2p' }];
  await expect(container.renderToString(Blocks, { props: { blocks, components } })).rejects.toThrow(
    'No component for block type "video"',
  );
});
