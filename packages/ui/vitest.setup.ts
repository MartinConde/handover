import { afterEach } from 'vitest';
import { invalidateEntryDirectory } from './src/entry-directory';

// dnd-kit reaches for these as it loads and as a drag starts; jsdom has none of them.
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = Observer;
globalThis.IntersectionObserver = Observer as unknown as typeof IntersectionObserver;
document.getAnimations = () => [];
Element.prototype.scrollIntoView = () => {};
Element.prototype.getAnimations = () => [];
window.matchMedia = () =>
  ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as MediaQueryList;
Element.prototype.animate = () =>
  ({
    finished: Promise.resolve(),
    onfinish: null,
    cancel() {},
    finish() {},
  }) as unknown as Animation;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
document.elementFromPoint = () => null;
HTMLFormElement.prototype.submit = () => {};

// The real catalogue cache lives for the authenticated app. Tests replace fetch between cases.
afterEach(() => invalidateEntryDirectory());
