import { isUiLocale, type RichtextTier, type UiLocale } from '@handover/core';
import type { FieldCommandFailure } from '../editor/entry-session.svelte';
import { isRecord } from '../request.js';
import { sameCanvasDocument } from './canvas-target';

export const CANVAS_PROTOCOL = 1 as const;
/** Maximum UTF-16 code units in a complete Canvas field address. */
export const CANVAS_ADDRESS_LIMIT = 4_096;
export type CanvasInteractionMode = 'edit' | 'interact' | 'select';

export type CanvasNavigationRequest =
  | {
      kind: 'link';
      href: string;
      newTab: boolean;
      download: boolean;
    }
  | {
      kind: 'form';
      href: string;
      method: 'get' | 'post';
    };
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
export interface CanvasIdentity {
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
  error: { status: number; message: string; code?: string; detail?: string };
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
type CanvasTransportRefusal =
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
export const BASE = ['protocol', 'requestId', 'epoch', 'entry', 'locale', 'contentVersion'];
export const keys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
export const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
export const address = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= CANVAS_ADDRESS_LIMIT;
const documentIdentity = (value: unknown): value is CanvasDocumentIdentity =>
  isRecord(value) && keys(value, ['collection', 'id']) && id(value.collection) && id(value.id);
const location = (value: unknown): value is CanvasLocation =>
  isRecord(value) &&
  keys(value, ['document', 'locale', 'address']) &&
  documentIdentity(value.document) &&
  id(value.locale) &&
  address(value.address);
export const isCanvasTarget = (value: unknown): value is CanvasTarget =>
  isRecord(value) &&
  keys(value, ['document', 'locale', 'address'], ['occurrence']) &&
  documentIdentity(value.document) &&
  id(value.locale) &&
  address(value.address) &&
  (value.occurrence === undefined || location(value.occurrence));
const annotationKind = (value: unknown): value is CanvasAnnotationKind =>
  value === 'field' || value === 'list' || value === 'block';
export const blockAction = (value: unknown): value is CanvasBlockAction =>
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
export const selection = (value: unknown): value is CanvasSelection =>
  isRecord(value) &&
  keys(value, ['kind', 'target']) &&
  annotationKind(value.kind) &&
  isCanvasTarget(value.target);
const structureNode = (value: unknown): value is CanvasStructureNode =>
  isRecord(value) &&
  keys(
    value,
    ['id', 'kind', 'target', 'label', 'depth', 'position', 'setSize', 'occurrences'],
    ['parentId', 'empty', 'container'],
  ) &&
  id(value.id) &&
  annotationKind(value.kind) &&
  isCanvasTarget(value.target) &&
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
  isRecord(value) &&
  keys(value, ['anchor', 'head'], ['kind']) &&
  (value.kind === undefined || value.kind === 'node' || value.kind === 'text') &&
  count(value.anchor) &&
  count(value.head);
const textHistory = (value: unknown): value is CanvasTextHistory =>
  isRecord(value) &&
  keys(value, ['kind'], ['group', 'before', 'after']) &&
  (value.kind === 'composition' ||
    value.kind === 'format' ||
    value.kind === 'paste' ||
    value.kind === 'typing') &&
  (value.group === undefined || id(value.group)) &&
  (value.before === undefined || textSelection(value.before)) &&
  (value.after === undefined || textSelection(value.after));
const textUpdate = (value: unknown): value is CanvasTextUpdate =>
  isRecord(value) &&
  keys(value, ['value'], ['selection']) &&
  typeof value.value === 'string' &&
  (value.selection === undefined || textSelection(value.selection));
const linkValue = (value: unknown): value is CanvasLinkValue =>
  isRecord(value) &&
  keys(value, ['type', 'ref', 'href', 'label', 'newTab']) &&
  (value.type === 'entry' || value.type === 'url') &&
  typeof value.ref === 'string' &&
  typeof value.href === 'string' &&
  typeof value.label === 'string' &&
  typeof value.newTab === 'boolean';
const textField = (value: unknown): value is CanvasTextField =>
  isRecord(value) &&
  keys(value, ['kind', 'target', 'value'], ['tier']) &&
  isCanvasTarget(value.target) &&
  (value.kind === 'link'
    ? value.tier === undefined && linkValue(value.value)
    : typeof value.value === 'string' &&
      (value.kind === 'text'
        ? value.tier === undefined
        : value.kind === 'richtext' && (value.tier === 'basic' || value.tier === 'full')));
const editingState = (value: unknown): value is CanvasEditingState =>
  isRecord(value) &&
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
  if (!isRecord(value)) return false;
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
        isRecord(change) &&
        keys(change, ['value'], ['path']) &&
        (change.path === undefined ||
          (Array.isArray(change.path) && change.path.every((part) => typeof part === 'string'))) &&
        wireValue(change.value),
    ) &&
    (value.history === undefined || textHistory(value.history))
  );
};
export const canvasAnchor = (value: unknown): value is CanvasAnchor =>
  isRecord(value) &&
  keys(value, ['left', 'top', 'width', 'height']) &&
  Object.values(value).every((part) => typeof part === 'number' && Number.isFinite(part)) &&
  (value.width as number) >= 0 &&
  (value.height as number) >= 0;
export const identity = (
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
export type TextFieldMessage = Envelope<'text-field', { field: CanvasTextField | null }>;
type EditingMessage = Envelope<
  'editing',
  { target: CanvasTarget; state: CanvasEditingState; interactionId?: string }
>;
type SelectionMessage = Envelope<'selection', { selection: CanvasSelection }>;
type StructureMessage = Envelope<'structure', { nodes: CanvasStructureNode[] }>;
type ActionsMessage = Envelope<'actions', CanvasActionCapability>;
type SelectMessage = Envelope<'select', { selection: CanvasSelection; scroll?: boolean }>;
type ModeMessage = Envelope<'mode', { mode: CanvasInteractionMode }>;
export type CanvasProblemsMessage = Envelope<'problems', { addresses: string[] }>;

const envelope = <T extends { type: string }>(
  value: unknown,
  type: T['type'],
  required: readonly string[],
  optional: readonly string[],
  valid: (value: Record<string, unknown>) => boolean,
): T | undefined => {
  if (
    isRecord(value) &&
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
    (message) =>
      id(message.commandId) && isCanvasTarget(message.target) && mutation(message.command),
  );
export const acknowledgement = (value: unknown) =>
  envelope<CanvasAcknowledgement>(
    value,
    'handover:canvas:ack',
    ['commandId', 'target', 'ok'],
    ['acceptedVersion', 'reason', 'update'],
    (message) =>
      id(message.commandId) &&
      isCanvasTarget(message.target) &&
      (message.acceptedVersion === undefined || count(message.acceptedVersion)) &&
      (message.update === undefined || textUpdate(message.update)) &&
      (message.ok === true
        ? message.acceptedVersion !== undefined && message.reason === undefined
        : message.ok === false &&
          REFUSALS.has(message.reason as CanvasCommandRefusal) &&
          (message.update === undefined || message.acceptedVersion !== undefined)),
  );
export const textFieldMessage = (value: unknown) =>
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
      isCanvasTarget(message.target) &&
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
export const actionCapabilityMessage = (value: unknown) =>
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
export const selectMessage = (value: unknown) =>
  envelope<SelectMessage>(
    value,
    'handover:canvas:select',
    ['selection'],
    ['scroll'],
    (message) =>
      selection(message.selection) &&
      (message.scroll === undefined || typeof message.scroll === 'boolean'),
  );
export const modeMessage = (value: unknown) =>
  envelope<ModeMessage>(
    value,
    'handover:canvas:mode',
    ['mode'],
    [],
    (message) =>
      message.mode === 'edit' || message.mode === 'interact' || message.mode === 'select',
  );
export const problemsMessage = (value: unknown) =>
  envelope<CanvasProblemsMessage>(
    value,
    'handover:canvas:problems',
    ['addresses'],
    [],
    (message) => Array.isArray(message.addresses) && message.addresses.every(address),
  );
export const uiLocaleMessage = (value: unknown) =>
  envelope<CanvasUiLocaleMessage>(value, 'handover:canvas:ui-locale', ['uiLocale'], [], (message) =>
    isUiLocale(message.uiLocale),
  );

export const childMessage = (value: unknown) => {
  switch (isRecord(value) && value.type) {
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
export const copySelection = (value: CanvasSelection): CanvasSelection => ({
  kind: value.kind,
  target: copyTarget(value.target),
});
export const copyTextField = (value: CanvasTextField): CanvasTextField =>
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
export const base = (manifest: CanvasSuccessManifest, contentVersion: number) => ({
  protocol: CANVAS_PROTOCOL,
  requestId: manifest.requestId,
  epoch: manifest.epoch,
  entry: copyDocument(manifest.entry),
  locale: manifest.locale,
  contentVersion,
});
export const stale = (
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
    if (!isRecord(value) || value.mode !== 'canvas' || value.protocol !== CANVAS_PROTOCOL) return;
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
    if (value.status !== 'error' || !isRecord(value.error)) return;
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
