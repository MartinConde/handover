import { type Drift, type Field, LOCK_TTL } from '@handover/core';
import { type ComponentProps, flushSync, mount, unmount } from 'svelte';
import { afterEach, vi } from 'vitest';
import Editor from './Editor.svelte';

export const entry = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    {
      path: ['seo'],
      label: 'Seo',
      type: 'group',
      required: false,
      fields: [{ path: ['description'], label: 'Description', type: 'text', required: false }],
    },
    { path: ['photos'], label: 'Photos', type: 'unsupported' },
  ] satisfies Field[],
  blocks: {},
  data: { title: 'Seaview Cottage', seo: { description: 'Harbour view' }, photos: [] },
  pending: [] as string[],
  published: ['en'],
  problems: [] as { path: string; message: string }[],
  locales: ['en'],
  defaultLocale: 'en',
  sourceLocale: 'en',
  offered: ['en'],
  translations: {} as Record<string, Record<string, unknown>>,
  stale: [] as string[],
  drift: [] as Drift[],
};

// Two languages: `price` is shared, `notes` is English-only, the German file is the second column.
export const bilingual = {
  ...entry,
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['price'], label: 'Price', type: 'text', required: true, i18n: 'duplicate' },
    { path: ['notes'], label: 'Notes', type: 'text', required: false, i18n: false },
    { path: ['body'], label: 'Body', type: 'blocks', required: true, types: ['hero'] },
  ] satisfies Field[],
  blocks: {
    hero: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }] satisfies Field[],
  },
  data: {
    title: 'Seaview Cottage',
    price: '£1,200 per week',
    notes: 'Saturday changeovers',
    body: [{ _type: 'hero', _id: 'k3nf9a2p', heading: 'Above the harbour' }],
  },
  locales: ['en', 'de'],
  offered: ['en', 'de'],
  translations: {
    de: {
      title: 'Seaview Cottage',
      price: '£1,200 per week',
      body: [{ _type: 'hero', _id: 'k3nf9a2p', heading: 'Über dem Hafen' }],
    },
  },
};

export const state = {} as { app: ReturnType<typeof mount> };
export const show = (over: Partial<ComponentProps<typeof Editor>> = {}) => {
  state.app = mount(Editor, {
    target: document.body,
    props: {
      collection: 'listings',
      slug: 'seaview-cottage',
      entry,
      onchanged: () => {},
      ...over,
    },
  });
  return document.body;
};

export const $ = <T extends Element>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
export const $$ = <T extends Element>(root: ParentNode, sel: string) =>
  Array.from(root.querySelectorAll<T>(sel));

export const type = (root: ParentNode, sel: string, value: string) => {
  const input = $<HTMLInputElement>(root, sel);
  if (!input) throw new Error(`${sel} missing`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};
export const tick = () => new Promise((r) => setTimeout(r, 0));

// Every editor takes the lock on open; any other answer shape reads as somebody else holding it.
export const HELD = { held_by: null, mine: true, expires_at: 1755864120000 };
export const isLock = (url: unknown) => String(url).startsWith('/admin/api/locks/');
/** The checks pass a save that left a draft asks for; it rides on the same fetch as the save. */
export const isLint = (url: unknown) => url === '/admin/api/publish/checks';
/** The writes a test is about, with the lock beats and lint passes filtered out. */
export const wrote = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter((call) => !isLock(call[0]) && !isLint(call[0]));
export const autosaved = () =>
  vi.fn(async (url: string) => {
    if (isLock(url)) return Response.json(HELD);
    if (url.startsWith('/admin/api/drafts/'))
      return Response.json({ updated_at: 1755864000000, pending: true, problems: [] });
    if (isLint(url)) return Response.json({ results: [], readiness: {} });
    throw new Error(`Unexpected editor request: ${url}`);
  });

export const settled = async () => {
  await tick();
  await tick();
  flushSync();
};

// The lock is the entry's, so what it takes away is everything that writes to any of its files.
export const heldBy = (over: Record<string, unknown> = {}) =>
  vi.fn(async (url: string) => {
    if (isLock(url))
      return Response.json({
        held_by: { id: 'u1', name: 'Anna Berg' },
        mine: false,
        expires_at: Date.now() + LOCK_TTL,
        base: {},
        ...over,
      });
    throw new Error(`Unexpected editor request: ${url}`);
  });

export const languagePick = (root: ParentNode) =>
  $<HTMLButtonElement>(root, '.language-pick > button');
export const languageChoices = (root: ParentNode) =>
  $$<HTMLButtonElement>(root, '#entry-languages button');
export const openLanguages = (root: ParentNode) => {
  languagePick(root)?.click();
  flushSync();
};

export const addressed = {
  ...bilingual,
  localizedSlugs: true,
  addresses: { en: '', de: 'ueber-dem-hafen' },
  route: '/listings/[slug]',
};

export const at = (address: string) => history.replaceState({}, '', address);

export const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await tick();
    flushSync();
  }
};

// Hooks register on the file that calls this, so each Editor test file calls it once.
export const useEditorSetup = () => {
  // The tab token lives in session storage, so pinning it makes the request bodies literal.
  sessionStorage.setItem('handover-tab', 'tab-1');
  afterEach(() => {
    try {
      if (state.app) unmount(state.app);
    } finally {
      localStorage.clear();
      document.body.innerHTML = '';
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  afterEach(() => at('/admin/c/listings/seaview-cottage'));
};
