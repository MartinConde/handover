import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import CanvasImagePopover from './CanvasImagePopover.svelte';

let app: ReturnType<typeof mount>;

afterEach(() => {
  if (app) unmount(app);
  document.body.innerHTML = '';
});

const anchor = { left: 10, top: 10, width: 20, height: 20 };
const children = createRawSnippet(() => ({ render: () => '<span></span>' }));

function mountPopover(onclose: () => void) {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const frameDocument = frame.contentDocument as Document;
  app = mount(CanvasImagePopover, {
    target: document.body,
    props: { anchor, frame, label: 'Image', onclose, children },
  });
  flushSync();
  return frameDocument;
}

test('stays open when the frame scrolls programmatically, not from user input', () => {
  const onclose = vi.fn();
  const frameDocument = mountPopover(onclose);

  frameDocument.dispatchEvent(new Event('scroll', { bubbles: true }));

  expect(onclose).not.toHaveBeenCalled();
});

test('closes when the user scrolls the frame with the wheel', () => {
  const onclose = vi.fn();
  const frameDocument = mountPopover(onclose);

  frameDocument.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));

  expect(onclose).toHaveBeenCalledOnce();
});
