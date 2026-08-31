import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { expect, test } from 'vitest';
import Embed from './Embed.astro';

const render = (props: unknown) =>
  AstroContainer.create().then((c) => c.renderToString(Embed, { props }));

test('<Embed /> builds a YouTube frame from the template, named by the field title', async () => {
  const html = await render({
    value: { provider: 'youtube', id: 'dQw4w9WgXcQ', title: 'Walkthrough video', start: 42 },
  });

  expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42"');
  expect(html).toContain('title="Walkthrough video"');
  expect(html).toContain('loading="lazy"');
  expect(html).toContain('allowfullscreen');
});

test('<Embed /> asks Vimeo not to track, and starts where the file says', async () => {
  const html = await render({ value: { provider: 'vimeo', id: '76979871', start: 90 } });
  expect(html).toContain('src="https://player.vimeo.com/video/76979871?dnt=1#t=90s"');
});

// The golden's own map id: spaces and a comma reach the template encoded or not at all.
test('<Embed /> encodes a map place into the query it is read from', async () => {
  const html = await render({
    value: { provider: 'google-maps', id: 'Seaview Cottage, Devon' },
  });
  expect(html).toContain(
    'src="https://www.google.com/maps?q=Seaview%20Cottage%2C%20Devon&amp;output=embed"',
  );
});

// The id is the only part of the address that comes from a file, and it is encoded on the way
// in: nothing written into a content file by hand can end the attribute and start another.
test('<Embed /> cannot be talked out of its own attribute', async () => {
  const html = await render({
    value: { provider: 'youtube', id: 'abc" onload="alert(1)', title: 'Tour' },
  });
  expect(html).not.toContain('onload="');
  expect(html).toContain(
    'src="https://www.youtube-nocookie.com/embed/abc%22%20onload%3D%22alert(1)"',
  );
});

// A frame with no name is one a screen reader announces as nothing at all, and a title nobody
// has typed in this language is the ordinary state of a freshly translated entry.
test('<Embed /> falls back to the provider name where this language has no title', async () => {
  const html = await render({ value: { provider: 'vimeo', id: '76979871' } });
  expect(html).toContain('title="Vimeo"');
});

test('<Embed /> draws nothing for a field nobody has filled in', async () => {
  expect(await render({})).not.toContain('iframe');
});
