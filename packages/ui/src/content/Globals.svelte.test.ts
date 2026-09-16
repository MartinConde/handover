import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import type { UiLocale } from '../i18n.js';
import Globals from './Globals.svelte';

// Testing: one card per declared global, in the order the API returned.

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
const props = $state({ uiLocale: 'en' as UiLocale });
const show = (globals: unknown[] = GLOBALS, locales = ['en', 'de'], uiLocale: UiLocale = 'en') => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ globals, locales })),
  );
  props.uiLocale = uiLocale;
  app = mount(Globals, { target: document.body, props });
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

  // Redirects is last and is not a global.
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

test('a global labelled per language is named in the interface language', async () => {
  const root = show(
    [{ ...GLOBALS[0], labels: { en: 'Site details', de: 'Website-Angaben' } }],
    ['en', 'de'],
    'de',
  );
  await loaded();

  expect(all(root, '.global-card h2 a')[0]?.textContent).toBe('Website-Angaben');
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

// The card identifies its last editor.
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
    'Edited by Anna Berg 2 hr ago',
  );
  expect(cta?.querySelector('.sub')).toBeNull();
});

test('a live interface switch retranslates the list without rereading or replacing its cards', async () => {
  const root = show([
    {
      ...GLOBALS[0],
      editing: { id: 'u2', name: null },
      edited: { at: Date.now() - 2 * 60 * 60 * 1000, by: 'Anna Berg', kind: 'edit' },
    },
  ]);
  await loaded();
  const card = root.querySelector('.global-card');
  const requests = vi.mocked(fetch).mock.calls.length;

  flushSync(() => {
    props.uiLocale = 'de';
  });

  expect(root.querySelector('h1')?.textContent).toBe('Website-Einstellungen');
  expect(root.querySelector('.global-card')).toBe(card);
  expect(root.querySelector('.badge')?.textContent).toBe('Wird von jemandem bearbeitet');
  expect(root.querySelector('.sub')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Bearbeitet von Anna Berg vor 2 Std.',
  );
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(requests);
});

test('a visible list failure retranslates without another request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('unavailable', { status: 503 })),
  );
  props.uiLocale = 'en';
  app = mount(Globals, { target: document.body, props });
  await loaded();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    'Could not load the list (503)',
  );

  flushSync(() => {
    props.uiLocale = 'de';
  });
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    'Die Liste konnte nicht geladen werden (503)',
  );
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});
