import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEntry } from '@handover/core';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { expect, test, vi } from 'vitest';
import Markdown from './Markdown.astro';

const golden = readFileSync(
  join(import.meta.dirname, '../../core/test/golden/richtext.yaml'),
  'utf8',
);

test('<Markdown /> renders the richtext golden without warnings', async () => {
  const warn = vi.spyOn(console, 'warn');
  const container = await AstroContainer.create();
  const { body } = parseEntry('default', golden) as { body: string };
  const html = await container.renderToString(Markdown, { props: { content: body } });

  expect(html).toContain('<h2 id="the-house">The house</h2>');
  expect(html).toContain('<strong>sunny</strong>');
  expect(html).toContain('<em>quiet</em>');
  expect(html).toContain('<ul>');
  expect(html).toContain('<ol>');
  expect(html).toContain('<a href="https://example.com/viewings">viewing</a>');
  expect(html).toContain('<h3 id="the-garden">The garden</h3>');
  expect(html).toContain('<blockquote>');
  expect(warn).not.toHaveBeenCalled();
});

test('<Markdown /> escapes nothing twice and adds no wrapper element', async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Markdown, { props: { content: 'Tom & Jerry' } });
  expect(html.trim()).toBe('<p>Tom &amp; Jerry</p>');
});
