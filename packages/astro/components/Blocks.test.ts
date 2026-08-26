import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Block, parseEntry } from '@handover/core';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { expect, test } from 'vitest';
import Columns from '../test/blocks/Columns.astro';
import Cta from '../test/blocks/Cta.astro';
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

test('<Blocks /> renders the 1.5 golden through the components, three levels deep', async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Blocks, {
    props: { blocks: blocksOf(golden), components, globals: en },
  });

  expect(html).toContain('<h1>Move to the coast</h1>');
  expect(html).toContain('<div class="column"><p>First paragraph.\n\nSecond paragraph.</p></div>');
  expect(html.trim().startsWith('<h1>')).toBe(true);
});

// The golden's `_ref` sits three levels down, inside a column, and the nesting component passes
// on `components` alone: filling the whole tree at the top is what makes that work.
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
