import type { Attachment } from 'svelte/attachments';

type Dismiss = {
  open: () => boolean;
  close: () => void;
  /** Escape while open; defaults to `close`. */
  onescape?: (event: KeyboardEvent) => void;
  /** A click on this selector counts as inside; defaults to the attached element. */
  inside?: string;
  /** Members closes before the row's own click handler runs. */
  capture?: boolean;
};

// Listens on window, not the node, so Escape works wherever focus is and tests can dispatch on window.
export function dismiss({
  open,
  close,
  onescape = close,
  inside,
  capture = false,
}: Dismiss): Attachment<HTMLElement> {
  return (node) => {
    const click = (event: MouseEvent) => {
      if (!open()) return;
      const at = event.target;
      const within = inside
        ? at instanceof Element && at.closest(inside)
        : !(at instanceof Node) || node.contains(at);
      if (!within) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open()) onescape(event);
    };
    window.addEventListener('click', click, capture);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('click', click, capture);
      window.removeEventListener('keydown', key);
    };
  };
}
