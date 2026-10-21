import type { UiLocale } from '@handover/core';
import {
  acknowledgement,
  actionCapabilityMessage,
  base,
  blockAction,
  CANVAS_PROTOCOL,
  type CanvasAcknowledgement,
  type CanvasActionCapability,
  type CanvasAnchor,
  type CanvasBlockAction,
  type CanvasCommandMessage,
  type CanvasEditingState,
  type CanvasIdentity,
  type CanvasInteractionMode,
  type CanvasMutation,
  type CanvasNavigationRequest,
  type CanvasSelection,
  type CanvasStructureNode,
  type CanvasSuccessManifest,
  type CanvasTarget,
  type CanvasTextField,
  canvasAnchor,
  id,
  modeMessage,
  problemsMessage,
  selection,
  selectMessage,
  stale,
  type TextFieldMessage,
  textFieldMessage,
  uiLocaleMessage,
} from '../canvas-protocol';
import { sameCanvasTarget } from '../canvas-target';

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
