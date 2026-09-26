import { messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import {
  CANVAS_PROTOCOL,
  type CanvasBridgeRejection,
  type CanvasCommandMessage,
  type CanvasCommandResult,
  type CanvasDocumentIdentity,
  type CanvasEditingState,
  type CanvasInteractionMode,
  type CanvasNavigationMessage,
  type CanvasParentBridgeOptions,
  type CanvasSelection,
  type CanvasStructureNode,
  type CanvasSuccessManifest,
  type CanvasTarget,
  type CanvasTextField,
  createCanvasParentBridge,
  readCanvasResultManifest,
} from './canvas-bridge';
import { sameCanvasDocument, sameCanvasSelection, sameCanvasTarget } from './canvas-target';

export interface CanvasRenderSnapshot {
  mode: 'canvas';
  protocol: typeof CANVAS_PROTOCOL;
  epoch: string;
  entry: CanvasDocumentIdentity;
  locale: string;
  contentVersion: number;
  snapshots: Record<string, Record<string, unknown>>;
}

export interface CanvasRenderRequest {
  /** The ordinary preview address. The snapshot is delivered to it as a native form POST. */
  url: string;
  snapshot: CanvasRenderSnapshot;
}

export type CanvasRenderRequestFactory = () => CanvasRenderRequest;

export interface CanvasInteractionState {
  inlineEditing: boolean;
  composing: boolean;
  dragging: boolean;
}

export type CanvasRenderFailure =
  | 'bootstrap'
  | 'disposed'
  | 'render'
  | 'stale'
  | 'superseded'
  | 'timeout';

export type CanvasRenderResult =
  | { ok: true; requestId: string; contentVersion: number }
  | {
      ok: false;
      requestId: string;
      reason: CanvasRenderFailure;
      status?: number;
      message?: string;
    };

export type CanvasRendererState =
  | { phase: 'idle' }
  | { phase: 'rendering'; requestId: string; contentVersion: number }
  | { phase: 'ready'; requestId: string; contentVersion: number }
  | {
      phase: 'failed';
      requestId: string;
      contentVersion: number;
      reason: Exclude<CanvasRenderFailure, 'disposed' | 'superseded'>;
      status?: number;
      message?: string;
    }
  | { phase: 'disposed' };

export interface CanvasRendererOptions {
  stage: HTMLElement;
  contentVersion: () => number;
  currentTarget: () => CanvasTarget | undefined;
  uiLocale: () => UiLocale;
  currentSelection?: () => CanvasSelection | undefined;
  onCommand: (message: CanvasCommandMessage) => CanvasCommandResult | Promise<CanvasCommandResult>;
  commandRecovery?: CanvasParentBridgeOptions['commandRecovery'];
  onSelectionChange?: (selection: CanvasSelection | undefined, reason?: 'restore') => void;
  onStructureChange?: (nodes: CanvasStructureNode[]) => void;
  onAction?: CanvasParentBridgeOptions['onAction'];
  onNavigate?: (message: CanvasNavigationMessage) => void;
  onInteractionChange?: (state: CanvasEditingState) => void;
  onStateChange?: (state: CanvasRendererState) => void;
  onBridgeRejected?: (reason: CanvasBridgeRejection, message: unknown) => void;
  timeoutMs?: number;
  /** Quiet period used to coalesce continuous edits into one fresh render. */
  renderDelayMs?: number;
  requestId?: () => string;
}

interface RenderFrame {
  frame: HTMLIFrameElement;
  manifest: CanvasSuccessManifest;
  bridge: ReturnType<typeof createCanvasParentBridge>;
  loaded: boolean;
  ready: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  onload: () => void;
  onerror: () => void;
  // A reload or navigation of the live frame loses any in-flight editing stop.
  onActiveLoad?: () => void;
  resolve: (result: CanvasRenderResult) => void;
  selection?: CanvasSelection;
  structure: CanvasStructureNode[];
}

interface PendingRender {
  request: CanvasRenderRequestFactory;
  requestId: string;
  timer: ReturnType<typeof setTimeout>;
  waiters: {
    resolve: (result: CanvasRenderResult) => void;
    reject: (reason: unknown) => void;
  }[];
}

interface CanvasViewState {
  left: number;
  top: number;
  maximumLeft: number;
  maximumTop: number;
  anchor?: { target: CanvasTarget; left: number; top: number };
}

const sameManifest = (a: CanvasSuccessManifest, b: CanvasSuccessManifest) =>
  a.protocol === b.protocol &&
  a.requestId === b.requestId &&
  a.epoch === b.epoch &&
  sameCanvasDocument(a.entry, b.entry) &&
  a.locale === b.locale &&
  a.contentVersion === b.contentVersion;

const randomId = () => crypto.randomUUID();
const markerSelector = '[data-handover-field], [data-handover-list], [data-handover-block]';
const EDITING_MARKERS =
  '[data-handover-inline-editing],[data-handover-richtext-editing],[data-handover-link-editing]';

const frameTitle = (locale: UiLocale) => m.preview_frame_title({}, messageOptions(locale));

const findTarget = (root: Document, expected: CanvasTarget): Element | undefined => {
  for (const element of Array.from(root.querySelectorAll(markerSelector))) {
    for (const attribute of ['data-handover-field', 'data-handover-list', 'data-handover-block']) {
      const serialized = element.getAttribute(attribute);
      if (!serialized) continue;
      try {
        if (sameCanvasTarget(JSON.parse(serialized) as CanvasTarget, expected)) return element;
      } catch {
        // A site-owned malformed annotation is not a usable restoration anchor.
      }
    }
  }
};

const captureView = (held: RenderFrame, target: CanvasTarget | undefined): CanvasViewState => {
  const view = held.frame.contentWindow;
  const document = held.frame.contentDocument;
  if (!view || !document) return { left: 0, top: 0, maximumLeft: 0, maximumTop: 0 };
  const scrolling = document.scrollingElement;
  const state: CanvasViewState = {
    left: view.scrollX,
    top: view.scrollY,
    maximumLeft: Math.max(0, (scrolling?.scrollWidth ?? 0) - view.innerWidth),
    maximumTop: Math.max(0, (scrolling?.scrollHeight ?? 0) - view.innerHeight),
  };
  const element = target && findTarget(document, target);
  if (element) {
    const bounds = element.getBoundingClientRect();
    state.anchor = { target, left: bounds.left, top: bounds.top };
  }
  return state;
};

const clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, value));

const restoreView = (held: RenderFrame, state: CanvasViewState | undefined) => {
  if (!state) return;
  const view = held.frame.contentWindow;
  const document = held.frame.contentDocument;
  if (!view || !document) return;
  const scrolling = document.scrollingElement;
  const maximumLeft = Math.max(0, (scrolling?.scrollWidth ?? 0) - view.innerWidth);
  const maximumTop = Math.max(0, (scrolling?.scrollHeight ?? 0) - view.innerHeight);
  let left = state.maximumLeft ? (state.left / state.maximumLeft) * maximumLeft : state.left;
  let top = state.maximumTop ? (state.top / state.maximumTop) * maximumTop : state.top;
  const anchor = state.anchor && findTarget(document, state.anchor.target);
  if (anchor && state.anchor) {
    const bounds = anchor.getBoundingClientRect();
    left = view.scrollX + bounds.left - state.anchor.left;
    top = view.scrollY + bounds.top - state.anchor.top;
  }
  view.scrollTo({
    left: clamp(left, maximumLeft),
    top: clamp(top, maximumTop),
    behavior: 'instant',
  });
};

const editorOpen = (frame: HTMLIFrameElement) => {
  try {
    const page = frame.contentDocument;
    return !page || page.querySelector(EDITING_MARKERS) !== null;
  } catch {
    return true;
  }
};

/**
 * Owns full-document Canvas replacement. Each attempt gets a new browsing context; the current
 * document remains live until the candidate has both loaded and completed the exact bridge
 * handshake.
 */
export function createCanvasRenderer(options: CanvasRendererOptions) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const renderDelayMs = options.renderDelayMs ?? 200;

  let state: CanvasRendererState = { phase: 'idle' };
  let active: RenderFrame | undefined;
  let candidate: RenderFrame | undefined;
  let pending: PendingRender | undefined;
  let disposed = false;
  let interaction: CanvasInteractionState = {
    inlineEditing: false,
    composing: false,
    dragging: false,
  };
  let mode: CanvasInteractionMode = 'edit';
  let problemAddresses: string[] = [];
  let lostStop = false;
  const setInteractionState = (next: Partial<CanvasInteractionState>) => {
    interaction = { ...interaction, ...next };
    if (candidate) settle(candidate);
  };

  const update = (next: CanvasRendererState) => {
    state = next;
    options.onStateChange?.(next);
  };

  const detach = (held: RenderFrame) => {
    clearTimeout(held.timer);
    held.frame.removeEventListener('load', held.onload);
    held.frame.removeEventListener('error', held.onerror);
  };

  const remove = (held: RenderFrame) => {
    detach(held);
    if (held.onActiveLoad) held.frame.removeEventListener('load', held.onActiveLoad);
    held.bridge.dispose();
    held.frame.remove();
  };

  const finishFailure = (
    held: RenderFrame,
    reason: CanvasRenderFailure,
    detail: { status?: number; message?: string } = {},
    announce = pending === undefined,
  ) => {
    if (held.settled) return;
    held.settled = true;
    if (candidate === held) candidate = undefined;
    remove(held);
    const result: CanvasRenderResult = {
      ok: false,
      requestId: held.manifest.requestId,
      reason,
      ...detail,
    };
    if (announce && reason !== 'superseded' && reason !== 'disposed')
      update({
        phase: 'failed',
        requestId: held.manifest.requestId,
        contentVersion: held.manifest.contentVersion,
        reason,
        ...detail,
      });
    held.resolve(result);
  };

  const promote = (held: RenderFrame) => {
    if (disposed || candidate !== held || held.settled || !held.loaded || !held.ready) return;
    clearTimeout(held.timer);
    if (options.contentVersion() !== held.manifest.contentVersion)
      return finishFailure(held, 'stale');
    // A stop can be lost; an editor that still runs leaves its marker in the page. No callback
    // here: the workspace would re-enter and supersede this candidate mid-promote.
    if (interaction.inlineEditing && active && !editorOpen(active.frame)) {
      interaction = { ...interaction, inlineEditing: false, composing: false };
      lostStop = true;
    }
    if (interaction.inlineEditing || interaction.composing || interaction.dragging) return;

    const previous = active;
    const view = previous ? captureView(previous, options.currentTarget()) : undefined;
    const focused = document.activeElement;

    held.settled = true;
    candidate = undefined;
    detach(held);
    held.frame.dataset.handoverCanvasFrame = 'active';
    held.frame.style.opacity = '1';
    held.frame.style.pointerEvents = 'auto';
    held.frame.removeAttribute('aria-hidden');
    held.frame.removeAttribute('inert');
    held.frame.removeAttribute('tabindex');

    active = held;
    held.onActiveLoad = () => {
      if (active !== held) return;
      interaction = { ...interaction, inlineEditing: false, composing: false };
      options.onInteractionChange?.({ inlineEditing: false, composing: false });
      if (candidate) promote(candidate);
    };
    held.frame.addEventListener('load', held.onActiveLoad);
    if (previous) remove(previous);
    restoreView(held, view);
    options.onStructureChange?.(held.structure);
    const wanted = options.currentSelection?.() ?? held.selection;
    if (wanted && held.structure.length) {
      if (held.structure.some((node) => sameCanvasSelection(node, wanted))) {
        held.bridge.select(wanted, { scroll: false });
        options.onSelectionChange?.(wanted, 'restore');
      } else {
        options.onSelectionChange?.(undefined);
      }
    }
    if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused)
      focused.focus({ preventScroll: true });
    update({
      phase: 'ready',
      requestId: held.manifest.requestId,
      contentVersion: held.manifest.contentVersion,
    });
    held.resolve({
      ok: true,
      requestId: held.manifest.requestId,
      contentVersion: held.manifest.contentVersion,
    });
  };

  // The workspace still owes the cleared edit its history boundary.
  const settle = (held: RenderFrame) => {
    promote(held);
    if (!lostStop) return;
    lostStop = false;
    options.onInteractionChange?.({ inlineEditing: false, composing: false });
  };

  // Any later message from the page is a chance to notice a stop that never arrived.
  const recheck = (held: RenderFrame) => {
    if (active === held && candidate && interaction.inlineEditing) settle(candidate);
  };

  const startRender = (
    request: CanvasRenderRequest,
    requestId = options.requestId?.() ?? randomId(),
  ): Promise<CanvasRenderResult> => {
    if (disposed) throw new Error('Canvas renderer is disposed.');
    if (candidate) finishFailure(candidate, 'superseded', {}, false);

    const manifest: CanvasSuccessManifest = {
      mode: 'canvas',
      status: 'success',
      protocol: CANVAS_PROTOCOL,
      requestId,
      epoch: request.snapshot.epoch,
      entry: request.snapshot.entry,
      locale: request.snapshot.locale,
      contentVersion: request.snapshot.contentVersion,
    };
    const targetUrl = new URL(request.url, window.location.href);
    if (targetUrl.origin !== window.location.origin)
      throw new Error('Canvas render URL must be same-origin.');
    const serialized = JSON.stringify({ ...request.snapshot, requestId });
    const frame = document.createElement('iframe');
    frame.name = `handover-canvas-${randomId()}`;
    frame.title = frameTitle(options.uiLocale());
    frame.dataset.handoverCanvasFrame = 'candidate';
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('inert', '');
    frame.tabIndex = -1;
    Object.assign(frame.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      border: '0',
      opacity: '0',
      pointerEvents: 'none',
    });
    options.stage.append(frame);
    const contentWindow = frame.contentWindow;
    if (!contentWindow) {
      frame.remove();
      throw new Error('Canvas candidate has no browsing context.');
    }

    let resolve!: (result: CanvasRenderResult) => void;
    const result = new Promise<CanvasRenderResult>((done) => (resolve = done));
    let held!: RenderFrame;
    const rejected = (reason: CanvasBridgeRejection, message: unknown) => {
      options.onBridgeRejected?.(reason, message);
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'handover:canvas:ready' &&
        (reason === 'protocol' || reason.startsWith('stale-'))
      )
        finishFailure(held, 'stale');
    };
    const bridge = createCanvasParentBridge({
      manifest,
      frame: contentWindow,
      origin: window.location.origin,
      contentVersion: options.contentVersion,
      currentTarget: options.currentTarget,
      onCommand: options.onCommand,
      commandRecovery: options.commandRecovery,
      onReady: () => {
        held.ready = true;
        held.bridge.uiLocale(options.uiLocale());
        held.bridge.mode(mode);
        held.bridge.problems(problemAddresses);
        settle(held);
      },
      onSelection: (selection) => {
        held.selection = selection;
        if (active === held) options.onSelectionChange?.(selection);
        recheck(held);
      },
      onStructure: (nodes) => {
        held.structure = nodes;
        if (active === held) {
          options.onStructureChange?.(nodes);
          const wanted = options.currentSelection?.();
          if (wanted && nodes.some((node) => sameCanvasSelection(node, wanted)))
            held.bridge.select(wanted, { scroll: false });
          // An older visible page cannot disprove a newly inserted draft selection.
          else if (wanted && held.manifest.contentVersion === options.contentVersion())
            options.onSelectionChange?.(undefined);
        }
        recheck(held);
      },
      onAction: (message) => {
        if (active === held) options.onAction?.(message);
        recheck(held);
      },
      onNavigate: (message) => {
        if (active === held) options.onNavigate?.(message);
        recheck(held);
      },
      onEditing: (_target, state) => {
        if (active !== held) return;
        setInteractionState(state);
        options.onInteractionChange?.(state);
      },
      onRejected: rejected,
    });
    const onload = () => {
      if (candidate !== held || held.settled) return;
      let found: ReturnType<typeof readCanvasResultManifest>;
      try {
        if (frame.contentWindow?.location.href === 'about:blank') return;
        found = frame.contentDocument ? readCanvasResultManifest(frame.contentDocument) : undefined;
      } catch {
        return finishFailure(held, 'bootstrap');
      }
      if (!found) return finishFailure(held, 'bootstrap');
      if (found.status === 'error') {
        if (
          (found.requestId !== undefined && found.requestId !== manifest.requestId) ||
          (found.epoch !== undefined && found.epoch !== manifest.epoch) ||
          (found.contentVersion !== undefined && found.contentVersion !== manifest.contentVersion)
        )
          return finishFailure(held, 'stale');
        return finishFailure(held, 'render', found.error);
      }
      if (!sameManifest(found, manifest)) return finishFailure(held, 'stale');
      held.loaded = true;
      settle(held);
    };
    const onerror = () => finishFailure(held, 'bootstrap');
    held = {
      frame,
      manifest,
      bridge,
      loaded: false,
      ready: false,
      settled: false,
      timer: setTimeout(() => finishFailure(held, 'timeout'), timeoutMs),
      onload,
      onerror,
      resolve,
      structure: [],
    };
    candidate = held;
    frame.addEventListener('load', onload);
    frame.addEventListener('error', onerror);
    update({
      phase: 'rendering',
      requestId,
      contentVersion: manifest.contentVersion,
    });

    const form = document.createElement('form');
    form.method = 'post';
    form.action = targetUrl.href;
    form.target = frame.name;
    form.hidden = true;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'snapshot';
    input.value = serialized;
    form.append(input);
    options.stage.append(form);
    try {
      form.submit();
    } catch (error) {
      finishFailure(held, 'bootstrap', {
        message: error instanceof Error ? error.message : 'Canvas POST failed.',
      });
    } finally {
      form.remove();
    }
    return result;
  };

  const settlePending = (held: PendingRender, result: Promise<CanvasRenderResult>) => {
    void result.then(
      (value) =>
        held.waiters.forEach(({ resolve }) => {
          resolve(value);
        }),
      (reason) =>
        held.waiters.forEach(({ reject }) => {
          reject(reason);
        }),
    );
  };

  const launchPending = () => {
    const held = pending;
    if (!held || disposed) return;
    pending = undefined;
    clearTimeout(held.timer);
    try {
      settlePending(held, startRender(held.request(), held.requestId));
    } catch (error) {
      held.waiters.forEach(({ reject }) => {
        reject(error);
      });
    }
  };

  const render = (request: CanvasRenderRequest): Promise<CanvasRenderResult> => {
    const held = pending;
    if (held) {
      pending = undefined;
      clearTimeout(held.timer);
    }
    const result = startRender(request);
    if (held) settlePending(held, result);
    return result;
  };

  return {
    render,
    schedule(request: CanvasRenderRequestFactory): Promise<CanvasRenderResult> {
      if (disposed) throw new Error('Canvas renderer is disposed.');
      return new Promise<CanvasRenderResult>((resolve, reject) => {
        if (pending) {
          pending.request = request;
          pending.requestId = options.requestId?.() ?? randomId();
          pending.waiters.push({ resolve, reject });
          clearTimeout(pending.timer);
          pending.timer = setTimeout(launchPending, renderDelayMs);
          return;
        }
        pending = {
          request,
          requestId: options.requestId?.() ?? randomId(),
          waiters: [{ resolve, reject }],
          timer: setTimeout(launchPending, renderDelayMs),
        };
      });
    },
    /** Launch the latest continuous edit now, when an explicit editing boundary is reached. */
    flushScheduled(): boolean {
      if (!pending || disposed) return false;
      launchPending();
      return true;
    },
    /** Incomplete content still autosaves; discard renders that can no longer represent it. */
    pause() {
      if (disposed) return;
      if (pending) {
        const held = pending;
        pending = undefined;
        clearTimeout(held.timer);
        held.waiters.forEach(({ resolve }) => {
          resolve({ ok: false, requestId: held.requestId, reason: 'superseded' });
        });
      }
      if (candidate) finishFailure(candidate, 'superseded', {}, false);
      update(
        active
          ? {
              phase: 'ready',
              requestId: active.manifest.requestId,
              contentVersion: active.manifest.contentVersion,
            }
          : { phase: 'idle' },
      );
    },
    setInteractionState(next: Partial<CanvasInteractionState>) {
      setInteractionState(next);
    },
    state: () => state,
    activeFrame: () => active?.frame,
    candidateFrame: () => candidate?.frame,
    select(value: CanvasSelection) {
      if (!active) return false;
      return active.bridge.select(value);
    },
    textField(value?: CanvasTextField) {
      if (!active) return false;
      return active.bridge.textField(value);
    },
    actions(value: CanvasSelection, actions: import('./canvas-bridge').CanvasBlockAction[]) {
      if (!active) return false;
      return active.bridge.actions(value, actions);
    },
    mode(next: CanvasInteractionMode) {
      mode = next;
      return active?.bridge.mode(next) ?? false;
    },
    problems(addresses: string[]) {
      problemAddresses = [...addresses];
      return active?.bridge.problems(addresses) ?? false;
    },
    uiLocale(next: UiLocale) {
      if (active) active.frame.title = frameTitle(next);
      if (candidate) candidate.frame.title = frameTitle(next);
      const activeUpdated = active?.bridge.uiLocale(next) ?? false;
      const candidateUpdated = candidate?.bridge.uiLocale(next) ?? false;
      return activeUpdated || candidateUpdated;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pending) {
        const held = pending;
        pending = undefined;
        clearTimeout(held.timer);
        const result: CanvasRenderResult = {
          ok: false,
          requestId: held.requestId,
          reason: 'disposed',
        };
        held.waiters.forEach(({ resolve }) => {
          resolve(result);
        });
      }
      if (candidate) finishFailure(candidate, 'disposed', {}, false);
      if (active) {
        remove(active);
        active = undefined;
      }
      update({ phase: 'disposed' });
    },
  };
}
