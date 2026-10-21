import type { UiLocale } from '@handover/core';
import {
  address,
  base,
  type CanvasAcknowledgement,
  type CanvasActionMessage,
  type CanvasBlockAction,
  type CanvasBridgeRejection,
  type CanvasCommandMessage,
  type CanvasCommandRefusal,
  type CanvasCommandResult,
  type CanvasEditingState,
  type CanvasInteractionMode,
  type CanvasNavigationMessage,
  type CanvasProblemsMessage,
  type CanvasSelection,
  type CanvasStructureNode,
  type CanvasSuccessManifest,
  type CanvasTarget,
  type CanvasTextField,
  type CanvasTextUpdate,
  type CanvasUiLocaleMessage,
  childMessage,
  copySelection,
  copyTextField,
  stale,
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
