import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Preview from './Preview.svelte';

// Testing: what the pane shows instead of a page — a build with no route, and a draft the schema
// still refuses with the way back to the field — the two facts that are the admin's and not the
// site's (never published, not saved), which address it frames, and what makes it ask for the
// page again. Not testing: the device buttons or the status wording, chrome over one class.

const chosen = vi.fn();
const went = vi.fn();
let app: ReturnType<typeof mount>;
let props = $state({
  url: '/listings/seaview-cottage',
  locale: 'en',
  locales: [
    { locale: 'en', label: 'English', url: '/listings/seaview-cottage' },
    { locale: 'de', label: 'German', url: '/de/listings/strandhaus-nord' },
  ],
  onlocale: chosen,
  enabled: true,
  published: true,
  stale: false,
  problems: [] as { path: string; label: string; message: string }[],
  ongo: went,
  savedAt: 1755864000000,
});
const show = (over: Partial<typeof props> = {}) => {
  Object.assign(props, over);
  app = mount(Preview, { target: document.body, props });
  flushSync();
  return document.body;
};
afterEach(() => {
  unmount(app);
  Object.assign(props, {
    url: '/listings/seaview-cottage',
    locale: 'en',
    enabled: true,
    published: true,
    stale: false,
    problems: [],
    savedAt: 1755864000000,
  });
  chosen.mockClear();
  went.mockClear();
});

const q = <T extends Element>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const all = (root: ParentNode, sel: string) => Array.from(root.querySelectorAll(sel));
const src = (root: ParentNode) => q<HTMLIFrameElement>(root, 'iframe')?.getAttribute('src');

test('the frame is the page as the site serves it, in the language on screen', () => {
  const root = show({ locale: 'de', url: '/de/listings/strandhaus-nord' });

  expect(src(root)).toBe('/_preview/de/listings/strandhaus-nord?at=1755864000000');
  // Opening it elsewhere is the address itself, with nothing this pane added to it.
  expect(q(root, '.preview-acts a')?.getAttribute('href')).toBe(
    '/_preview/de/listings/strandhaus-nord',
  );
});

test('a settled save asks the site for the page again', () => {
  const root = show();
  const before = src(root);

  props.savedAt = 1755864999000;
  flushSync();

  expect(src(root)).not.toBe(before);
});

test('Refresh asks for the same address again', () => {
  const root = show();
  const before = src(root);

  q<HTMLButtonElement>(root, '.preview-acts button')?.click();
  flushSync();

  expect(src(root)).not.toBe(before);
});

test('a build with no preview route says whose job turning it on is', () => {
  const root = show({ enabled: false });

  expect(q(root, 'iframe')).toBe(null);
  expect(q(root, '.preview-error.is-quiet')?.textContent).toContain('PREVIEW_ENABLED');
});

// A page cannot be built around a hole, so the card stands where the frame would be — and the
// way back to the field is the point of naming it.
test('a draft the schema still refuses is a card naming each field, not half a page', () => {
  const root = show({
    problems: [
      { path: 'price', label: 'Price', message: 'must be a number' },
      { path: 'title', label: 'Title', message: 'Required' },
    ],
  });

  expect(q(root, 'iframe')).toBe(null);
  expect(
    all(root, '.preview-error p').map((p) => p.textContent?.replace(/\s+/g, ' ').trim()),
  ).toEqual(['Price — must be a number', 'Title — Required']);
  const line = q(root, '.preview-status');
  expect(line?.textContent?.trim()).toBe('Not updated — 2 problems');
  // Nothing is being rendered, so the line is a warning and not the busy one.
  expect(line?.className).toContain('is-warn');
  expect(line?.className).not.toContain('is-busy');
  q<HTMLButtonElement>(root, '.preview-error .actions .btn')?.click();
  expect(went).toHaveBeenCalledWith('price');
});

test('a page the live site has never had says so, and names the address it will get', () => {
  const root = show({ published: false });

  expect(q(root, '.preview-banner')?.textContent).toContain('Not published yet');
  expect(q(root, '.preview-banner code')?.textContent).toBe('/listings/seaview-cottage');
  expect(q(root, 'iframe')).not.toBe(null);
});

test('a published page carries no banner', () => {
  expect(q(show(), '.preview-banner')).toBe(null);
});

// What is rendered is the stored draft, so a save that did not land is a page behind the form.
test('an edit that did not save says the render is the last version that did', () => {
  const root = show({ stale: true });

  expect(q(root, '.preview-banner.is-stale')).not.toBe(null);
});

test('choosing another language hands the choice back rather than moving the frame alone', () => {
  const root = show();

  (all(root, '.seg[aria-label="Language"] button')[1] as HTMLButtonElement).click();

  expect(chosen).toHaveBeenCalledWith('de');
});
