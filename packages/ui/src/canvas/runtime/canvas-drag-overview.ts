// Keep the viewport and surrounding page fixed while the current block list zooms out.
export function createCanvasDragOverview(owner: Window, element: HTMLElement) {
  const wrapper = element.parentElement;
  if (
    !wrapper ||
    wrapper === element.ownerDocument.body ||
    wrapper === element.ownerDocument.documentElement
  )
    return;
  const properties = ['scale', 'transform-origin'] as const;
  const original = properties.map((name) => ({
    name,
    value: wrapper.style.getPropertyValue(name),
    priority: wrapper.style.getPropertyPriority(name),
  }));
  const height = owner.innerHeight;
  const bounds = wrapper.getBoundingClientRect();
  const pageTop = bounds.top + owner.scrollY;
  const scroll = { x: owner.scrollX, y: owner.scrollY };
  const duration = owner.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240;
  let scale = 1;
  let animation = 0;
  let restoring = false;
  let restored = false;
  wrapper.style.setProperty('transform-origin', `50% ${Math.max(0, -bounds.top)}px`, 'important');

  const cleanup = () => {
    owner.cancelAnimationFrame(animation);
    for (const { name, value, priority } of original) {
      if (value) wrapper.style.setProperty(name, value, priority);
      else wrapper.style.removeProperty(name);
    }
    element.style.removeProperty('--dnd-scale');
    restored = true;
  };
  const animate = (to: number, scrollTo?: number) => {
    owner.cancelAnimationFrame(animation);
    const from = scale;
    const startScroll = owner.scrollY;
    let start: number | undefined;
    const tick = (time: number) => {
      if (start === undefined) {
        start = time;
        // Let the drag preview measure the full-size block before an instant overview scales it.
        if (!duration && !restoring) {
          animation = owner.requestAnimationFrame(tick);
          return;
        }
      }
      const progress = duration ? Math.min(1, (time - start) / duration) : 1;
      const eased = 1 - (1 - progress) ** 3;
      scale = from + (to - from) * eased;
      wrapper.style.setProperty('scale', String(scale), 'important');
      // dnd-kit's top-layer preview escapes its parent's scale; scale it about the grab point.
      if (element.hasAttribute('data-dnd-dragging'))
        element.style.setProperty('--dnd-scale', String(scale));
      if (scrollTo !== undefined)
        owner.scrollTo({
          left: scroll.x,
          top: startScroll + (scrollTo - startScroll) * eased,
          behavior: 'instant',
        });
      if (progress < 1) animation = owner.requestAnimationFrame(tick);
      else if (restoring) cleanup();
    };
    animation = owner.requestAnimationFrame(tick);
  };
  animate(0.65);
  return {
    get restored() {
      return restored;
    },
    restore(canceled: boolean) {
      if (restoring || restored) return;
      restoring = true;
      const bounds = element.getBoundingClientRect();
      const top = Math.max(16, Math.min(bounds.top, height - 80));
      const unscaledTop = pageTop + (bounds.top - wrapper.getBoundingClientRect().top) / scale;
      animate(1, canceled ? scroll.y : Math.max(0, unscaledTop - top));
    },
    dispose() {
      cleanup();
      owner.scrollTo({ left: scroll.x, top: scroll.y, behavior: 'instant' });
    },
  };
}
