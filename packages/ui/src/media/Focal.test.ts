import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Focal from './Focal.svelte';

const q = <T extends Element>(selector: string) => {
  const element = document.body.querySelector<T>(selector);
  if (!element) throw new Error(`${selector} missing`);
  return element;
};

let app: ReturnType<typeof mount>;
afterEach(() => {
  unmount(app);
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const open = (onsave = vi.fn()) => {
  app = mount(Focal, {
    target: document.body,
    props: {
      name: 'Harbour',
      url: 'https://cdn.example.com/harbour.jpg',
      focal: [0.5, 0.5],
      onsave,
      onclose: vi.fn(),
    },
  });
  flushSync();
  return onsave;
};

test('a portrait picture places the dot and reads the pointer inside the picture, not the 3:2 stage', () => {
  const onsave = open();
  const img = q<HTMLImageElement>('.focal-stage img');
  // 800x1600 contained in a 3:2 stage fills a centred column one third of the stage wide.
  Object.defineProperty(img, 'naturalWidth', { value: 800 });
  Object.defineProperty(img, 'naturalHeight', { value: 1600 });
  img.dispatchEvent(new Event('load'));
  flushSync();

  const frame = q<HTMLElement>('.focal-frame');
  expect(parseFloat(frame.style.left)).toBeCloseTo(100 / 3);
  expect(parseFloat(frame.style.width)).toBeCloseTo(100 / 3);
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 200, y: 0, width: 200, height: 400 }),
  );
  q<HTMLElement>('.focal-stage').dispatchEvent(
    new PointerEvent('pointermove', { bubbles: true, clientX: 200, clientY: 100, buttons: 1 }),
  );
  flushSync();

  expect(frame.contains(q('.focal-handle'))).toBe(true);
  q<HTMLButtonElement>('.btn-primary').click();
  expect(onsave).toHaveBeenCalledWith([0, 0.25]);
});

test('labelled sliders move the dot without the pointer handle', () => {
  open();
  const [across, down] = Array.from(
    document.querySelectorAll<HTMLInputElement>('.focal-axes input'),
  );
  expect(across?.closest('label')?.textContent?.trim()).toBe('Across');
  if (!across || !down) throw new Error('sliders missing');
  across.value = '20';
  across.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();

  expect(q<HTMLButtonElement>('.focal-handle').style.left).toBe('20%');
  expect(down.value).toBe('50');
});
