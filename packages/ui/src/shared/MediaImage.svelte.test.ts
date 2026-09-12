import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';
import MediaImage from './MediaImage.svelte';

let app: ReturnType<typeof mount>;
afterEach(() => unmount(app));

test('an absent image is described without requesting an empty URL', () => {
  app = mount(MediaImage, { target: document.body, props: {} });
  flushSync();
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
    'No image selected',
  );
});

test('a failed image becomes a readable fallback', () => {
  app = mount(MediaImage, {
    target: document.body,
    props: { src: '/media/missing.webp', alt: 'Front of the house' },
  });
  flushSync();
  expect(document.querySelector('img')?.alt).toBe('Front of the house');
  document.querySelector('img')?.dispatchEvent(new Event('error'));
  flushSync();
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('[role="img"]')?.textContent).toContain('Image unavailable');
});
