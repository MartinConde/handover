import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { expect, test } from 'vitest';
import EditContext from '../test/blocks/EditContext.astro';

const identity = {
  protocol: 1 as const,
  requestId: 'render-1',
  epoch: 'session-1',
  entry: { collection: 'pages', id: 'home' },
  locale: 'en',
  contentVersion: 4,
};

test('editing helpers include the verified document and stable nested address in Canvas', async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(EditContext, {
    locals: { handoverCanvas: identity },
  });

  expect(html).toContain('data-is-canvas="true"');
  expect(html).toContain('data-handover-field=');
  expect(html).toContain('data-handover-list=');
  expect(html).toContain('data-handover-block=');
  expect(html).toContain('&quot;collection&quot;:&quot;pages&quot;');
  expect(html).toContain('&quot;id&quot;:&quot;home&quot;');
  expect(html).toContain('&quot;locale&quot;:&quot;en&quot;');
  expect(html).toContain('&quot;address&quot;:&quot;blocks[_id=hero-1].heading&quot;');
});

test("a block carries the name Handover shows for it: the author's _label, else its type", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(EditContext, {
    locals: { handoverCanvas: identity },
  });

  expect(html).toContain('data-handover-name="Feature Grid"');
  expect(html).toContain('data-handover-name="Walk to the harbour"');
  // A block annotated by id alone has no name to carry; Canvas falls back to its position.
  expect(html.match(/data-handover-name=/g)).toHaveLength(2);
});

test.each([
  ['public SSR', new Request('https://example.com/home')],
  ['build-time prerender', new Request('https://example.com/home')],
])('%s output is inert when no verified Canvas local exists', async (_name, request) => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(EditContext, { request, locals: {} });

  expect(html).toContain('data-is-canvas="false"');
  expect(html).not.toContain('data-handover-field');
});
