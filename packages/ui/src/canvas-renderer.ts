import {
  CANVAS_PROTOCOL,
  type CanvasBridgeRejection,
  type CanvasCommandMessage,
  type CanvasCommandResult,
  type CanvasDocumentIdentity,
  type CanvasEditingState,
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
import type { CanvasInteractionMode } from './canvas-navigation';

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
  /** Delay used to coalesce completed edits and block actions into one fresh render. */
  renderDelayMs?: number;
  owner?: Window;
  document?: Document;
  requestId?: () => string;
  frameName?: () => string;
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
  resolve: (result: CanvasRenderResult) => void;
  selection?: CanvasSelection;
  structure: CanvasStructureNode[];
}

interface PendingRender {
  request: CanvasRenderRequest;
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

const identifier = (value: string, label: string) => {
  if (!value || value.length > 200) throw new Error(`Canvas ${label} is invalid.`);
  return value;
};

const sameDocument = (a: CanvasDocumentIdentity, b: CanvasDocumentIdentity) =>
  a.collection === b.collection && a.id === b.id;

const sameLocation = (
  a: { document: CanvasDocumentIdentity; locale: string; address: string } | undefined,
  b: { document: CanvasDocumentIdentity; locale: string; address: string } | undefined,
) =>
  a === b ||
  (!!a &&
    !!b &&
    sameDocument(a.document, b.document) &&
    a.locale === b.locale &&
    a.address === b.address);

const sameTarget = (a: CanvasTarget, b: CanvasTarget) =>
  sameLocation(a, b) && sameLocation(a.occurrence, b.occurrence);
const sameSelection = (a: CanvasSelection, b: CanvasSelection) =>
  a.kind === b.kind && sameTarget(a.target, b.target);

const sameManifest = (a: CanvasSuccessManifest, b: CanvasSuccessManifest) =>
  a.protocol === b.protocol &&
  a.requestId === b.requestId &&
  a.epoch === b.epoch &&
  sameDocument(a.entry, b.entry) &&
  a.locale === b.locale &&
  a.contentVersion === b.contentVersion;

const randomId = () => crypto.randomUUID();
const markerSelector = '[data-handover-field], [data-handover-list], [data-handover-block]';

const findTarget = (root: Document, expected: CanvasTarget): Element | undefined => {
  for (const element of Array.from(root.querySelectorAll(markerSelector))) {
    for (const attribute of ['data-handover-field', 'data-handover-list', 'data-handover-block']) {
      const serialized = element.getAttribute(attribute);
      if (!serialized) continue;
      try {
        if (sameTarget(JSON.parse(serialized) as CanvasTarget, expected)) return element;
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

/**
 * Owns full-document Canvas replacement. Each attempt gets a new browsing context; the current
 * document remains live until the candidate has both loaded and completed the exact bridge
 * handshake.
 */
export function createCanvasRenderer(options: CanvasRendererOptions) {
  const owner = options.owner ?? window;
  const root = options.document ?? document;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const renderDelayMs = options.renderDelayMs ?? 200;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Canvas render timeout must be positive.');
  if (!Number.isFinite(renderDelayMs) || renderDelayMs < 0)
    throw new Error('Canvas render delay must not be negative.');

  let state: CanvasRendererState = { phase: 'idle' };
  let active: RenderFrame | undefined;
  let candidate: RenderFrame | undefined;
  let pending: PendingRender | undefined;
  let disposed = false;
  let sequence = 0;
  let lastRequest: CanvasRenderRequest | undefined;
  let interaction: CanvasInteractionState = {
    inlineEditing: false,
    composing: false,
    dragging: false,
  };
  let mode: CanvasInteractionMode = 'edit';
  const setInteractionState = (next: Partial<CanvasInteractionState>) => {
    for (const value of Object.values(next))
      if (value !== undefined && typeof value !== 'boolean')
        throw new Error('Canvas interaction state must contain booleans.');
    interaction = { ...interaction, ...next };
    if (candidate) promote(candidate);
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
    if (interaction.inlineEditing || interaction.composing || interaction.dragging) return;

    const previous = active;
    const view = previous ? captureView(previous, options.currentTarget()) : undefined;
    const focused = root.activeElement;

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
    if (previous) remove(previous);
    restoreView(held, view);
    options.onStructureChange?.(held.structure);
    const wanted = options.currentSelection?.() ?? held.selection;
    if (wanted && held.structure.length) {
      if (held.structure.some((node) => sameSelection(node, wanted))) {
        held.bridge.select(wanted, { scroll: false });
        options.onSelectionChange?.(wanted, 'restore');
      } else {
        options.onSelectionChange?.(undefined);
      }
    }
    if (focused instanceof HTMLElement && focused.isConnected && root.activeElement !== focused)
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

  const frameName = () => {
    sequence += 1;
    const supplied = options.frameName?.() ?? randomId();
    const safe = identifier(supplied, 'frame name').replace(/[^a-zA-Z0-9_-]/g, '-');
    return `handover-canvas-${sequence}-${safe}`;
  };

  const startRender = (
    request: CanvasRenderRequest,
    requestId = identifier(options.requestId?.() ?? randomId(), 'request ID'),
  ): Promise<CanvasRenderResult> => {
    if (disposed) throw new Error('Canvas renderer is disposed.');
    if (request.snapshot.mode !== 'canvas' || request.snapshot.protocol !== CANVAS_PROTOCOL)
      throw new Error('Canvas render snapshot is invalid.');
    if (candidate) finishFailure(candidate, 'superseded', {}, false);
    lastRequest = request;

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
    const targetUrl = new URL(request.url, owner.location.href);
    if (targetUrl.origin !== owner.location.origin)
      throw new Error('Canvas render URL must be same-origin.');
    const serialized = JSON.stringify({ ...request.snapshot, requestId });
    const frame = root.createElement('iframe');
    frame.name = frameName();
    frame.title = 'The page as the site would serve it';
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
      origin: owner.location.origin,
      contentVersion: options.contentVersion,
      currentTarget: options.currentTarget,
      onCommand: options.onCommand,
      commandRecovery: options.commandRecovery,
      onReady: () => {
        held.ready = true;
        held.bridge.mode(mode);
        promote(held);
      },
      onSelection: (selection) => {
        held.selection = selection;
        if (active === held) options.onSelectionChange?.(selection);
      },
      onStructure: (nodes) => {
        held.structure = nodes;
        if (active === held) {
          options.onStructureChange?.(nodes);
          const wanted = options.currentSelection?.();
          if (wanted && nodes.some((node) => sameSelection(node, wanted)))
            held.bridge.select(wanted, { scroll: false });
          // An older visible page cannot disprove a newly inserted draft selection.
          else if (wanted && held.manifest.contentVersion === options.contentVersion())
            options.onSelectionChange?.(undefined);
        }
      },
      onAction: (message) => {
        if (active === held) options.onAction?.(message);
      },
      onNavigate: (message) => {
        if (active === held) options.onNavigate?.(message);
      },
      onEditing: (_target, state) => {
        if (active !== held) return;
        setInteractionState(state);
        options.onInteractionChange?.(state);
      },
      onRejected: rejected,
      owner,
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
      promote(held);
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

    const form = root.createElement('form');
    form.method = 'post';
    form.action = targetUrl.href;
    form.target = frame.name;
    form.hidden = true;
    const input = root.createElement('input');
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
      settlePending(held, startRender(held.request, held.requestId));
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
    schedule(request: CanvasRenderRequest): Promise<CanvasRenderResult> {
      if (disposed) throw new Error('Canvas renderer is disposed.');
      if (request.snapshot.mode !== 'canvas' || request.snapshot.protocol !== CANVAS_PROTOCOL)
        throw new Error('Canvas render snapshot is invalid.');
      lastRequest = request;
      return new Promise<CanvasRenderResult>((resolve, reject) => {
        if (pending) {
          pending.request = request;
          pending.requestId = identifier(options.requestId?.() ?? randomId(), 'request ID');
          pending.waiters.push({ resolve, reject });
          return;
        }
        pending = {
          request,
          requestId: identifier(options.requestId?.() ?? randomId(), 'request ID'),
          waiters: [{ resolve, reject }],
          timer: setTimeout(launchPending, renderDelayMs),
        };
      });
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
    retry(): Promise<CanvasRenderResult> {
      if (!lastRequest) throw new Error('Canvas has no render to retry.');
      return render(lastRequest);
    },
    state: () => state,
    activeFrame: () => active?.frame,
    candidateFrame: () => candidate?.frame,
    structure: () => active?.structure ?? [],
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
