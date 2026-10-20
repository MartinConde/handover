type ResizablePanel = 'structure' | 'inspector';

export const PANEL_WIDTHS = {
  structure: { default: 250, min: 210, max: 420 },
  inspector: { default: 380, min: 320, max: 640 },
} as const;
const PANEL_WIDTH_STORAGE = 'handover.canvas.panel-widths';
const MIN_CANVAS_WIDTH = 360;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

// The Structure and Inspector widths: dragged, stepped by keyboard, remembered, kept off the Canvas.
export function createCanvasPanels({
  workspace,
  narrow,
  structureVisible,
  inspectorOpen,
}: {
  workspace: () => HTMLElement | undefined;
  narrow: () => boolean;
  structureVisible: () => boolean;
  inspectorOpen: () => boolean;
}) {
  let structureWidth = $state<number>(PANEL_WIDTHS.structure.default);
  let inspectorWidth = $state<number>(PANEL_WIDTHS.inspector.default);
  let resizing = $state<{
    panel: ResizablePanel;
    pointerId: number;
    startX: number;
    startWidth: number;
  }>();

  function panelMaximum(panel: ResizablePanel) {
    const available = workspace()?.clientWidth ?? window.innerWidth;
    const other =
      panel === 'structure'
        ? inspectorOpen()
          ? inspectorWidth
          : 0
        : structureVisible()
          ? structureWidth
          : 0;
    return Math.max(
      PANEL_WIDTHS[panel].min,
      Math.min(PANEL_WIDTHS[panel].max, available - other - MIN_CANVAS_WIDTH),
    );
  }

  function setPanelWidth(panel: ResizablePanel, value: number) {
    const width = Math.round(clamp(value, PANEL_WIDTHS[panel].min, panelMaximum(panel)));
    if (panel === 'structure') structureWidth = width;
    else inspectorWidth = width;
  }

  function storePanelWidths() {
    try {
      localStorage.setItem(
        PANEL_WIDTH_STORAGE,
        JSON.stringify({ structure: structureWidth, inspector: inspectorWidth }),
      );
    } catch {
      // Private browsing can disable storage; resizing still works for the current session.
    }
  }

  // A saved wide-screen preference must not squeeze the Canvas out when a smaller desktop opens
  // both panels. Reduce the Inspector first, then Structure, while keeping both usable.
  $effect(() => {
    if (narrow()) return;
    const element = workspace();
    if (!element || !structureVisible() || !inspectorOpen()) return;
    const available = element.clientWidth - MIN_CANVAS_WIDTH;
    if (structureWidth + inspectorWidth <= available) return;
    inspectorWidth = Math.max(
      PANEL_WIDTHS.inspector.min,
      Math.min(inspectorWidth, available - structureWidth),
    );
    structureWidth = Math.max(
      PANEL_WIDTHS.structure.min,
      Math.min(structureWidth, available - inspectorWidth),
    );
  });

  return {
    get structureWidth() {
      return structureWidth;
    },
    get inspectorWidth() {
      return inspectorWidth;
    },
    get resizing() {
      return resizing;
    },
    maximum: panelMaximum,
    restore() {
      try {
        const stored = JSON.parse(localStorage.getItem(PANEL_WIDTH_STORAGE) ?? '{}') as Record<
          string,
          unknown
        >;
        if (typeof stored.structure === 'number') setPanelWidth('structure', stored.structure);
        if (typeof stored.inspector === 'number') setPanelWidth('inspector', stored.inspector);
      } catch {
        // Ignore malformed or unavailable local storage and keep the considered defaults.
      }
    },
    beginResize(panel: ResizablePanel, event: PointerEvent) {
      if (narrow() || event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget as HTMLElement;
      handle.setPointerCapture(event.pointerId);
      resizing = {
        panel,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: panel === 'structure' ? structureWidth : inspectorWidth,
      };
    },
    continueResize(event: PointerEvent) {
      const activeResize = resizing;
      if (!activeResize || activeResize.pointerId !== event.pointerId) return;
      const movement = event.clientX - activeResize.startX;
      setPanelWidth(
        activeResize.panel,
        activeResize.startWidth + (activeResize.panel === 'structure' ? movement : -movement),
      );
    },
    finishResize(event: PointerEvent) {
      if (!resizing || resizing.pointerId !== event.pointerId) return;
      const handle = event.currentTarget as HTMLElement;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      resizing = undefined;
      storePanelWidths();
    },
    resizeWithKeyboard(panel: ResizablePanel, event: KeyboardEvent) {
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        setPanelWidth(panel, event.key === 'Home' ? PANEL_WIDTHS[panel].min : panelMaximum(panel));
        storePanelWidths();
        return;
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const movement = event.key === 'ArrowRight' ? 16 : -16;
      const current = panel === 'structure' ? structureWidth : inspectorWidth;
      setPanelWidth(panel, current + (panel === 'structure' ? movement : -movement));
      storePanelWidths();
    },
    reset(panel: ResizablePanel) {
      setPanelWidth(panel, PANEL_WIDTHS[panel].default);
      storePanelWidths();
    },
  };
}
