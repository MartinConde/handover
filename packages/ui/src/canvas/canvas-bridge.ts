import { isUiLocale, type RichtextTier, type UiLocale } from '@handover/core';
import type { FieldCommandFailure } from '../editor/entry-session.svelte';
import { sameCanvasDocument, sameCanvasTarget } from './canvas-target';
import type { CanvasInteractionMode, CanvasNavigationRequest } from './runtime/canvas-navigation';

export const CANVAS_PROTOCOL = 1 as const;
/** Maximum UTF-16 code units in a complete Canvas field address. */
export const CANVAS_ADDRESS_LIMIT = 4_096;
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
  | 'inspect'
  | 'move'
  | 'move-down'
  | 'move-up'
  | 'edit-media'
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
  container?: boolean;
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
export interface CanvasUiLocaleMessage extends CanvasIdentity {
  type: 'handover:canvas:ui-locale';
  uiLocale: UiLocale;
}
export interface CanvasAnchor {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface CanvasActionMessage extends CanvasIdentity {
  type: 'handover:canvas:action';
  action: CanvasBlockAction;
  selection: CanvasSelection;
  /** Viewport bounds of the clicked image in the child frame. */
  anchor?: CanvasAnchor;
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
const keys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const address = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= CANVAS_ADDRESS_LIMIT;
const documentIdentity = (value: unknown): value is CanvasDocumentIdentity =>
  record(value) && keys(value, ['collection', 'id']) && id(value.collection) && id(value.id);
const location = (value: unknown): value is CanvasLocation =>
  record(value) &&
  keys(value, ['document', 'locale', 'address']) &&
  documentIdentity(value.document) &&
  id(value.locale) &&
  address(value.address);
const target = (value: unknown): value is CanvasTarget =>
  record(value) &&
  keys(value, ['document', 'locale', 'address'], ['occurrence']) &&
  documentIdentity(value.document) &&
  id(value.locale) &&
  address(value.address) &&
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
  value === 'inspect' ||
  value === 'move' ||
  value === 'move-down' ||
  value === 'move-up' ||
  value === 'edit-media' ||
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
  keys(
    value,
    ['id', 'kind', 'target', 'label', 'depth', 'position', 'setSize', 'occurrences'],
    ['parentId', 'empty', 'container'],
  ) &&
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
  (value.empty === undefined || typeof value.empty === 'boolean') &&
  (value.container === undefined || typeof value.container === 'boolean');
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
  keys(value, ['anchor', 'head'], ['kind']) &&
  (value.kind === undefined || value.kind === 'node' || value.kind === 'text') &&
  count(value.anchor) &&
  count(value.head);
const textHistory = (value: unknown): value is CanvasTextHistory =>
  record(value) &&
  keys(value, ['kind'], ['group', 'before', 'after']) &&
  (value.kind === 'composition' ||
    value.kind === 'format' ||
    value.kind === 'paste' ||
    value.kind === 'typing') &&
  (value.group === undefined || id(value.group)) &&
  (value.before === undefined || textSelection(value.before)) &&
  (value.after === undefined || textSelection(value.after));
const textUpdate = (value: unknown): value is CanvasTextUpdate =>
  record(value) &&
  keys(value, ['value'], ['selection']) &&
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
const textField = (value: unknown): value is CanvasTextField =>
  record(value) &&
  keys(value, ['kind', 'target', 'value'], ['tier']) &&
  target(value.target) &&
  (value.kind === 'link'
    ? value.tier === undefined && linkValue(value.value)
    : typeof value.value === 'string' &&
      (value.kind === 'text'
        ? value.tier === undefined
        : value.kind === 'richtext' && (value.tier === 'basic' || value.tier === 'full')));
const editingState = (value: unknown): value is CanvasEditingState =>
  record(value) &&
  keys(value, ['inlineEditing', 'composing'], ['dragging']) &&
  typeof value.inlineEditing === 'boolean' &&
  typeof value.composing === 'boolean' &&
  (value.dragging === undefined || typeof value.dragging === 'boolean') &&
  (!value.composing || value.inlineEditing);
const absoluteUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) return false;
  try {
    const url = new URL(value);
    return url.protocol !== 'javascript:' && url.protocol !== 'data:';
  } catch {
    return false;
  }
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
    keys(value, ['type', 'changes'], ['history']) &&
    Array.isArray(value.changes) &&
    value.changes.every(
      (change) =>
        record(change) &&
        keys(change, ['value'], ['path']) &&
        (change.path === undefined ||
          (Array.isArray(change.path) && change.path.every((part) => typeof part === 'string'))) &&
        wireValue(change.value),
    ) &&
    (value.history === undefined || textHistory(value.history))
  );
};
const canvasAnchor = (value: unknown): value is CanvasAnchor =>
  record(value) &&
  keys(value, ['left', 'top', 'width', 'height']) &&
  Object.values(value).every((part) => typeof part === 'number' && Number.isFinite(part)) &&
  (value.width as number) >= 0 &&
  (value.height as number) >= 0;
const identity = (
  value: Record<string, unknown>,
): value is Record<string, unknown> & CanvasIdentity =>
  Number.isSafeInteger(value.protocol) &&
  id(value.requestId) &&
  id(value.epoch) &&
  documentIdentity(value.entry) &&
  id(value.locale) &&
  count(value.contentVersion);

type Envelope<Type extends string, Body = unknown> = CanvasIdentity & {
  type: `handover:canvas:${Type}`;
} & Body;
type ReadyMessage = Envelope<'ready'>;
type TextFieldMessage = Envelope<'text-field', { field: CanvasTextField | null }>;
type EditingMessage = Envelope<
  'editing',
  { target: CanvasTarget; state: CanvasEditingState; interactionId?: string }
>;
type SelectionMessage = Envelope<'selection', { selection: CanvasSelection }>;
type StructureMessage = Envelope<'structure', { nodes: CanvasStructureNode[] }>;
type ActionsMessage = Envelope<'actions', CanvasActionCapability>;
type SelectMessage = Envelope<'select', { selection: CanvasSelection; scroll?: boolean }>;
type ModeMessage = Envelope<'mode', { mode: CanvasInteractionMode }>;
type CanvasProblemsMessage = Envelope<'problems', { addresses: string[] }>;

const envelope = <T extends { type: string }>(
  value: unknown,
  type: T['type'],
  required: readonly string[],
  optional: readonly string[],
  valid: (value: Record<string, unknown>) => boolean,
): T | undefined => {
  if (
    record(value) &&
    value.type === type &&
    keys(value, ['type', ...BASE, ...required], optional) &&
    identity(value) &&
    valid(value)
  )
    return value as unknown as T;
};
const ready = (value: unknown) =>
  envelope<ReadyMessage>(value, 'handover:canvas:ready', [], [], () => true);
const command = (value: unknown) =>
  envelope<CanvasCommandMessage>(
    value,
    'handover:canvas:command',
    ['commandId', 'target', 'command'],
    [],
    (message) => id(message.commandId) && target(message.target) && mutation(message.command),
  );
const acknowledgement = (value: unknown) =>
  envelope<CanvasAcknowledgement>(
    value,
    'handover:canvas:ack',
    ['commandId', 'target', 'ok'],
    ['acceptedVersion', 'reason', 'update'],
    (message) =>
      id(message.commandId) &&
      target(message.target) &&
      (message.acceptedVersion === undefined || count(message.acceptedVersion)) &&
      (message.update === undefined || textUpdate(message.update)) &&
      (message.ok === true
        ? message.acceptedVersion !== undefined && message.reason === undefined
        : message.ok === false &&
          REFUSALS.has(message.reason as CanvasCommandRefusal) &&
          (message.update === undefined || message.acceptedVersion !== undefined)),
  );
const textFieldMessage = (value: unknown) =>
  envelope<TextFieldMessage>(
    value,
    'handover:canvas:text-field',
    ['field'],
    [],
    (message) => message.field === null || textField(message.field),
  );
const editingMessage = (value: unknown) =>
  envelope<EditingMessage>(
    value,
    'handover:canvas:editing',
    ['target', 'state'],
    ['interactionId'],
    (message) =>
      target(message.target) &&
      editingState(message.state) &&
      (message.interactionId === undefined || id(message.interactionId)),
  );
const selectionMessage = (value: unknown) =>
  envelope<SelectionMessage>(value, 'handover:canvas:selection', ['selection'], [], (message) =>
    selection(message.selection),
  );
const structureMessage = (value: unknown) =>
  envelope<StructureMessage>(value, 'handover:canvas:structure', ['nodes'], [], (message) =>
    structure(message.nodes),
  );
const actionMessage = (value: unknown) =>
  envelope<CanvasActionMessage>(
    value,
    'handover:canvas:action',
    ['action', 'selection'],
    ['destination', 'anchor'],
    (message) =>
      blockAction(message.action) &&
      selection(message.selection) &&
      (message.action === 'move'
        ? selection(message.destination)
        : message.destination === undefined) &&
      (message.action === 'edit-media'
        ? canvasAnchor(message.anchor)
        : message.anchor === undefined),
  );
const navigationMessage = (value: unknown) =>
  envelope<CanvasNavigationMessage>(
    value,
    'handover:canvas:navigate',
    ['kind', 'href'],
    ['newTab', 'download', 'method'],
    (message) =>
      absoluteUrl(message.href) &&
      (message.kind === 'link'
        ? typeof message.newTab === 'boolean' &&
          typeof message.download === 'boolean' &&
          message.method === undefined
        : message.kind === 'form' &&
          (message.method === 'get' || message.method === 'post') &&
          message.newTab === undefined &&
          message.download === undefined),
  );
const actionCapabilityMessage = (value: unknown) =>
  envelope<ActionsMessage>(
    value,
    'handover:canvas:actions',
    ['selection', 'actions'],
    [],
    (message) =>
      selection(message.selection) &&
      Array.isArray(message.actions) &&
      message.actions.every(blockAction) &&
      new Set(message.actions).size === message.actions.length,
  );
const selectMessage = (value: unknown) =>
  envelope<SelectMessage>(
    value,
    'handover:canvas:select',
    ['selection'],
    ['scroll'],
    (message) =>
      selection(message.selection) &&
      (message.scroll === undefined || typeof message.scroll === 'boolean'),
  );
const modeMessage = (value: unknown) =>
  envelope<ModeMessage>(
    value,
    'handover:canvas:mode',
    ['mode'],
    [],
    (message) => message.mode === 'edit' || message.mode === 'interact',
  );
const problemsMessage = (value: unknown) =>
  envelope<CanvasProblemsMessage>(
    value,
    'handover:canvas:problems',
    ['addresses'],
    [],
    (message) => Array.isArray(message.addresses) && message.addresses.every(address),
  );
const uiLocaleMessage = (value: unknown) =>
  envelope<CanvasUiLocaleMessage>(value, 'handover:canvas:ui-locale', ['uiLocale'], [], (message) =>
    isUiLocale(message.uiLocale),
  );

const childMessage = (value: unknown) => {
  switch (record(value) && value.type) {
    case 'handover:canvas:ready':
      return ready(value);
    case 'handover:canvas:command':
      return command(value);
    case 'handover:canvas:selection':
      return selectionMessage(value);
    case 'handover:canvas:structure':
      return structureMessage(value);
    case 'handover:canvas:action':
      return actionMessage(value);
    case 'handover:canvas:navigate':
      return navigationMessage(value);
    case 'handover:canvas:editing':
      return editingMessage(value);
  }
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
