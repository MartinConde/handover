import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { expect, test } from 'vitest';
import LocaleSwitcher from './LocaleSwitcher.astro';

const render = (props: unknown) =>
  AstroContainer.create().then((c) => c.renderToString(LocaleSwitcher, { props }));

test('<LocaleSwitcher /> links the other languages and marks the one being read', async () => {
  const html = await render({
    locales: [
      { locale: 'en', url: '/listings/coast' },
      { locale: 'de', url: '/de/listings/coast' },
    ],
    current: 'de',
  });

  expect(html).toContain('<a href="/listings/coast" hreflang="en">EN</a>');
  expect(html).toContain('<span aria-current="true">DE</span>');
  expect(html).not.toContain('href="/de/listings/coast"');
});

// A single button is a worse answer than no switcher: it says nothing and goes nowhere.
test('<LocaleSwitcher /> draws nothing when the entry can be read in one language', async () => {
  const html = await render({ locales: [{ locale: 'en', url: '/coast' }], current: 'en' });
  expect(html.trim()).toBe('');
});
