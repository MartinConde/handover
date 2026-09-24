<script lang="ts">
import { onMount, type Snippet, tick } from 'svelte';
import type { CanvasAnchor } from './canvas-bridge';

let {
  anchor,
  frame,
  label,
  onclose,
  children,
}: {
  anchor: CanvasAnchor;
  frame?: HTMLIFrameElement;
  label: string;
  onclose: () => void;
  children: Snippet;
} = $props();

let panel = $state<HTMLDivElement>();

function position() {
  if (!panel || !frame) return;
  const bounds = frame.getBoundingClientRect();
  const scale = bounds.width / (frame.clientWidth || bounds.width || 1);
  const left = bounds.left + anchor.left * scale;
  const top = bounds.top + anchor.top * scale;
  const right = left + anchor.width * scale;
  const bottom = top + anchor.height * scale;
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const gap = 12;
  const besideRight = right + gap + width <= window.innerWidth - gap;
  const besideLeft = left - gap - width >= gap;
  const x = besideRight ? right + gap : besideLeft ? left - gap - width : left;
  const y =
    besideRight || besideLeft
      ? top
      : bottom + gap + height <= window.innerHeight - gap
        ? bottom + gap
        : top;
  panel.style.left = `${Math.max(gap, Math.min(x, window.innerWidth - width - gap))}px`;
  panel.style.top = `${Math.max(gap, Math.min(y, window.innerHeight - height - gap))}px`;
}

function modalOpen() {
  return !!document.querySelector('dialog[open]');
}

function outside(event: PointerEvent) {
  if (modalOpen() || event.composedPath().includes(panel as EventTarget)) return;
  onclose();
}

function closeOnEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || modalOpen()) return;
  event.preventDefault();
  event.stopPropagation();
  onclose();
  frame?.focus({ preventScroll: true });
}

onMount(() => {
  panel?.showPopover?.();
  position();
  panel?.focus({ preventScroll: true });
  const resize = new ResizeObserver(position);
  if (panel) resize.observe(panel);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', closeOnEscape);
  window.addEventListener('resize', position);
  return () => {
    resize.disconnect();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', closeOnEscape);
    window.removeEventListener('resize', position);
  };
});

$effect(() => {
  anchor;
  const child = frame?.contentDocument;
  void tick().then(position);
  // restoreView scrolls the frame after every re-render; only a user-driven scroll should close.
  const userScroll = () => {
    if (!modalOpen()) onclose();
  };
  const scrollKeys = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);
  const userScrollKey = (event: KeyboardEvent) => {
    if (scrollKeys.has(event.key)) userScroll();
  };
  child?.addEventListener('pointerdown', outside, true);
  child?.addEventListener('wheel', userScroll, true);
  child?.addEventListener('touchmove', userScroll, true);
  child?.addEventListener('keydown', userScrollKey, true);
  return () => {
    child?.removeEventListener('pointerdown', outside, true);
    child?.removeEventListener('wheel', userScroll, true);
    child?.removeEventListener('touchmove', userScroll, true);
    child?.removeEventListener('keydown', userScrollKey, true);
  };
});
</script>

<div
  bind:this={panel}
  class="canvas-image-popover"
  popover="manual"
  role="dialog"
  aria-modal="false"
  aria-label={label}
  tabindex="-1"
>
  {@render children()}
</div>
