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

test('editing helpers carry the verified document, nested address and block names in Canvas', async () => {
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
  // A block's name is the author's _label, else its type.
  expect(html).toContain('data-handover-name="Feature Grid"');
  expect(html).toContain('data-handover-name="Walk to the harbour"');
  // A block annotated by id alone has no name to carry; Canvas falls back to its position.
  expect(html.match(/data-handover-name=/g)).toHaveLength(2);
});

test('output is inert when no verified Canvas local exists', async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(EditContext, {
    request: new Request('https://example.com/home'),
    locals: {},
  });

  expect(html).toContain('data-is-canvas="false"');
  expect(html).not.toContain('data-handover-field');
});
