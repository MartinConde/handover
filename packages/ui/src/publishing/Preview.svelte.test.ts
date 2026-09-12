import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Preview from './Preview.svelte';

// Testing: what the pane shows instead of a page, and the exact render result it trusts.

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
  hidden: false,
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
  vi.useRealTimers();
  Object.assign(props, {
    url: '/listings/seaview-cottage',
    locale: 'en',
    enabled: true,
    published: true,
    hidden: false,
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
const result = (
  root: ParentNode,
  status: 'success' | 'error',
  overrides: { url?: string; version?: string; code?: string } = {},
) => {
  const frame = q<HTMLIFrameElement>(root, 'iframe');
  if (!frame) throw new Error('no preview frame');
  const marker = document.createElement('i');
  marker.dataset.handoverPreviewResult = status;
  marker.dataset.handoverPreviewUrl = overrides.url ?? '/_preview/listings/seaview-cottage';
  marker.dataset.handoverPreviewVersion = overrides.version ?? '1755864000000';
  if (overrides.code) marker.dataset.handoverPreviewCode = overrides.code;
  Object.defineProperty(frame, 'contentDocument', {
    configurable: true,
    value: { querySelector: () => marker },
  });
  frame.dispatchEvent(new Event('load'));
  flushSync();
};

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

test('only a success signal for the requested URL and saved version marks the preview updated', () => {
  const root = show();

  result(root, 'success', { version: '1755863999999' });
  expect(q(root, '.preview-status')?.textContent?.trim()).toBe('Updating…');

  result(root, 'success', { url: '/_preview/listings/another-cottage' });
  expect(q(root, '.preview-status')?.textContent?.trim()).toBe('Updating…');

  result(root, 'success');
  expect(q(root, '.preview-status')?.textContent?.trim()).toBe('Updated 0 seconds ago');
});

test('an iframe load without a successful preview result is reported as failed', () => {
  const root = show();
  const frame = q<HTMLIFrameElement>(root, 'iframe');
  if (!frame) throw new Error('no preview frame');
  Object.defineProperty(frame, 'contentDocument', {
    configurable: true,
    value: { querySelector: () => null },
  });

  frame.dispatchEvent(new Event('load'));
  flushSync();

  expect(q(root, '.preview-status')?.textContent?.trim()).toBe('Preview could not be updated');
  expect(q(root, '.preview-error')?.textContent).toContain('Try again');
});

test('a render that never finishes times out and can be retried', async () => {
  vi.useFakeTimers();
  const root = show();

  await vi.advanceTimersByTimeAsync(15_000);
  flushSync();

  expect(q(root, '.preview-status')?.textContent?.trim()).toBe('Preview took too long');
  expect(q(root, '.preview-error')?.textContent).toContain('Try again');
  q<HTMLButtonElement>(root, '.preview-error button')?.click();
  flushSync();
  expect(q(root, 'iframe')).not.toBeNull();
  expect(q(root, '.preview-status')?.textContent?.trim()).toBe('Updating…');
});

test('an unauthorized result for the current render offers to restore the expired session', () => {
  const root = show();

  result(root, 'error', { code: '401', version: '1755863999999' });
  expect(q(root, '.preview-status')?.textContent?.trim()).toBe('Updating…');

  result(root, 'error', { code: '401' });

  expect(q(root, '.preview-status')?.textContent?.trim()).toBe('Preview stopped — sign in again');
  expect(q(root, '.preview-error')?.textContent).toContain('Your sign-in expired');
  expect(q(root, '.preview-error button')?.textContent).toContain('Reload admin');
});

test('a build with no preview route says whose job turning it on is', () => {
  const root = show({ enabled: false });

  expect(q(root, 'iframe')).toBe(null);
  expect(q(root, '.preview-error.is-quiet')?.textContent).toContain('PREVIEW_ENABLED');
});

// A page cannot be built around a hole, so the card stands where the frame would be.
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

// A hidden page is the one most worth looking at before it goes back on.
test('a hidden entry still renders, under a banner saying it is off the live site', () => {
  const root = show({ hidden: true });

  expect(q(root, '.preview-banner.is-hidden')?.textContent).toContain(
    'Hidden — not on the live site',
  );
  expect(q(root, 'iframe')).not.toBe(null);
});
