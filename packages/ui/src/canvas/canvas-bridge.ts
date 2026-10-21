import type { UiLocale } from '@handover/core';
import {
  acknowledgement,
  actionCapabilityMessage,
  address,
  BASE,
  base,
  blockAction,
  CANVAS_PROTOCOL,
  type CanvasAcknowledgement,
  type CanvasActionCapability,
  type CanvasActionMessage,
  type CanvasAnchor,
  type CanvasBlockAction,
  type CanvasBridgeRejection,
  type CanvasCommandMessage,
  type CanvasCommandRefusal,
  type CanvasCommandResult,
  type CanvasEditingState,
  type CanvasErrorManifest,
  type CanvasIdentity,
  type CanvasInteractionMode,
  type CanvasMutation,
  type CanvasNavigationMessage,
  type CanvasNavigationRequest,
  type CanvasProblemsMessage,
  type CanvasResultManifest,
  type CanvasSelection,
  type CanvasStructureNode,
  type CanvasSuccessManifest,
  type CanvasTarget,
  type CanvasTextField,
  type CanvasTextUpdate,
  type CanvasUiLocaleMessage,
  canvasAnchor,
  childMessage,
  copySelection,
  copyTextField,
  id,
  identity,
  keys,
  modeMessage,
  problemsMessage,
  record,
  selection,
  selectMessage,
  stale,
  type TextFieldMessage,
  textFieldMessage,
  uiLocaleMessage,
} from './canvas-protocol';
import { sameCanvasTarget } from './canvas-target';

export interface CanvasParentBridgeOptions {
  manifest: CanvasSuccessManifest;
  frame: Window;
  origin: string;
  contentVersion: () => number;
  currentTarget: () => CanvasTarget | undefined;
  onCommand: (message: CanvasCommandMessage) => CanvasCommandResult | Promise<CanvasCommandResult>;
  commandRecovery?: (message: CanvasCommandMessage) => CanvasTextUpdate | undefined;
  /** Called once the expected iframe has completed the exact, current handshake. */
  onReady?: () => void;
  onSelection?: (selection: CanvasSelection) => void;
  onStructure?: (nodes: CanvasStructureNode[]) => void;
  onAction?: (message: CanvasActionMessage) => void;
  onNavigate?: (message: CanvasNavigationMessage) => void;
  onEditing?: (target: CanvasTarget, state: CanvasEditingState) => void;
  onRejected?: (reason: CanvasBridgeRejection, message: unknown) => void;
  owner?: Window;
  listen?: boolean;
}

export function createCanvasParentBridge(options: CanvasParentBridgeOptions) {
  const { manifest, frame, origin } = options;
  const owner = options.owner ?? window;
  const seen = new Set<string>();
  let connected = false;
  let disposed = false;
  let replyPort: MessagePort | undefined;
  // The parent session can advance before this rendered document receives a field update. Locale
  // synchronization follows the child's accepted version so it remains independent of form edits.
  let childVersion = manifest.contentVersion;
  // Not the admin's current version: after a locale switch that counts another locale.
  let stopVersionCeiling = manifest.contentVersion;
  let editingOwner:
    | { target: CanvasTarget; interactionId?: string; startVersion: number }
    | undefined;
  const reject = (reason: CanvasBridgeRejection, message: unknown) =>
    options.onRejected?.(reason, message);
  const post = (reply: CanvasAcknowledgement) => {
    if (disposed) return;
    if (replyPort) replyPort.postMessage(reply);
    else frame.postMessage(reply, origin);
  };
  const refusal = (message: CanvasCommandMessage, reason: CanvasCommandRefusal) => {
    reject(reason, message);
    const update = options.commandRecovery?.(message);
    childVersion = options.contentVersion();
    stopVersionCeiling = Math.max(stopVersionCeiling, childVersion);
    post({
      ...base(manifest, message.contentVersion),
      type: 'handover:canvas:ack',
      commandId: message.commandId,
      target: message.target,
      ok: false,
      reason,
      acceptedVersion: options.contentVersion(),
      ...(update ? { update } : {}),
    });
  };
  const receive = (event: MessageEvent) => {
    if (disposed) return;
    if (event.origin !== origin) return reject('foreign-origin', event.data);
    if (event.source !== frame) return reject('foreign-window', event.data);
    const message = childMessage(event.data);
    if (!message) return reject('malformed', event.data);
    if (message.type === 'handover:canvas:ready') {
      const reason = stale(message, manifest, options.contentVersion());
      if (reason) return reject(reason, message);
      if (connected) return;
      replyPort = event.ports?.[0];
      replyPort?.start();
      connected = true;
      options.onReady?.();
      return;
    }
    if (message.type === 'handover:canvas:selection') {
      const reason = stale(message, manifest, options.contentVersion());
      if (reason) return reject(reason, message);
      if (!connected) return reject('not-ready', message);
      options.onSelection?.(message.selection);
      return;
    }
    if (message.type === 'handover:canvas:structure') {
      const reason = stale(message, manifest, options.contentVersion());
      if (reason) return reject(reason, message);
      if (!connected) return reject('not-ready', message);
      options.onStructure?.(message.nodes);
      return;
    }
    if (message.type === 'handover:canvas:action') {
      const reason = stale(message, manifest, options.contentVersion());
      if (reason) return reject(reason, message);
      if (!connected) return reject('not-ready', message);
      const current = options.currentTarget();
      if (!current || !sameCanvasTarget(message.selection.target, current))
        return reject('stale-target', message);
      options.onAction?.(message);
      return;
    }
    if (message.type === 'handover:canvas:navigate') {
      const reason = stale(message, manifest, options.contentVersion());
      if (reason) return reject(reason, message);
      if (!connected) return reject('not-ready', message);
      options.onNavigate?.(message);
      return;
    }
    if (message.type === 'handover:canvas:editing') {
      const ending =
        !message.state.inlineEditing &&
        !message.state.composing &&
        message.state.dragging === undefined;
      const ownedEnd =
        ending &&
        editingOwner &&
        sameCanvasTarget(message.target, editingOwner.target) &&
        message.interactionId === editingOwner.interactionId;
      // A drag end changes nothing, so a version bump mid-drag must not strand it.
      const draggingEnd =
        message.state.dragging === false &&
        !message.state.inlineEditing &&
        !message.state.composing;
      const currentVersion = options.contentVersion();
      const reason = stale(
        message,
        manifest,
        ownedEnd || draggingEnd ? message.contentVersion : currentVersion,
      );
      if (reason) return reject(reason, message);
      if (
        ownedEnd &&
        editingOwner &&
        (message.contentVersion < editingOwner.startVersion ||
          message.contentVersion > stopVersionCeiling)
      )
        return reject('stale-version', message);
      if (!connected) return reject('not-ready', message);
      const current = options.currentTarget();
      if (!ownedEnd && !draggingEnd && (!current || !sameCanvasTarget(message.target, current)))
        return reject('stale-target', message);
      if (ending && editingOwner && !ownedEnd) return reject('stale-target', message);
      if (message.state.inlineEditing)
        editingOwner = {
          target: message.target,
          interactionId: message.interactionId,
          startVersion:
            editingOwner &&
            sameCanvasTarget(message.target, editingOwner.target) &&
            message.interactionId === editingOwner.interactionId
              ? editingOwner.startVersion
              : currentVersion,
        };
      else if (ownedEnd) editingOwner = undefined;
      options.onEditing?.(message.target, message.state);
      return;
    }
    const identityReason = stale(message, manifest, message.contentVersion);
    if (identityReason) return refusal(message, identityReason);
    if (seen.has(message.commandId)) return refusal(message, 'duplicate-command');
    const reason = stale(message, manifest, options.contentVersion());
    if (reason) return refusal(message, reason);
    const current = options.currentTarget();
    if (!current || !sameCanvasTarget(message.target, current))
      return refusal(message, 'stale-target');
    if (!connected) return refusal(message, 'not-ready');

    const reply = Promise.resolve()
      .then(() => options.onCommand(message))
      .then<CanvasAcknowledgement>((result) => {
        if (result.ok) {
          childVersion = result.contentVersion;
          stopVersionCeiling = Math.max(stopVersionCeiling, childVersion);
        }
        return {
          ...base(manifest, message.contentVersion),
          type: 'handover:canvas:ack',
          commandId: message.commandId,
          target: message.target,
          ...(result.ok
            ? {
                ok: true as const,
                acceptedVersion: result.contentVersion,
                ...(result.update ? { update: result.update } : {}),
              }
            : { ok: false as const, reason: result.reason }),
        };
      })
      .catch(
        (): CanvasAcknowledgement => ({
          ...base(manifest, message.contentVersion),
          type: 'handover:canvas:ack',
          commandId: message.commandId,
          target: message.target,
          ok: false,
          reason: 'handler-error',
        }),
      );
    seen.add(message.commandId);
    if (seen.size > 500) seen.delete(seen.values().next().value as string);
    void reply.then(post);
  };
  if (options.listen !== false) owner.addEventListener('message', receive);
  return {
    connected: () => connected && !disposed,
    receive,
    select(value: CanvasSelection, settings: { scroll?: boolean } = {}) {
      if (disposed || !connected) return false;
      frame.postMessage(
        {
          ...base(manifest, options.contentVersion()),
          type: 'handover:canvas:select',
          selection: copySelection(value),
          ...(settings.scroll === undefined ? {} : { scroll: settings.scroll }),
        },
        origin,
      );
      return true;
    },
    textField(value?: CanvasTextField) {
      if (disposed || !connected) return false;
      childVersion = options.contentVersion();
      stopVersionCeiling = Math.max(stopVersionCeiling, childVersion);
      frame.postMessage(
        {
          ...base(manifest, options.contentVersion()),
          type: 'handover:canvas:text-field',
          field: value ? copyTextField(value) : null,
        },
        origin,
      );
      return true;
    },
    actions(value: CanvasSelection, actions: CanvasBlockAction[]) {
      if (disposed || !connected) return false;
      frame.postMessage(
        {
          ...base(manifest, options.contentVersion()),
          type: 'handover:canvas:actions',
          selection: copySelection(value),
          actions: [...actions],
        },
        origin,
      );
      return true;
    },
    mode(value: CanvasInteractionMode) {
      if (disposed || !connected) return false;
      frame.postMessage(
        {
          ...base(manifest, options.contentVersion()),
          type: 'handover:canvas:mode',
          mode: value,
        },
        origin,
      );
      return true;
    },
    problems(addresses: string[]) {
      if (disposed || !connected) return false;
      // One over-long address must not hide every other valid one from the child.
      frame.postMessage(
        {
          ...base(manifest, childVersion),
          type: 'handover:canvas:problems',
          addresses: addresses.filter(address),
        } satisfies CanvasProblemsMessage,
        origin,
      );
      return true;
    },
    uiLocale(value: UiLocale) {
      if (disposed || !connected) return false;
      frame.postMessage(
        {
          ...base(manifest, childVersion),
          type: 'handover:canvas:ui-locale',
          uiLocale: value,
        } satisfies CanvasUiLocaleMessage,
        origin,
      );
      return true;
    },
    dispose: () => {
      disposed = true;
      connected = false;
      owner.removeEventListener('message', receive);
      replyPort?.close();
      replyPort = undefined;
      editingOwner = undefined;
      seen.clear();
    },
  };
}

export interface CanvasChildBridgeOptions {
  manifest: CanvasSuccessManifest;
  parent: Window;
  origin: string;
  owner?: Window;
  commandId?: () => string;
  listen?: boolean;
  onSelect?: (selection: CanvasSelection, settings: { scroll: boolean }) => void;
  onTextField?: (field: CanvasTextField | undefined) => void;
  onActions?: (capability: CanvasActionCapability) => void;
  onMode?: (mode: CanvasInteractionMode) => void;
  onProblems?: (addresses: string[]) => void;
  onUiLocale?: (locale: UiLocale) => void;
}

export function createCanvasChildBridge(options: CanvasChildBridgeOptions) {
  const { manifest, parent, origin } = options;
  const owner = options.owner ?? window;
  const pending = new Map<
    string,
    { version: number; target: CanvasTarget; resolve: (reply: CanvasAcknowledgement) => void }
  >();
  let version = manifest.contentVersion;
  let interactionOwner: { target: CanvasTarget; id: string } | undefined;
  let started = false;
  let disposed = false;
  let replyPort: MessagePort | undefined;
  // Updates can be stamped ahead of this child while a command is in flight; apply them after.
  const held = new Map<
    'field' | 'problems' | 'uiLocale',
    { contentVersion: number; apply: () => void }
  >();
  const hold = (
    kind: 'field' | 'problems' | 'uiLocale',
    message: CanvasIdentity,
    apply: () => void,
  ) => {
    if (stale(message, manifest, message.contentVersion) || message.contentVersion < version)
      return;
    if (!pending.size) return apply();
    const prior = held.get(kind);
    if (!prior || message.contentVersion >= prior.contentVersion)
      held.set(kind, { contentVersion: message.contentVersion, apply });
  };
  const applyField = (message: TextFieldMessage) => {
    if (message.contentVersion < version) return;
    version = message.contentVersion;
    options.onTextField?.(message.field ?? undefined);
  };
  const acceptReply = (value: unknown) => {
    const reply = acknowledgement(value);
    const sent = reply && pending.get(reply.commandId);
    if (
      !reply ||
      !sent ||
      reply.protocol !== CANVAS_PROTOCOL ||
      stale(reply, manifest, sent.version) ||
      !sameCanvasTarget(reply.target, sent.target)
    )
      return;
    pending.delete(reply.commandId);
    if (reply.ok) version = reply.acceptedVersion;
    else if (reply.acceptedVersion !== undefined) version = reply.acceptedVersion;
    if (!pending.size) {
      const updates = (['field', 'problems', 'uiLocale'] as const).map((kind) => held.get(kind));
      held.clear();
      for (const update of updates) update?.apply();
    }
    sent.resolve(reply);
  };
  const receive = (event: MessageEvent) => {
    if (disposed || event.origin !== origin || event.source !== parent) return;
    const requested = selectMessage(event.data);
    const configured = textFieldMessage(event.data);
    const configuredActions = actionCapabilityMessage(event.data);
    const configuredMode = modeMessage(event.data);
    const configuredUiLocale = uiLocaleMessage(event.data);
    const configuredProblems = problemsMessage(event.data);
    if (requested) {
      if (!stale(requested, manifest, version))
        options.onSelect?.(requested.selection, { scroll: requested.scroll !== false });
      return;
    }
    if (configured) return hold('field', configured, () => applyField(configured));
    if (configuredActions) {
      if (!stale(configuredActions, manifest, version))
        options.onActions?.({
          selection: configuredActions.selection,
          actions: configuredActions.actions,
        });
      return;
    }
    if (configuredMode) {
      if (!stale(configuredMode, manifest, version)) options.onMode?.(configuredMode.mode);
      return;
    }
    if (configuredProblems)
      return hold('problems', configuredProblems, () =>
        options.onProblems?.(configuredProblems.addresses),
      );
    if (configuredUiLocale)
      return hold('uiLocale', configuredUiLocale, () =>
        options.onUiLocale?.(configuredUiLocale.uiLocale),
      );
    acceptReply(event.data);
  };
  if (options.listen !== false) owner.addEventListener('message', receive);
  return {
    start() {
      if (started || disposed) return;
      started = true;
      const Channel = (owner as Window & { MessageChannel?: typeof MessageChannel }).MessageChannel;
      if (Channel) {
        const channel = new Channel();
        replyPort = channel.port1;
        replyPort.onmessage = (event) => acceptReply(event.data);
        replyPort.start();
        parent.postMessage({ ...base(manifest, version), type: 'handover:canvas:ready' }, origin, [
          channel.port2,
        ]);
      } else {
        parent.postMessage({ ...base(manifest, version), type: 'handover:canvas:ready' }, origin);
      }
    },
    selection(value: CanvasSelection) {
      if (!started || disposed) return false;
      parent.postMessage(
        { ...base(manifest, version), type: 'handover:canvas:selection', selection: value },
        origin,
      );
      return true;
    },
    structure(nodes: CanvasStructureNode[]) {
      if (!started || disposed) return false;
      parent.postMessage(
        { ...base(manifest, version), type: 'handover:canvas:structure', nodes },
        origin,
      );
      return true;
    },
    action(
      action: CanvasBlockAction,
      selected: CanvasSelection,
      destination?: CanvasSelection,
      anchor?: CanvasAnchor,
    ) {
      if (!started || disposed || !blockAction(action) || !selection(selected)) return false;
      if (
        (action === 'move' && !selection(destination)) ||
        (action !== 'move' && destination !== undefined)
      )
        return false;
      if (action === 'edit-media' && !canvasAnchor(anchor)) return false;
      parent.postMessage(
        {
          ...base(manifest, version),
          type: 'handover:canvas:action',
          action,
          selection: selected,
          ...(action === 'move' ? { destination } : {}),
          ...(action === 'edit-media' ? { anchor } : {}),
        },
        origin,
      );
      return true;
    },
    command(targetValue: CanvasTarget, change: CanvasMutation) {
      if (!started || disposed) throw new Error('Canvas bridge is not connected.');
      const commandId = options.commandId?.() ?? crypto.randomUUID();
      if (!id(commandId) || pending.has(commandId))
        throw new Error('Canvas command ID is not unique.');
      const message: CanvasCommandMessage = {
        ...base(manifest, version),
        type: 'handover:canvas:command',
        commandId,
        target: targetValue,
        command: change,
      };
      const response = new Promise<CanvasAcknowledgement>((resolve) =>
        pending.set(commandId, { version, target: targetValue, resolve }),
      );
      parent.postMessage(message, origin);
      return response;
    },
    interaction(targetValue: CanvasTarget, state: CanvasEditingState) {
      if (!started || disposed) return false;
      if (
        state.inlineEditing &&
        (!interactionOwner || !sameCanvasTarget(targetValue, interactionOwner.target))
      )
        interactionOwner = { target: targetValue, id: crypto.randomUUID() };
      const interactionId =
        state.dragging === undefined &&
        interactionOwner &&
        sameCanvasTarget(targetValue, interactionOwner.target)
          ? interactionOwner.id
          : undefined;
      parent.postMessage(
        {
          ...base(manifest, version),
          type: 'handover:canvas:editing',
          target: targetValue,
          state,
          ...(interactionId ? { interactionId } : {}),
        },
        origin,
      );
      if (!state.inlineEditing && state.dragging === undefined && interactionId)
        interactionOwner = undefined;
      return true;
    },
    navigate(request: CanvasNavigationRequest) {
      if (!started || disposed) return false;
      parent.postMessage(
        { ...base(manifest, version), type: 'handover:canvas:navigate', ...request },
        origin,
      );
      return true;
    },
    contentVersion: () => version,
    receive,
    dispose() {
      disposed = true;
      owner.removeEventListener('message', receive);
      replyPort?.close();
      replyPort = undefined;
      held.clear();
      for (const [commandId, sent] of pending)
        sent.resolve({
          ...base(manifest, sent.version),
          type: 'handover:canvas:ack',
          commandId,
          target: sent.target,
          ok: false,
          reason: 'not-ready',
        });
      pending.clear();
    },
  };
}

export function readCanvasManifest(root: Document = document): CanvasSuccessManifest | undefined {
  const value = readCanvasResultManifest(root);
  return value?.status === 'success' ? value : undefined;
}

export function readCanvasResultManifest(
  root: Document = document,
): CanvasResultManifest | undefined {
  const element = root.querySelector('[data-handover-canvas-manifest]');
  try {
    const value = JSON.parse(element?.textContent ?? '') as unknown;
    if (!record(value) || value.mode !== 'canvas' || value.protocol !== CANVAS_PROTOCOL) return;
    const successKeys =
      value.entryDirectory === undefined
        ? ['mode', 'status', ...BASE]
        : ['mode', 'status', ...BASE, 'entryDirectory'];
    if (
      value.status === 'success' &&
      keys(value, successKeys) &&
      identity(value) &&
      (value.entryDirectory === undefined ||
        (typeof value.entryDirectory === 'string' &&
          /^\/(?!\/)/.test(value.entryDirectory) &&
          value.entryDirectory.endsWith('/admin/api/entries')))
    )
      return value as unknown as CanvasSuccessManifest;
    if (value.status !== 'error' || !record(value.error)) return;
    const correlated =
      value.requestId !== undefined ||
      value.epoch !== undefined ||
      value.contentVersion !== undefined;
    const expected = correlated
      ? ['mode', 'status', 'protocol', 'requestId', 'epoch', 'contentVersion', 'error']
      : ['mode', 'status', 'protocol', 'error'];
    if (
      !keys(value, expected) ||
      (correlated &&
        (!id(value.requestId) ||
          !id(value.epoch) ||
          !Number.isSafeInteger(value.contentVersion) ||
          (value.contentVersion as number) < 0)) ||
      !keys(value.error, ['status', 'message'], ['code', 'detail']) ||
      !Number.isSafeInteger(value.error.status) ||
      (value.error.status as number) < 400 ||
      (value.error.status as number) > 599 ||
      typeof value.error.message !== 'string' ||
      (value.error.code !== undefined && typeof value.error.code !== 'string') ||
      (value.error.detail !== undefined && typeof value.error.detail !== 'string')
    )
      return;
    return value as unknown as CanvasErrorManifest;
  } catch {
    return undefined;
  }
}
