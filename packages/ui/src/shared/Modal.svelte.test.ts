import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';
import ModalFixture from './Modal.fixture.svelte';

let app: ReturnType<typeof mount>;
afterEach(() => unmount(app));

function must<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`no element matches ${selector}`);
  return found;
}

function clickOverlay(element: Element) {
  element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();
}

test.each(['dialog', 'sheet'])(
  'clicking outside a %s closes it and returns focus',
  (panelClass) => {
    app = mount(ModalFixture, { target: document.body, props: { panelClass } });
    flushSync();
    const opener = must<HTMLButtonElement>('button');
    opener.focus();
    opener.click();
    flushSync();

    clickOverlay(must('.modal-scrim'));

    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  },
);

test('a busy modal keeps its boundary when its overlay is clicked', () => {
  app = mount(ModalFixture, { target: document.body, props: { dismissible: false } });
  flushSync();
  must<HTMLButtonElement>('button').click();
  flushSync();

  clickOverlay(must('.modal-scrim'));

  expect(document.querySelector('dialog')?.getAttribute('aria-labelledby')).toBe('modal-title');
});

test('a pointer gesture starting inside the panel does not dismiss it outside', () => {
  app = mount(ModalFixture, { target: document.body });
  flushSync();
  must<HTMLButtonElement>('button').click();
  flushSync();

  must('h2').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  must('.modal-scrim').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();

  expect(document.querySelector('dialog')?.getAttribute('aria-labelledby')).toBe('modal-title');
});

test('overlay dismissal acts only on the topmost modal', () => {
  app = mount(ModalFixture, { target: document.body });
  flushSync();
  must<HTMLButtonElement>('button').click();
  flushSync();
  must<HTMLButtonElement>('dialog button').click();
  flushSync();
  const [first, second] = Array.from(document.querySelectorAll('.modal-scrim'));
  if (!first || !second) throw new Error('expected two overlays');

  clickOverlay(first);
  expect(document.querySelectorAll('dialog')).toHaveLength(2);
  clickOverlay(second);

  expect(document.querySelectorAll('dialog')).toHaveLength(1);
  expect(document.querySelector('dialog')?.getAttribute('aria-labelledby')).toBe('modal-title');
});
