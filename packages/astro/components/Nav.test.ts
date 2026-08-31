import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { expect, test } from 'vitest';
import Nav from './Nav.astro';

const render = (props: unknown) =>
  AstroContainer.create().then((c) => c.renderToString(Nav, { props }));

const menus = {
  header: [
    { label: 'Home', href: '/', children: [] },
    {
      label: 'Listings',
      href: '/listings',
      children: [
        { label: 'For sale', href: '/listings?status=sale', children: [] },
        { label: 'Brochure', href: 'https://example.com/pdf', newTab: true, children: [] },
      ],
    },
  ],
  footer: [],
};

test('<Nav /> draws the menu it is asked for, nested, and marks the page being read', async () => {
  const html = await render({ menu: 'header', menus, current: '/listings' });

  expect(html).toContain('<nav aria-label="Main">');
  expect(html).toContain('<a href="/">Home</a>');
  expect(html).toContain('<a href="/listings" aria-current="page">Listings</a>');
  // The children are a list inside their parent's item, not a second menu beside it.
  expect(html).toContain('<a href="/listings" aria-current="page">Listings</a><ul>');
  expect(html.match(/<nav/g)).toHaveLength(1);
});

// The site links `/listings/` and the menu stores `/listings`: one page, one mark.
test('<Nav /> marks the page being read whichever way its address ends', async () => {
  const html = await render({ menu: 'header', menus, current: '/listings/' });
  expect(html).toContain('<a href="/listings" aria-current="page">Listings</a>');
});

test('<Nav /> opens an item marked for a new tab in one, and lets nothing back through', async () => {
  const html = await render({ menu: 'header', menus, current: '/' });

  expect(html).toContain(
    '<a href="https://example.com/pdf" target="_blank" rel="noopener noreferrer">Brochure</a>',
  );
  expect(html).not.toContain('target="_blank" rel="noopener noreferrer">Home');
});

// An empty menu, and a site whose global has no menu by that name at all: both are nothing to
// render rather than an empty landmark a screen reader still announces.
test('<Nav /> draws nothing for a menu with no items in this language', async () => {
  expect((await render({ menu: 'footer', menus })).trim()).toBe('');
  expect((await render({ menu: 'legal', menus })).trim()).toBe('');
});
