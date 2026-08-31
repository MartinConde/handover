import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Globals from './Globals.svelte';

// Testing: one card per declared global, in the order the API returned, with the pending dot
// and a dashed chip for a language it has no file in.
// Not testing: the card's styling, or the sidebar link that routes here.

const GLOBALS = [
  {
    key: 'site',
    label: 'Site details',
    description: 'Contact details and footer text',
    locales: ['en', 'de'],
    pending: true,
  },
  { key: 'cta-newsletter', label: 'Newsletter call-to-action', locales: ['en'], pending: false },
];

let app: ReturnType<typeof mount>;
const show = (globals: unknown[] = GLOBALS, locales = ['en', 'de']) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ globals, locales })),
  );
  app = mount(Globals, { target: document.body });
  flushSync();
  return document.body;
};
afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
});

const all = (root: ParentNode, sel: string) => Array.from(root.querySelectorAll(sel));
// The list arrives after the fetch settles, which is two turns after the mount.
const loaded = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

test('one card per global, named and described by the schema', async () => {
  const root = show();
  await loaded();

  // Redirects is last and is not a global: every site has one, so the card is drawn whatever
  // the developer declared.
  expect(all(root, '.global-card h2 a').map((a) => a.textContent)).toEqual([
    'Site details',
    'Newsletter call-to-action',
    'Redirects',
  ]);
  expect(all(root, '.global-card h2 a').map((a) => a.getAttribute('href'))).toEqual([
    '/admin/site/site',
    '/admin/site/cta-newsletter',
    '/admin/site/redirects',
  ]);
  expect(all(root, '.global-card > p').map((p) => p.textContent)).toEqual([
    'Contact details and footer text',
    'Old addresses that forward to new ones',
  ]);
});

test('a language with no file yet is the dashed chip, and an unpublished change is the dot', async () => {
  const root = show();
  await loaded();

  const [site, cta] = all(root, '.global-card');
  expect(site?.querySelector('.pdot')).not.toBeNull();
  expect(all(site as ParentNode, '.chip-missing')).toEqual([]);
  expect(cta?.querySelector('.pdot')).toBeNull();
  expect(all(cta as ParentNode, '.chip-missing').map((c) => c.textContent)).toEqual(['DE']);
});

test('a site with one language draws no chips at all', async () => {
  const root = show(GLOBALS, ['en']);
  await loaded();

  expect(all(root, '.chip')).toEqual([]);
});

test('a global somebody has open carries their name on the card', async () => {
  const root = show([{ ...GLOBALS[0], editing: { id: 'u2', name: 'Anna Berg' } }, GLOBALS[1]]);
  await loaded();

  const [site, cta] = all(root, '.global-card');
  expect(site?.querySelector('.badge')?.textContent).toBe('Being edited by Anna Berg');
  expect(cta?.querySelector('.badge')).toBeNull();
});

// Who last touched it, which the card had no line for until the dashboard gave every screen the
// same one. A publish names the person who published rather than the person who typed it.
test('a card says who last edited it, and a card nobody has touched says nothing', async () => {
  const root = show([
    {
      ...GLOBALS[0],
      edited: { at: Date.now() - 2 * 60 * 60 * 1000, by: 'Anna Berg', kind: 'edit' },
    },
    { ...GLOBALS[1], edited: null },
  ]);
  await loaded();

  const [site, cta] = all(root, '.global-card');
  expect(site?.querySelector('.sub')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Edited by Anna Berg 2h ago',
  );
  expect(cta?.querySelector('.sub')).toBeNull();
});
