import type { RichtextTier } from '@handover/core';
import type {
  CanvasInteractionMode,
  CanvasNavigationRequest,
} from './runtime/canvas-navigation';
import { sameCanvasDocument, sameCanvasTarget } from './canvas-target';
import type { FieldCommandFailure } from '../editor/entry-session.svelte';

export const CANVAS_PROTOCOL = 1 as const;
export interface CanvasDocumentIdentity {
  collection: string;
  id: string;
}
interface CanvasLocation {
  document: CanvasDocumentIdentity;
  locale: string;
  address: string;
}
export interface CanvasTarget extends CanvasLocation {
  occurrence?: CanvasLocation;
}
export type CanvasAnnotationKind = 'field' | 'list' | 'block';
export type CanvasBlockAction =
  | 'delete'
  | 'duplicate'
  | 'insert-before'
  | 'insert-after'
  | 'insert-empty'
  | 'move'
  | 'move-down'
  | 'move-up'
  | 'replace-media'
  | 'redo'
  | 'undo'
  | 'replace';
export interface CanvasSelection {
  kind: CanvasAnnotationKind;
  target: CanvasTarget;
}
export interface CanvasStructureNode extends CanvasSelection {
  id: string;
  label: string;
  parentId?: string;
  depth: number;
  position: number;
  setSize: number;
  occurrences: number;
  empty?: boolean;
}
interface CanvasIdentity {
  protocol: number;
  requestId: string;
  epoch: string;
  entry: CanvasDocumentIdentity;
  locale: string;
  contentVersion: number;
}
export interface CanvasSuccessManifest extends CanvasIdentity {
  mode: 'canvas';
  status: 'success';
  protocol: typeof CANVAS_PROTOCOL;
  /** Present in current responses; optional while an already-rendered older candidate boots. */
  entryDirectory?: string;
}
export interface CanvasErrorManifest {
  mode: 'canvas';
  status: 'error';
  protocol: typeof CANVAS_PROTOCOL;
  requestId?: string;
  epoch?: string;
  contentVersion?: number;
  error: { status: number; message: string };
}
export type CanvasResultManifest = CanvasSuccessManifest | CanvasErrorManifest;
export interface CanvasFieldMutation {
  type: 'field';
  changes: readonly { path?: readonly string[]; value: unknown }[];
  history?: CanvasTextHistory;
}
export interface CanvasTextSelection {
  kind?: 'node' | 'text';
  anchor: number;
  head: number;
}
export interface CanvasTextHistory {
  kind: 'composition' | 'format' | 'paste' | 'typing';
  group?: string;
  before?: CanvasTextSelection;
  after?: CanvasTextSelection;
}
export interface CanvasHistoryMutation {
  type: 'history';
  direction: 'undo' | 'redo';
}
export type CanvasMutation = CanvasFieldMutation | CanvasHistoryMutation;
interface CanvasFieldCapability {
  target: CanvasTarget;
  value: string;
}
export interface CanvasLinkValue {
  type: 'entry' | 'url';
  ref: string;
  href: string;
  label: string;
  newTab: boolean;
}
export type CanvasTextField =
  | (CanvasFieldCapability & { kind: 'text' })
  | (CanvasFieldCapability & { kind: 'richtext'; tier: RichtextTier })
  | { kind: 'link'; target: CanvasTarget; value: CanvasLinkValue };
export interface CanvasTextUpdate {
  value: string;
  selection?: CanvasTextSelection;
}
export interface CanvasEditingState {
  inlineEditing: boolean;
  composing: boolean;
  /** Present only while a block pointer projection owns the Canvas. */
  dragging?: boolean;
}
export interface CanvasCommandMessage extends CanvasIdentity {
  type: 'handover:canvas:command';
  commandId: string;
  target: CanvasTarget;
  command: CanvasMutation;
}
export interface CanvasActionMessage extends CanvasIdentity {
  type: 'handover:canvas:action';
  action: CanvasBlockAction;
  selection: CanvasSelection;
  /** Stable same-list destination for a completed pointer move. */
  destination?: CanvasSelection;
}
export interface CanvasActionCapability {
  selection: CanvasSelection;
  actions: CanvasBlockAction[];
}
export type CanvasNavigationMessage = CanvasIdentity &
  CanvasNavigationRequest & { type: 'handover:canvas:navigate' };
export type CanvasTransportRefusal =
  | 'duplicate-command'
  | 'handler-error'
  | 'not-ready'
  | 'protocol'
  | `stale-${'document' | 'epoch' | 'locale' | 'request' | 'target' | 'version'}`;
export type CanvasCommandRefusal =
  | CanvasTransportRefusal
  | FieldCommandFailure
  | 'empty'
  | 'frozen';
export type CanvasCommandResult =
  | { ok: true; contentVersion: number; update?: CanvasTextUpdate }
  | { ok: false; reason: FieldCommandFailure | 'empty' | 'frozen' };
export type CanvasAcknowledgement = CanvasIdentity & {
  type: 'handover:canvas:ack';
  commandId: string;
  target: CanvasTarget;
} & (
    | { ok: true; acceptedVersion: number; update?: CanvasTextUpdate }
    | {
        ok: false;
        reason: CanvasCommandRefusal;
        acceptedVersion?: number;
        update?: CanvasTextUpdate;
      }
  );
export type CanvasBridgeRejection =
  | 'foreign-origin'
  | 'foreign-window'
  | 'malformed'
  | CanvasCommandRefusal;

const REFUSALS = new Set<CanvasCommandRefusal>([
  'ambiguous',
  'closed',
  'deleted',
  'drift',
  'duplicate-command',
  'empty',
  'handler-error',
  'frozen',
  'not-ready',
  'protocol',
  'readonly',
  'referenced',
  'schema',
  'stale',
  'stale-document',
  'stale-epoch',
  'stale-locale',
  'stale-request',
  'stale-target',
  'stale-version',
  'structural',
]);
const BASE = ['protocol', 'requestId', 'epoch', 'entry', 'locale', 'contentVersion'];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length &&
  Object.keys(value).every((key) => expected.includes(key));
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
const documentIdentity = (value: unknown): value is CanvasDocumentIdentity =>
  record(value) && keys(value, ['collection', 'id']) && id(value.collection) && id(value.id);
const location = (value: unknown): value is CanvasLocation =>
  record(value) &&
  keys(value, ['document', 'locale', 'address']) &&
  documentIdentity(value.document) &&
  id(value.locale) &&
  id(value.address);
const target = (value: unknown): value is CanvasTarget =>
  record(value) &&
  keys(
    value,
    value.occurrence === undefined
      ? ['document', 'locale', 'address']
      : ['document', 'locale', 'address', 'occurrence'],
  ) &&
  documentIdentity(value.document) &&
  id(value.locale) &&
  id(value.address) &&
  (value.occurrence === undefined || location(value.occurrence));
export const isCanvasTarget = target;
const annotationKind = (value: unknown): value is CanvasAnnotationKind =>
  value === 'field' || value === 'list' || value === 'block';
const blockAction = (value: unknown): value is CanvasBlockAction =>
  value === 'delete' ||
  value === 'duplicate' ||
  value === 'insert-before' ||
  value === 'insert-after' ||
  value === 'insert-empty' ||
  value === 'move' ||
  value === 'move-down' ||
  value === 'move-up' ||
  value === 'replace-media' ||
  value === 'redo' ||
  value === 'undo' ||
  value === 'replace';
const selection = (value: unknown): value is CanvasSelection =>
  record(value) &&
  keys(value, ['kind', 'target']) &&
  annotationKind(value.kind) &&
  target(value.target);
const structureNode = (value: unknown): value is CanvasStructureNode =>
  record(value) &&
  keys(value, [
    'id',
    'kind',
    'target',
    'label',
    'depth',
    'position',
    'setSize',
    'occurrences',
    ...(value.parentId === undefined ? [] : ['parentId']),
    ...(value.empty === undefined ? [] : ['empty']),
  ]) &&
  id(value.id) &&
  annotationKind(value.kind) &&
  target(value.target) &&
  typeof value.label === 'string' &&
  value.label.length > 0 &&
  value.label.length <= 200 &&
  (value.parentId === undefined || id(value.parentId)) &&
  Number.isSafeInteger(value.depth) &&
  (value.depth as number) >= 1 &&
  (value.depth as number) <= 100 &&
  Number.isSafeInteger(value.position) &&
  (value.position as number) >= 1 &&
  Number.isSafeInteger(value.setSize) &&
  (value.setSize as number) >= (value.position as number) &&
  Number.isSafeInteger(value.occurrences) &&
  (value.occurrences as number) >= 1 &&
  (value.empty === undefined || typeof value.empty === 'boolean');
const structure = (value: unknown): value is CanvasStructureNode[] => {
  if (!Array.isArray(value) || value.length > 5_000 || !value.every(structureNode)) return false;
  const nodes = value as CanvasStructureNode[];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) return false;
  const siblings = new Map<string, CanvasStructureNode[]>();
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if ((node.parentId && !parent) || node.depth !== (parent ? parent.depth + 1 : 1)) return false;
    const key = node.parentId ?? '';
    const group = siblings.get(key) ?? [];
    group.push(node);
    siblings.set(key, group);
  }
  return [...siblings.values()].every(
    (group) =>
      group.every((node) => node.setSize === group.length) &&
      new Set(group.map((node) => node.position)).size === group.length &&
      group.every((node) => node.position <= group.length),
  );
};
const wireValue = (value: unknown, seen = new Set<object>()): boolean => {
  if (value == null || ['string', 'boolean', 'undefined'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  seen.add(value);
  const valid = Object.values(value).every((item) => wireValue(item, seen));
  seen.delete(value);
  return valid;
};
const textSelection = (value: unknown): value is CanvasTextSelection =>
  record(value) &&
  keys(value, value.kind === undefined ? ['anchor', 'head'] : ['kind', 'anchor', 'head']) &&
  (value.kind === undefined || value.kind === 'node' || value.kind === 'text') &&
  Number.isSafeInteger(value.anchor) &&
  (value.anchor as number) >= 0 &&
  Number.isSafeInteger(value.head) &&
  (value.head as number) >= 0;
const textHistory = (value: unknown): value is CanvasTextHistory =>
  record(value) &&
  keys(value, [
    'kind',
    ...(value.group === undefined ? [] : ['group']),
    ...(value.before === undefined ? [] : ['before']),
    ...(value.after === undefined ? [] : ['after']),
  ]) &&
  (value.kind === 'composition' ||
    value.kind === 'format' ||
    value.kind === 'paste' ||
    value.kind === 'typing') &&
  (value.group === undefined || id(value.group)) &&
  (value.before === undefined || textSelection(value.before)) &&
  (value.after === undefined || textSelection(value.after));
const textUpdate = (value: unknown): value is CanvasTextUpdate =>
  record(value) &&
  keys(value, value.selection === undefined ? ['value'] : ['value', 'selection']) &&
  typeof value.value === 'string' &&
  (value.selection === undefined || textSelection(value.selection));
const linkValue = (value: unknown): value is CanvasLinkValue =>
  record(value) &&
  keys(value, ['type', 'ref', 'href', 'label', 'newTab']) &&
  (value.type === 'entry' || value.type === 'url') &&
  typeof value.ref === 'string' &&
  typeof value.href === 'string' &&
  typeof value.label === 'string' &&
  typeof value.newTab === 'boolean';
const textField = (value: unknown): value is CanvasTextField => {
  if (!record(value) || !target(value.target)) return false;
  if (value.kind === 'link')
    return keys(value, ['target', 'value', 'kind']) && linkValue(value.value);
  return (
    keys(
      value,
      value.kind === 'richtext' ? ['target', 'value', 'kind', 'tier'] : ['target', 'value', 'kind'],
    ) &&
    typeof value.value === 'string' &&
    (value.kind === 'text' ||
      (value.kind === 'richtext' && (value.tier === 'basic' || value.tier === 'full')))
  );
};
const editingState = (value: unknown): value is CanvasEditingState =>
  record(value) &&
  keys(
    value,
    value.dragging === undefined
      ? ['inlineEditing', 'composing']
      : ['inlineEditing', 'composing', 'dragging'],
  ) &&
  typeof value.inlineEditing === 'boolean' &&
  typeof value.composing === 'boolean' &&
  (value.dragging === undefined || typeof value.dragging === 'boolean') &&
  (!value.composing || value.inlineEditing);
const interactionMode = (value: unknown): value is CanvasInteractionMode =>
  value === 'edit' || value === 'interact';
const absoluteUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) return false;
  try {
    const url = new URL(value);
    return url.protocol !== 'javascript:' && url.protocol !== 'data:';
  } catch {
    return false;
  }
};
const navigationRequest = (value: unknown): value is CanvasNavigationRequest => {
  if (!record(value)) return false;
  if (value.kind === 'link')
    return (
      keys(value, ['kind', 'href', 'newTab', 'download']) &&
      absoluteUrl(value.href) &&
      typeof value.newTab === 'boolean' &&
      typeof value.download === 'boolean'
    );
  return (
    value.kind === 'form' &&
    keys(value, ['kind', 'href', 'method']) &&
    absoluteUrl(value.href) &&
    (value.method === 'get' || value.method === 'post')
  );
};
const mutation = (value: unknown): value is CanvasMutation => {
  if (!record(value)) return false;
  if (value.type === 'history')
    return (
      keys(value, ['type', 'direction']) &&
      (value.direction === 'undo' || value.direction === 'redo')
    );
  return (
    value.type === 'field' &&
    keys(
      value,
      value.history === undefined ? ['type', 'changes'] : ['type', 'changes', 'history'],
    ) &&
    Array.isArray(value.changes) &&
    value.changes.every(
      (change) =>
        record(change) &&
        keys(change, change.path === undefined ? ['value'] : ['path', 'value']) &&
        Object.hasOwn(change, 'value') &&
        (change.path === undefined ||
          (Array.isArray(change.path) && change.path.every((part) => typeof part === 'string'))) &&
        wireValue(change.value),
    ) &&
    (value.history === undefined || textHistory(value.history))
  );
};
const identity = (
  value: Record<string, unknown>,
): value is Record<string, unknown> & CanvasIdentity =>
  Number.isSafeInteger(value.protocol) &&
  id(value.requestId) &&
  id(value.epoch) &&
  documentIdentity(value.entry) &&
  id(value.locale) &&
  Number.isSafeInteger(value.contentVersion) &&
  (value.contentVersion as number) >= 0;
const ready = (value: unknown): value is CanvasIdentity & { type: 'handover:canvas:ready' } =>
  record(value) &&
  keys(value, ['type', ...BASE]) &&
  value.type === 'handover:canvas:ready' &&
  identity(value);
const command = (value: unknown): value is CanvasCommandMessage =>
  record(value) &&
  keys(value, ['type', ...BASE, 'commandId', 'target', 'command']) &&
  value.type === 'handover:canvas:command' &&
  identity(value) &&
  id(value.commandId) &&
  target(value.target) &&
  mutation(value.command);
const acknowledgement = (value: unknown): CanvasAcknowledgement | undefined => {
  if (!record(value) || value.type !== 'handover:canvas:ack' || !identity(value)) return;
  const common = ['type', ...BASE, 'commandId', 'target', 'ok'];
  if (!id(value.commandId) || !target(value.target)) return;
  const valid =
    value.ok === true
      ? keys(
          value,
          value.update === undefined
            ? [...common, 'acceptedVersion']
            : [...common, 'acceptedVersion', 'update'],
        ) &&
        Number.isSafeInteger(value.acceptedVersion) &&
        (value.acceptedVersion as number) >= 0 &&
        (value.update === undefined || textUpdate(value.update))
      : value.ok === false &&
        keys(
          value,
          value.acceptedVersion === undefined
            ? [...common, 'reason']
            : value.update === undefined
              ? [...common, 'reason', 'acceptedVersion']
              : [...common, 'reason', 'acceptedVersion', 'update'],
        ) &&
        REFUSALS.has(value.reason as CanvasCommandRefusal) &&
        (value.acceptedVersion === undefined ||
          (Number.isSafeInteger(value.acceptedVersion) &&
            (value.acceptedVersion as number) >= 0)) &&
        (value.update === undefined || textUpdate(value.update));
  if (valid) return value as unknown as CanvasAcknowledgement;
};
const textFieldMessage = (
  value: unknown,
):
  | (CanvasIdentity & { type: 'handover:canvas:text-field'; field: CanvasTextField | null })
  | undefined => {
  if (
    record(value) &&
    keys(value, ['type', ...BASE, 'field']) &&
    value.type === 'handover:canvas:text-field' &&
    identity(value) &&
    (value.field === null || textField(value.field))
  )
    return value as unknown as CanvasIdentity & {
      type: 'handover:canvas:text-field';
      field: CanvasTextField | null;
    };
};
const editingMessage = (
  value: unknown,
):
  | (CanvasIdentity & {
      type: 'handover:canvas:editing';
      target: CanvasTarget;
      state: CanvasEditingState;
    })
  | undefined => {
  if (
    record(value) &&
    keys(value, ['type', ...BASE, 'target', 'state']) &&
    value.type === 'handover:canvas:editing' &&
    identity(value) &&
    target(value.target) &&
    editingState(value.state)
  )
    return value as unknown as CanvasIdentity & {
      type: 'handover:canvas:editing';
      target: CanvasTarget;
      state: CanvasEditingState;
    };
};
const selectionMessage = (
  value: unknown,
):
  | (CanvasIdentity & { type: 'handover:canvas:selection'; selection: CanvasSelection })
  | undefined => {
  if (
    record(value) &&
    keys(value, ['type', ...BASE, 'selection']) &&
    value.type === 'handover:canvas:selection' &&
    identity(value) &&
    selection(value.selection)
  )
    return value as unknown as CanvasIdentity & {
      type: 'handover:canvas:selection';
      selection: CanvasSelection;
    };
};
const structureMessage = (
  value: unknown,
):
  | (CanvasIdentity & { type: 'handover:canvas:structure'; nodes: CanvasStructureNode[] })
  | undefined => {
  if (
    record(value) &&
    keys(value, ['type', ...BASE, 'nodes']) &&
    value.type === 'handover:canvas:structure' &&
    identity(value) &&
    structure(value.nodes)
  )
    return value as unknown as CanvasIdentity & {
      type: 'handover:canvas:structure';
      nodes: CanvasStructureNode[];
    };
};
const actionMessage = (value: unknown): CanvasActionMessage | undefined => {
  if (
    record(value) &&
    keys(
      value,
      value.action === 'move'
        ? ['type', ...BASE, 'action', 'selection', 'destination']
        : ['type', ...BASE, 'action', 'selection'],
    ) &&
    value.type === 'handover:canvas:action' &&
    identity(value) &&
    blockAction(value.action) &&
    selection(value.selection) &&
    (value.action !== 'move' || selection(value.destination))
  )
    return value as unknown as CanvasActionMessage;
};
const navigationMessage = (value: unknown): CanvasNavigationMessage | undefined => {
  if (
    record(value) &&
    keys(
      value,
      value.kind === 'link'
        ? ['type', ...BASE, 'kind', 'href', 'newTab', 'download']
        : ['type', ...BASE, 'kind', 'href', 'method'],
    ) &&
    value.type === 'handover:canvas:navigate' &&
    identity(value) &&
    navigationRequest(
      value.kind === 'link'
        ? {
            kind: value.kind,
            href: value.href,
            newTab: value.newTab,
            download: value.download,
          }
        : { kind: value.kind, href: value.href, method: value.method },
    )
  )
    return value as unknown as CanvasNavigationMessage;
};
const actionCapabilityMessage = (
  value: unknown,
): (CanvasIdentity & { type: 'handover:canvas:actions' } & CanvasActionCapability) | undefined => {
  if (
    record(value) &&
    keys(value, ['type', ...BASE, 'selection', 'actions']) &&
    value.type === 'handover:canvas:actions' &&
    identity(value) &&
    selection(value.selection) &&
    Array.isArray(value.actions) &&
    value.actions.length <= 11 &&
    value.actions.every(blockAction) &&
    new Set(value.actions).size === value.actions.length
  )
    return value as unknown as CanvasIdentity & {
      type: 'handover:canvas:actions';
    } & CanvasActionCapability;
};
const selectMessage = (
  value: unknown,
):
  | (CanvasIdentity & {
      type: 'handover:canvas:select';
      selection: CanvasSelection;
      scroll?: boolean;
    })
  | undefined => {
  if (
    record(value) &&
    keys(value, [
      'type',
      ...BASE,
      'selection',
      ...(value.scroll === undefined ? [] : ['scroll']),
    ]) &&
    value.type === 'handover:canvas:select' &&
    identity(value) &&
    selection(value.selection) &&
    (value.scroll === undefined || typeof value.scroll === 'boolean')
  )
    return value as unknown as CanvasIdentity & {
      type: 'handover:canvas:select';
      selection: CanvasSelection;
      scroll?: boolean;
    };
};
const modeMessage = (
  value: unknown,
): (CanvasIdentity & { type: 'handover:canvas:mode'; mode: CanvasInteractionMode }) | undefined => {
  if (
    record(value) &&
    keys(value, ['type', ...BASE, 'mode']) &&
    value.type === 'handover:canvas:mode' &&
    identity(value) &&
    interactionMode(value.mode)
  )
    return value as unknown as CanvasIdentity & {
      type: 'handover:canvas:mode';
      mode: CanvasInteractionMode;
    };
};

const copyDocument = (value: CanvasDocumentIdentity): CanvasDocumentIdentity => ({
  collection: value.collection,
  id: value.id,
});
const copyLocation = (value: CanvasLocation): CanvasLocation => ({
  document: copyDocument(value.document),
  locale: value.locale,
  address: value.address,
});
const copyTarget = (value: CanvasTarget): CanvasTarget => ({
  ...copyLocation(value),
  ...(value.occurrence ? { occurrence: copyLocation(value.occurrence) } : {}),
});
const copySelection = (value: CanvasSelection): CanvasSelection => ({
  kind: value.kind,
  target: copyTarget(value.target),
});
const copyTextField = (value: CanvasTextField): CanvasTextField =>
  value.kind === 'richtext'
    ? {
        kind: value.kind,
        target: copyTarget(value.target),
        value: value.value,
        tier: value.tier,
      }
    : value.kind === 'link'
      ? { kind: value.kind, target: copyTarget(value.target), value: { ...value.value } }
      : { kind: value.kind, target: copyTarget(value.target), value: value.value };
const base = (manifest: CanvasSuccessManifest, contentVersion: number) => ({
  protocol: CANVAS_PROTOCOL,
  requestId: manifest.requestId,
  epoch: manifest.epoch,
  entry: copyDocument(manifest.entry),
  locale: manifest.locale,
  contentVersion,
});
const stale = (
  message: CanvasIdentity,
  manifest: CanvasSuccessManifest,
  version: number,
): CanvasTransportRefusal | undefined => {
  if (message.protocol !== CANVAS_PROTOCOL) return 'protocol';
  if (message.requestId !== manifest.requestId) return 'stale-request';
  if (message.epoch !== manifest.epoch) return 'stale-epoch';
  if (!sameCanvasDocument(message.entry, manifest.entry)) return 'stale-document';
  if (message.locale !== manifest.locale) return 'stale-locale';
  if (message.contentVersion !== version) return 'stale-version';
};

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
  const completed = new Map<
    string,
    { fingerprint: string; reply: Promise<CanvasAcknowledgement> }
  >();
  let connected = false;
  let disposed = false;
  let replyPort: MessagePort | undefined;
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
    const readyMessage = ready(event.data);
    const commandMessage = command(event.data);
    const selectedMessage = selectionMessage(event.data);
    const inventoryMessage = structureMessage(event.data);
    const requestedAction = actionMessage(event.data);
    const requestedNavigation = navigationMessage(event.data);
    const editing = editingMessage(event.data);
    if (
      !readyMessage &&
      !commandMessage &&
      !selectedMessage &&
      !inventoryMessage &&
      !requestedAction &&
      !requestedNavigation &&
      !editing
    )
      return reject('malformed', event.data);
    if (readyMessage) {
      const message = event.data as CanvasIdentity & { type: 'handover:canvas:ready' };
      const reason = stale(message, manifest, options.contentVersion());
      if (reason) return reject(reason, message);
      if (connected) return;
      replyPort = event.ports?.[0];
      replyPort?.start();
      connected = true;
      options.onReady?.();
      return;
    }
    if (selectedMessage) {
      const reason = stale(selectedMessage, manifest, options.contentVersion());
      if (reason) return reject(reason, selectedMessage);
      if (!connected) return reject('not-ready', selectedMessage);
      options.onSelection?.(selectedMessage.selection);
      return;
    }
    if (inventoryMessage) {
      const message = inventoryMessage;
      const reason = stale(message, manifest, options.contentVersion());
      if (reason) return reject(reason, message);
      if (!connected) return reject('not-ready', message);
      options.onStructure?.(message.nodes);
      return;
    }
    if (requestedAction) {
      const reason = stale(requestedAction, manifest, options.contentVersion());
      if (reason) return reject(reason, requestedAction);
      if (!connected) return reject('not-ready', requestedAction);
      const current = options.currentTarget();
      if (!current || !sameCanvasTarget(requestedAction.selection.target, current))
        return reject('stale-target', requestedAction);
      options.onAction?.(requestedAction);
      return;
    }
    if (requestedNavigation) {
      const reason = stale(requestedNavigation, manifest, options.contentVersion());
      if (reason) return reject(reason, requestedNavigation);
      if (!connected) return reject('not-ready', requestedNavigation);
      options.onNavigate?.(requestedNavigation);
      return;
    }
    if (editing) {
      const reason = stale(editing, manifest, options.contentVersion());
      if (reason) return reject(reason, editing);
      if (!connected) return reject('not-ready', editing);
      const current = options.currentTarget();
      if (!current || !sameCanvasTarget(editing.target, current))
        return reject('stale-target', editing);
      options.onEditing?.(editing.target, editing.state);
      return;
    }
    const message = event.data as CanvasCommandMessage;
    const identityReason = stale(message, manifest, message.contentVersion);
    if (identityReason) return refusal(message, identityReason);
    const fingerprint = JSON.stringify(message);
    const prior = completed.get(message.commandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return refusal(message, 'duplicate-command');
      void prior.reply.then(post);
      return;
    }
    const reason = stale(message, manifest, options.contentVersion());
    if (reason) return refusal(message, reason);
    const current = options.currentTarget();
    if (!current || !sameCanvasTarget(message.target, current))
      return refusal(message, 'stale-target');
    if (!connected) return refusal(message, 'not-ready');

    const reply = Promise.resolve()
      .then(() => options.onCommand(message))
      .then<CanvasAcknowledgement>((result) => {
        if (
          !record(result) ||
          typeof result.ok !== 'boolean' ||
          (result.ok
            ? !Number.isSafeInteger(result.contentVersion) || result.contentVersion < 0
            : !REFUSALS.has(result.reason))
        )
          throw new Error('Invalid Canvas command result');
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
    completed.set(message.commandId, { fingerprint, reply });
    if (completed.size > 500) completed.delete(completed.keys().next().value as string);
    void reply.then(post);
  };
  if (options.listen !== false) owner.addEventListener('message', receive);
  return {
    connected: () => connected && !disposed,
    receive,
    select(value: CanvasSelection, settings: { scroll?: boolean } = {}) {
      if (disposed || !connected || !selection(value)) return false;
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
      if (disposed || !connected || (value !== undefined && !textField(value))) return false;
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
      if (
        disposed ||
        !connected ||
        !selection(value) ||
        actions.length > 11 ||
        !actions.every(blockAction) ||
        new Set(actions).size !== actions.length
      )
        return false;
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
      if (disposed || !connected || !interactionMode(value)) return false;
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
    dispose: () => {
      disposed = true;
      connected = false;
      owner.removeEventListener('message', receive);
      replyPort?.close();
      replyPort = undefined;
      completed.clear();
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
}

export function createCanvasChildBridge(options: CanvasChildBridgeOptions) {
  const { manifest, parent, origin } = options;
  const owner = options.owner ?? window;
  const pending = new Map<
    string,
    { version: number; target: CanvasTarget; resolve: (reply: CanvasAcknowledgement) => void }
  >();
  let version = manifest.contentVersion;
  let started = false;
  let disposed = false;
  let replyPort: MessagePort | undefined;
  let deferredField: NonNullable<ReturnType<typeof textFieldMessage>> | undefined;
  const applyField = (message: NonNullable<ReturnType<typeof textFieldMessage>>) => {
    if (message.contentVersion < version) return;
    version = message.contentVersion;
    options.onTextField?.(message.field ?? undefined);
  };
  const acceptReply = (value: unknown) => {
    const reply = acknowledgement(value);
    const held = reply && pending.get(reply.commandId);
    if (
      !reply ||
      !held ||
      reply.protocol !== CANVAS_PROTOCOL ||
      stale(reply, manifest, held.version) ||
      !sameCanvasTarget(reply.target, held.target)
    )
      return;
    pending.delete(reply.commandId);
    if (reply.ok) version = reply.acceptedVersion;
    else if (reply.acceptedVersion !== undefined) version = reply.acceptedVersion;
    if (!pending.size && deferredField) {
      const message = deferredField;
      deferredField = undefined;
      applyField(message);
    }
    held.resolve(reply);
  };
  const receive = (event: MessageEvent) => {
    if (disposed || event.origin !== origin || event.source !== parent) return;
    const requested = selectMessage(event.data);
    const configured = textFieldMessage(event.data);
    const configuredActions = actionCapabilityMessage(event.data);
    const configuredMode = modeMessage(event.data);
    if (requested) {
      if (!stale(requested, manifest, version))
        options.onSelect?.(requested.selection, { scroll: requested.scroll !== false });
      return;
    }
    if (configured) {
      const identityReason = stale(configured, manifest, configured.contentVersion);
      if (identityReason || configured.contentVersion < version) return;
      if (pending.size) {
        if (!deferredField || configured.contentVersion >= deferredField.contentVersion)
          deferredField = configured;
        return;
      }
      applyField(configured);
      return;
    }
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
      if (!started || disposed || !selection(value)) return false;
      parent.postMessage(
        { ...base(manifest, version), type: 'handover:canvas:selection', selection: value },
        origin,
      );
      return true;
    },
    structure(nodes: CanvasStructureNode[]) {
      if (!started || disposed || !structure(nodes)) return false;
      parent.postMessage(
        { ...base(manifest, version), type: 'handover:canvas:structure', nodes },
        origin,
      );
      return true;
    },
    action(action: CanvasBlockAction, selected: CanvasSelection, destination?: CanvasSelection) {
      if (!started || disposed || !blockAction(action) || !selection(selected)) return false;
      if (
        (action === 'move' && !selection(destination)) ||
        (action !== 'move' && destination !== undefined)
      )
        return false;
      parent.postMessage(
        {
          ...base(manifest, version),
          type: 'handover:canvas:action',
          action,
          selection: selected,
          ...(action === 'move' ? { destination } : {}),
        },
        origin,
      );
      return true;
    },
    command(targetValue: CanvasTarget, change: CanvasMutation) {
      if (!started || disposed) throw new Error('Canvas bridge is not connected.');
      if (!target(targetValue) || !mutation(change))
        throw new Error('Canvas command is malformed.');
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
      if (!started || disposed || !target(targetValue) || !editingState(state)) return false;
      parent.postMessage(
        {
          ...base(manifest, version),
          type: 'handover:canvas:editing',
          target: targetValue,
          state,
        },
        origin,
      );
      return true;
    },
    navigate(request: CanvasNavigationRequest) {
      if (!started || disposed || !navigationRequest(request)) return false;
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
      deferredField = undefined;
      for (const [commandId, held] of pending)
        held.resolve({
          ...base(manifest, held.version),
          type: 'handover:canvas:ack',
          commandId,
          target: held.target,
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
      !keys(value.error, ['status', 'message']) ||
      !Number.isSafeInteger(value.error.status) ||
      (value.error.status as number) < 400 ||
      (value.error.status as number) > 599 ||
      typeof value.error.message !== 'string'
    )
      return;
    return value as unknown as CanvasErrorManifest;
  } catch {
    return undefined;
  }
}
