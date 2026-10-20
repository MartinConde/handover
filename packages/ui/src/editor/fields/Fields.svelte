<script lang="ts">
import { KeyboardSensor, PointerSensor, type Sensors } from '@dnd-kit/dom';
import { type DragDropEventHandlers, DragDropProvider } from '@dnd-kit/svelte';
import { createSortable, isSortable } from '@dnd-kit/svelte/sortable';
import {
  type EmbedRefusalReason,
  type Field,
  type Form,
  fieldAddress,
  labelIn,
  newId,
  type ResolvedSeo,
  type Translation,
  type WordPart,
} from '@handover/core';
import type { Snippet } from 'svelte';
import Menus, { type Menu } from '../../content/Menus.svelte';
import PagePicker from '../../content/PagePicker.svelte';
import { EMPTY_ENTRY_DIRECTORY, type Pickable, readEntryDirectory } from '../../entry-directory.js';
import type { UiLocale } from '../../i18n.js';
import { capitalise, formatFieldTime, messageOptions } from '../../i18n.js';
import Focal from '../../media/Focal.svelte';
import Media from '../../media/Media.svelte';
import type { MediaItem } from '../../media/upload.js';
import * as m from '../../paraglide/messages.js';
import MediaImage from '../../shared/MediaImage.svelte';
import Modal from '../../shared/Modal.svelte';
import type {
  EntrySession,
  FieldChange,
  FieldCommandResult,
  FieldHistory,
  ListCommandResult,
  ListOperation,
} from '../entry-session.svelte';
import EmbedField from './EmbedField.svelte';
import Fields from './Fields.svelte';
import FileField from './FileField.svelte';
import { aspect, centred, type Data, type FieldLevel, readFrom, stored } from './field-level.js';
import ImageCard from './ImageCard.svelte';
import ImageField from './ImageField.svelte';
import LinkField from './LinkField.svelte';
import PerLanguageInput from './PerLanguageInput.svelte';
import ReferencePeek, { type Reference } from './ReferencePeek.svelte';
import RichText from './RichText.svelte';
import SeoField from './SeoField.svelte';
import TextField from './TextField.svelte';

let {
  fields,
  root = $bindable(),
  path = [],
  blocks = {},
  blockLabels = {},
  problems = {},
  rowLabel = '',
  translating = false,
  machine = [],
  ontranslate,
  sourceChanged = {},
  dismissed = $bindable([]),
  sourceLabel = '',
  translatedAt = '',
  onretranslate,
  inherited = true,
  prefix = 'f',
  mediaBase = '',
  locale = '',
  uiLocale = 'en',
  inheritedSeo,
  site,
  servedAt,
  session,
  oncommand,
  onreveal,
  openMediaPicker = 0,
  viewRoot,
  structureLocked = false,
  textOnly = false,
  reference,
  afterTitle,
  titleKey = 'title',
}: {
  fields: readonly Field[];
  root: Data;
  path?: readonly string[];
  /** Fields per block type, keyed as `formOf` returns them. */
  blocks?: Record<string, Field[]>;
  /** What a block type is called, where its schema names it. */
  blockLabels?: Form['blockLabels'];
  /** What the collection schema will not accept, by the same dotted path the ids use. */
  problems?: Record<string, string>;
  /** Names a field whose own path is empty — one scalar row of an array. */
  rowLabel?: string;
  /** This is a language the entry is translated into: it owns its words and nothing else. */
  translating?: boolean;
  /** The paths a machine's words are still standing at — the file's `_machine`. */
  machine?: string[];
  /** Translate one field from the source language; absent when the site has nothing to do it. */
  ontranslate?: (path: string) => void;
  /** What the source language changed since translation, by the address `machine` uses. */
  sourceChanged?: Record<string, WordPart[]>;
  /** Markers the reader has waved away; the pane owns the list so its to-do agrees with it. */
  dismissed?: string[];
  /** What that language is called, for the two lines the marker opens. */
  sourceLabel?: string;
  /** When somebody translated this file — the older line's timestamp. */
  translatedAt?: string;
  /** Translate this one field again, from the source as it reads now. */
  onretranslate?: (path: string) => void;
  /** The translation mode the fields inherit — a group hands its own down. */
  inherited?: Translation;
  /** What the field ids start with; two forms on one screen cannot share it. */
  prefix?: string;
  /** Where a stored media key is served from; without it a thumbnail has no source. */
  mediaBase?: string;
  /** The language this column writes: what a link typed into rich text has to point at. */
  locale?: string;
  uiLocale?: UiLocale;
  /** Resolved by the build's own `resolveSeo`, so the greyed value and the emitted tag agree. */
  inheritedSeo?: ResolvedSeo;
  /** The site's origin, for the SEO previews; none, and the panel draws none. */
  site?: string;
  /** The path this language serves the entry at, which the previews print under the origin. */
  servedAt?: string;
  /** Production writes cross this entry-lifetime boundary; omission is for isolated fixtures. */
  session?: EntrySession;
  /** Receives acknowledgements and explicit refusals for inspector/Canvas consumers. */
  oncommand?: (result: FieldCommandResult | ListCommandResult) => void;
  /** A changing request opens this level's single image field without an extra inspector click. */
  openMediaPicker?: number;
  onreveal?: (path: readonly string[]) => void;
  /** A drag-only rendering copy shared with recursive field levels. */
  viewRoot?: Data;
  /** A persisted action may allow prose edits while freezing list structure. */
  structureLocked?: boolean;
  /** During machine translation, only plain and rich source prose remains editable. */
  textOnly?: boolean;
  /** Another language's words drawn under each translated field, read only. */
  reference?: Reference;
  /** Drawn right under the entry's title field: the editor puts the address there. */
  afterTitle?: Snippet;
  titleKey?: string;
} = $props();
const options = $derived(messageOptions(uiLocale));

const modeOf = (field: Field): Translation => field.i18n ?? inherited;
// Walked whatever its own mode says, because a field inside it can say otherwise.
const structural = (field: Field) =>
  field.type === 'group' || field.type === 'array' || field.type === 'blocks';
// Widgets a translation has nothing to act on, so the second language is not shown them.
const FIXED = new Set(['reference', 'unsupported']);
// A key like `button.ref` is drawn by the one widget, so that widget shows its problem.
const problemOf = (field: Field, at: string[]) => {
  const key = at.join('.');
  if (problems[key] !== undefined || structural(field)) return problems[key];
  return Object.entries(problems).find(([p]) => p.startsWith(`${key}.`))?.[1];
};
// A folded card hides the field the *problems* button jumps to, so a block with one stays open.
const broken = (at: string[]) => {
  const under = `${at.join('.')}.`;
  return Object.keys(problems).some((p) => p.startsWith(under));
};
const shown = $derived(
  translating
    ? fields.filter((f) => structural(f) || (modeOf(f) !== false && !FIXED.has(f.type)))
    : fields,
);
const plain = $derived(shown.filter((f) => !f.advanced));
const advanced = $derived(shown.filter((f) => f.advanced));
// The fold stays near the copy it tunes, above a long block list.
const foldAt = $derived.by(() => {
  const at = plain.findIndex(structural);
  return at === -1 ? plain.length : at;
});

// One picker at a time per form level; the field id says which is open.
let picker = $state('');
let openedMediaRequest = 0;
$effect(() => {
  const request = openMediaPicker;
  const image = shown.find((field) => field.type === 'image');
  if (!request || request === openedMediaRequest || !image) return;
  openedMediaRequest = request;
  picker = `${prefix}-${[...path, ...image.path].join('.')}`;
});

// Dismiss lasts for the screen's life: what would bring the marker back is a reload anyway.
let opened = $state('');
const behind = (path: string) => !dismissed.includes(path) && sourceChanged[path] !== undefined;
const when = (iso: string) => {
  const at = Date.parse(iso);
  return at ? formatFieldTime(at, uiLocale) : '';
};
const close = (path: string, then: (path: string) => void) => {
  const marker = document.getElementById(`stale-${path}`);
  opened = '';
  then(path);
  marker?.focus();
};

// `_machine` and the translation route name a field by file address, not form position.
const address = (at: readonly string[]) => fieldAddress('default', at, root) ?? '';
const childAddress = (at: readonly string[], child: string) => {
  const parent = address(at);
  return parent ? `${parent}.${child}` : '';
};
// Not conditional on a machine: the stale marker and badge are worth having without one.
const prose = (field: Field) => translating && (field.type === 'text' || field.type === 'richtext');
let projection = $state<Data>();
const displayedRoot = $derived(projection ?? viewRoot ?? root);

function read(at: readonly string[]): unknown {
  return readFrom(displayedRoot, at);
}

// `undefined` removes the key so an optional field left empty is absent, not null.
function directWrite(at: readonly string[], value: unknown) {
  let node = root;
  for (const key of at.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Data;
  }
  const last = at[at.length - 1] as string;
  if (value === undefined) delete node[last];
  else node[last] = value;
}

/** One widget action is one command even when it changes several stored properties. */
function writeMany(
  at: readonly string[],
  changes: readonly FieldChange[],
  history?: FieldHistory,
): FieldCommandResult | undefined {
  if (!session) {
    for (const change of changes) directWrite([...at, ...(change.path ?? [])], change.value);
    return;
  }
  const stable = address(at);
  const result = stable
    ? session.fieldCommand(locale, {
        address: stable,
        contentVersion: session.contentVersion(locale),
        changes,
        history,
      })
    : ({ ok: false, reason: 'ambiguous' } as const);
  oncommand?.(result);
  return result;
}

function write(at: readonly string[], value: unknown, history?: FieldHistory) {
  return writeMany(at, [{ value }], history);
}

// A switch turned off writes `false` only where the loaded file already had the key.
const heldWhenOpened = (at: readonly string[]) =>
  session ? session.heldWhenOpened(locale, address(at)) : read(at) !== undefined;

const str = (at: readonly string[]) => {
  const v = read(at);
  return typeof v === 'string' ? v : '';
};
const num = (at: readonly string[]) => {
  const v = read(at);
  return typeof v === 'number' ? v : '';
};

const rows = (at: readonly string[]): unknown[] => {
  const v = read(at);
  return Array.isArray(v) ? v : [];
};
const list = (at: readonly string[]) => read(at) as unknown[];

function directList(at: readonly string[], operation: ListOperation) {
  const held = readFrom(root, at);
  if (operation.type === 'insert') {
    if (Array.isArray(held)) held.splice(operation.index, 0, operation.value);
    else directWrite(at, [operation.value]);
  } else if (Array.isArray(held) && operation.type === 'remove') {
    held.splice(operation.index, 1);
  } else if (Array.isArray(held) && operation.type === 'move') {
    move(held, operation.from, operation.to);
  }
}
function listCommand(at: readonly string[], operation: ListOperation) {
  if (!session) {
    directList(at, operation);
    return;
  }
  const stable = address(at);
  const result = stable
    ? session.listCommand(locale, {
        address: stable,
        contentVersion: session.contentVersion(locale),
        operation,
      })
    : ({ ok: false, reason: 'ambiguous' } as const);
  oncommand?.(result);
  return result;
}
function add(at: readonly string[], item: unknown) {
  const held = readFrom(root, at);
  const index = Array.isArray(held) ? held.length : 0;
  const result = listCommand(at, { type: 'insert', index, value: item });
  if (!session || result?.ok) folded[keyOf(rows(at), index)] = false;
}
// A scalar row has no `_id`; without a key that moves with it a reorder swaps words, not cards.
const names = new WeakMap<object, string[]>();
function keyOf(items: unknown[], i: number): string {
  const row = items[i] as Data | undefined;
  if (typeof row?._id === 'string') return row._id;
  const keys = names.get(items) ?? [];
  names.set(items, keys);
  while (keys.length < items.length) keys.push(newId('default'));
  return keys[i] as string;
}
function move(items: unknown[], from: number, to: number) {
  items.splice(to, 0, ...items.splice(from, 1));
  names.get(items)?.splice(to, 0, ...(names.get(items)?.splice(from, 1) ?? []));
}
function drop(at: readonly string[], index: number) {
  const held = readFrom(root, at);
  const result = listCommand(at, { type: 'remove', index });
  if (Array.isArray(held) && (!session || result?.ok)) names.get(held)?.splice(index, 1);
}
function duplicate(at: readonly string[], index: number) {
  const result = listCommand(at, { type: 'duplicate', index });
  if (result?.ok) folded[keyOf(rows(at), index + 1)] = false;
}
type Handlers = Required<DragDropEventHandlers>;
let origin = -1;
let dragAddress = '';
let dragVersion = -1;
let dragId = '';
// Hover order lives only in this rendering copy; the entry changes once, on a successful drop.
function begun(at: readonly string[], event: Parameters<Handlers['onDragStart']>[0]) {
  const { source } = event.operation;
  origin = isSortable(source) ? source.index : -1;
  dragId = source ? String(source.id) : '';
  dragAddress = address(at);
  dragVersion = session?.contentVersion(locale) ?? -1;
  if (origin < 0 || !dragAddress) return;
  const next = structuredClone($state.snapshot(root) as Data);
  const before = readFrom(root, at);
  const projected = readFrom(next, at);
  if (!Array.isArray(before) || !Array.isArray(projected)) return;
  const keys = names.get(before);
  projection = next;
  // `$state` proxies the clone on assignment, so attach scalar-row identities to that array.
  const held = readFrom(projection, at);
  if (keys && Array.isArray(held)) names.set(held, [...keys]);
}
function over(at: readonly string[], event: Parameters<Handlers['onDragOver']>[0]) {
  const { source, target } = event.operation;
  if (!projection || !isSortable(source) || !isSortable(target) || source.index === target.index)
    return;
  move(list(at), source.index, target.index);
}
function ended(at: readonly string[], event: Parameters<Handlers['onDragEnd']>[0]) {
  const from = origin;
  const projected = projection ? readFrom(projection, at) : undefined;
  const to = Array.isArray(projected)
    ? projected.findIndex((_row, i) => keyOf(projected, i) === dragId)
    : -1;
  const stable = dragAddress;
  const version = dragVersion;
  projection = undefined;
  origin = -1;
  dragAddress = '';
  dragVersion = -1;
  dragId = '';
  if (event.canceled || from < 0 || to < 0 || from === to) return;
  if (!session) directList(at, { type: 'move', from, to });
  else {
    const result = stable
      ? session.listCommand(locale, {
          address: stable,
          contentVersion: version,
          operation: { type: 'move', from, to },
        })
      : ({ ok: false, reason: 'ambiguous' } as const);
    oncommand?.(result);
  }
}
// Read lazily: an eager read would remake the sortable on every reorder, losing the animation.
const sortable = (id: () => string, index: () => number, sensors?: Sensors) =>
  createSortable({
    ...(sensors && { sensors }),
    get id() {
      return id();
    },
    get index() {
      return index();
    },
    get disabled() {
      return translating || structureLocked;
    },
  });

const block = (row: unknown) =>
  row as { _type?: string; _id?: string; _label?: string; _ref?: string };
// Folded blocks, by the block's own key, so a fold rides along when the block is moved.
let folded = $state<Record<string, boolean>>({});
function excerpt(row: unknown, inner: Field[] | undefined): string {
  for (const f of inner ?? []) {
    if (f.advanced) continue;
    const v = f.path.reduce<unknown>((node, key) => (node as Data | undefined)?.[key], row);
    if ((f.type === 'text' || f.type === 'richtext') && typeof v === 'string' && v.trim())
      return v.length > 100 ? `${v.slice(0, 99)}…` : v;
    if (f.type === 'group') {
      const words = excerpt(v, f.fields);
      if (words) return words;
    }
    if (f.type === 'array' && Array.isArray(v)) {
      for (const item of v) {
        const words = excerpt(item, f.item);
        if (words) return words;
      }
    }
  }
  return '';
}
// A `_ref` block's content lives in a global and an unknown `_type` has no fields: both read-only.
const blockName = (row: unknown) =>
  block(row)._label ||
  labelIn(blockLabels?.[block(row)._type ?? ''], uiLocale) ||
  block(row)._type ||
  '';
const blockFields = (row: unknown) =>
  block(row)._ref === undefined ? blocks[block(row)._type ?? ''] : undefined;

// A stored reference names an entry this form never picked, so its title is looked up.
let known = $state.raw<Pickable>({ entries: [], locales: [] });
$effect(() => {
  if (fields.some((f) => f.type === 'reference' || f.type === 'link'))
    readEntryDirectory()
      .then((p) => (known = p))
      .catch(() => (known = EMPTY_ENTRY_DIRECTORY));
});

const src = (at: readonly string[]) => {
  const key = str([...at, 'src']);
  return key ? `${mediaBase}/${key}` : '';
};
/** This page's own dot, in percentages; the middle is what a page that set none crops around. */
const point = (at: readonly string[]): [number, number] => {
  const stored = read([...at, 'focal']);
  const [x, y] = Array.isArray(stored) ? (stored as unknown[]) : [];
  return [typeof x === 'number' ? x : 0.5, typeof y === 'number' ? y : 0.5];
};
const dot = (at: readonly string[]) => point(at).map((n) => n * 100);
/** Which image field has the focal dialog open, by the same id its widget is drawn under. */
let framing = $state('');
// One paste box and one paste refusal per level, by field id.
let pasting = $state('');
let refused = $state<{ id: string; reason?: EmbedRefusalReason }>({ id: '' });

function picked(at: readonly string[], type: 'image' | 'file', items: MediaItem[]) {
  const held = read(at) as { alt?: unknown } | undefined;
  write(at, stored(type, items[0] as MediaItem, held?.alt));
  picker = '';
}

// An array whose row is the picture: the picker takes several at once, one row each.
const gallery = (field: Field) =>
  field.type === 'array' &&
  field.item.length === 1 &&
  field.item[0]?.path.length === 0 &&
  field.item[0]?.type === 'image';

// The picture itself drags as well as the handle; the keyboard still goes through the handle.
const GALLERY_SENSORS: Sensors = [
  PointerSensor.configure({ activatorElements: (source) => [source.element, source.handle] }),
  KeyboardSensor,
];
/** The gallery picture whose dialog is open. */
let editing = $state<{ id: string; index: number }>();

function pickedInto(at: readonly string[], items: MediaItem[]) {
  for (const item of items) add(at, stored('image', item));
  picker = '';
}

// Files dropped on the field itself: the picker opens with them, so there is one upload path.
let dropped = $state<File[]>([]);
function dropOn(id: string, e: DragEvent) {
  e.preventDefault();
  dropped = Array.from(e.dataTransfer?.files ?? []);
  picker = id;
}

const level: FieldLevel = {
  read,
  str,
  num,
  write,
  writeMany,
  address,
  childAddress,
  src,
  point,
  picked,
  dropOn,
  get picker() {
    return picker;
  },
  set picker(id) {
    picker = id;
  },
  get dropped() {
    return dropped;
  },
  set dropped(files) {
    dropped = files;
  },
  get uiLocale() {
    return uiLocale;
  },
  get options() {
    return options;
  },
  get mediaBase() {
    return mediaBase;
  },
  get reference() {
    return reference;
  },
  get translating() {
    return translating;
  },
  get structureLocked() {
    return structureLocked;
  },
};
</script>

{#snippet machineMark(path: string, text: string)}
  {#if machine.includes(path)}<span class="badge badge-machine">{m.translation_machine_badge({}, options)}</span>{/if}
  {#if behind(path)}
    <button
      class="stale"
      id="stale-{path}"
      type="button"
      aria-haspopup="dialog"
      aria-expanded={opened === path}
      onclick={() => (opened = opened === path ? '' : path)}
      >{m.translation_source_changed({ source: sourceLabel }, options)}</button
    >
  {/if}
  {#if ontranslate && path}
    <button class="btn btn-ghost btn-translate" type="button" aria-label={m.translation_field_aria({ field: text }, options)} onclick={() => ontranslate?.(path)}>{m.translation_field({}, options)}</button>
  {/if}
{/snippet}

<!-- Before and after in full, so the question is "does the German still say this?" -->
{#snippet stale(stalePath: string)}
  <!-- A `role="dialog"` takes focus when it opens and hands it back to the marker on close. -->
  <div
    class="popover"
    role="dialog"
    tabindex="-1"
    {@attach (node) => node.focus()}
    aria-label={m.translation_changed_dialog({ source: sourceLabel }, options)}
    onkeydown={(e) => e.key === 'Escape' && close(stalePath, () => {})}
  >
    <div class="diff">
      <div class="row">
        <small>{translatedAt ? m.translation_when_at({ source: sourceLabel, date: when(translatedAt) }, options) : m.translation_when({ source: sourceLabel }, options)}</small
        >{#each sourceChanged[stalePath] ?? [] as part}{#if part.mark === 'del'}<del
            >{part.text}</del
          >{:else if part.mark !== 'ins'}{part.text}{/if}{/each}
      </div>
      <div class="row">
        <small>{m.translation_now({ source: sourceLabel }, options)}</small
        >{#each sourceChanged[stalePath] ?? [] as part}{#if part.mark === 'ins'}<ins
            >{part.text}</ins
          >{:else if part.mark !== 'del'}{part.text}{/if}{/each}
      </div>
    </div>
    <!-- Read the address before `opened` moves: closing is what takes the argument away. -->
    <div class="actions">
      {#if onretranslate}
        <button class="btn btn-sm" type="button" onclick={() => close(stalePath, onretranslate)}>{m.translation_retranslate({}, options)}</button>
      {/if}
      <button class="btn btn-sm btn-ghost" type="button" onclick={() => close(stalePath, (p) => (dismissed = [...dismissed, p]))}>{m.translation_dismiss({}, options)}</button>
    </div>
  </div>
{/snippet}

{#snippet groupLabel(id: string, field: Field, text: string, at: readonly string[] = [])}
  <div class="label-row"><span id="{id}-l">{text}{#if 'required' in field && field.required}<span class="req" aria-hidden="true">*</span>{/if}</span>{#if field.type === 'array' || field.type === 'blocks'}<span class="section-count">{m.field_item_count({ count: rows(at).length }, options)}</span>{/if}{#if prose(field)}{@render machineMark(address(at), text)}{/if}</div>
{/snippet}

{#snippet icon(d: string)}
  <svg class="field-icon" viewBox="0 0 24 24" aria-hidden="true"><path {d} /></svg>
{/snippet}

{#snippet controls(at: readonly string[], i: number, name: string, handle: (node: HTMLElement) => () => void, duplicable = false)}
  <div class="row-controls">
    <button class="btn btn-ghost btn-icon handle" type="button" aria-label={m.field_reorder({ item: name }, options)} disabled={structureLocked} {@attach handle}>{@render icon('M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01')}</button>
    {#if duplicable}<button class="btn btn-ghost btn-icon" type="button" aria-label={m.field_duplicate({ item: name }, options)} disabled={structureLocked} onclick={() => duplicate(at, i)}>{@render icon('M9 9h10v10H9zM5 15V5h10')}</button>{/if}
    <button class="btn btn-ghost btn-icon remove-row" type="button" aria-label={m.field_remove({ item: name }, options)} disabled={structureLocked} onclick={() => drop(at, i)}>{@render icon('M7 7l10 10M17 7 7 17')}</button>
  </div>
{/snippet}

{#snippet chosenEntry(id: string, labelId: string, says: string | undefined, ref: string, open: () => void)}
  {@const found = known.entries.find((e) => e.path === ref)}
  <div class="ref-list" {id} role="group" aria-labelledby={labelId} aria-describedby={says}>
    <div class="ref-item">
      <span class="ref-copy">
        <span class="title">{found?.title ?? ref}</span>
        <span class="path">{ref}</span>
      </span>
      {#if found}
        <span class="chips">
          {#each known.locales as of (of)}<span class={['chip', { 'chip-missing': !found.locales.includes(of) }]}>{of.toUpperCase()}</span>{/each}
        </span>
      {/if}
      <button class="btn btn-ghost btn-sm remove" type="button" onclick={open}>{m.field_change({}, options)}</button>
    </div>
  </div>
{/snippet}

{#snippet noEntry(id: string, labelId: string, says: string | undefined, action: string, open: () => void)}
  <div class="list-empty" {id} role="group" aria-labelledby={labelId} aria-describedby={says}>
    <span>{m.field_nothing_chosen({}, options)}</span>
    <button class="btn btn-sm" type="button" onclick={open}>{action}</button>
  </div>
{/snippet}

{#snippet labelRow(id: string, field: Field, text: string, at: readonly string[] = [])}
  <div class="label-row">
    <label for={id}>{text}{#if 'required' in field && field.required}<span class="req" aria-hidden="true">*</span>{/if}</label>
    {#if prose(field)}{@render machineMark(address(at), text)}{/if}
  </div>
{/snippet}

{#snippet nested(inner: readonly Field[], at: readonly string[], mode: Translation, view: Data, rowLabel?: string)}<Fields fields={inner} bind:root {blocks} {blockLabels} {problems} path={at} {rowLabel} {translating} {machine} {ontranslate} {sourceChanged} bind:dismissed {sourceLabel} {translatedAt} {onretranslate} {prefix} {mediaBase} {locale} {uiLocale} {site} {servedAt} {session} {oncommand} {onreveal} viewRoot={view} inherited={mode} {structureLocked} {textOnly} {reference} />{/snippet}

{#snippet row(field: Field)}
  {@const at = [...path, ...field.path]}
  {@const id = `${prefix}-${at.join('.')}`}
  {@const mode = modeOf(field)}
  {@const text = field.label || rowLabel}
  {@const err = problemOf(field, at)}
  {@const bad = err ? 'true' : undefined}
  {@const says = err ? `${id}-err` : undefined}
  {@const marked = [address(at), childAddress(at, 'label')].find((p) => p && opened === p)}
  <div class={['field', { 'is-invalid': err, 'pop-anchor': marked }]} data-field-type={field.type} id="{id}-field" tabindex="-1" inert={textOnly && !structural(field) && ((field.type !== 'text' && field.type !== 'richtext') || mode !== true) ? true : undefined}>
    {#if field.type === 'menus'}
      {@render groupLabel(id, field, text, at)}
      <Menus {id} labelId="{id}-l" menus={rows(at) as Menu[]} {locale} {uiLocale} {translating} {sourceLabel} variants={field.variants} />
    {:else if translating && mode === 'duplicate' && !structural(field)}
      {@render groupLabel(id, field, text, at)}
      <div class="readonly" {id} role="region" tabindex="-1" aria-labelledby="{id}-l">{read(at) ?? ''}</div>
      <p class="hint">{m.field_same_every_language({}, options)}</p>
    {:else if field.type === 'text'}
      {@render labelRow(id, field, text, at)}
      <TextField {id} invalid={bad} describedBy={says} required={field.required} value={str(at)} onvalue={(value) => write(at, value)} />
      {#if reference}<ReferencePeek {reference} path={address(at)} {uiLocale} />{/if}
    {:else if field.type === 'number'}
      {@render labelRow(id, field, text, at)}
      <input class="input" {id} type="number" step="any" aria-invalid={bad} aria-describedby={says} aria-required={field.required ? 'true' : undefined} value={num(at)} oninput={(e) => write(at, e.currentTarget.value === '' ? undefined : e.currentTarget.valueAsNumber)} />
    {:else if field.type === 'boolean'}
      <label class="switch" for={id}><input type="checkbox" role="switch" {id} aria-invalid={bad} aria-describedby={says} aria-required={field.required ? 'true' : undefined} checked={read(at) === true} onchange={(e) => write(at, e.currentTarget.checked || field.required || heldWhenOpened(at) ? e.currentTarget.checked : undefined)} /><span>{text}</span></label>
    {:else if field.type === 'date'}
      {@render labelRow(id, field, text, at)}
      <input class="input" {id} type="date" aria-invalid={bad} aria-describedby={says} aria-required={field.required ? 'true' : undefined} value={str(at)} oninput={(e) => write(at, e.currentTarget.value || undefined)} />
    {:else if field.type === 'select'}
      {#if field.options.length <= 5}
        <fieldset aria-describedby={says}>
          <legend>{text}{#if field.required}<span class="req" aria-hidden="true">*</span>{/if}</legend>
          {#each field.options as option (option)}
            <label class="choice"><input type="radio" name={id} value={option} required={field.required} checked={read(at) === option} onchange={() => write(at, option)} /><span>{labelIn(field.optionLabels?.[option], uiLocale) ?? capitalise(option)}</span></label>
          {/each}
        </fieldset>
      {:else}
        {@render labelRow(id, field, text, at)}
        <select class="input" {id} aria-invalid={bad} aria-describedby={says} aria-required={field.required ? 'true' : undefined} value={str(at)} onchange={(e) => write(at, e.currentTarget.value || undefined)}>
          <option value="">{m.field_choose({}, options)}</option>
          {#each field.options as option (option)}
            <option value={option}>{labelIn(field.optionLabels?.[option], uiLocale) ?? capitalise(option)}</option>
          {/each}
        </select>
      {/if}
    {:else if field.type === 'link' && translating}
      <!-- A link's label is the half a translation owns. -->
      {@render groupLabel(id, field, text, at)}
      <div class="field"><div class="label-row"><label for="{id}.label">{m.field_link_label({}, options)}</label>{@render machineMark(childAddress(at, 'label'), `${text} label`)}</div><input class="input" id="{id}.label" type="text" value={str([...at, 'label'])} oninput={(e) => write([...at, 'label'], e.currentTarget.value || undefined)} />{#if reference}<ReferencePeek {reference} path={childAddress(at, 'label')} {uiLocale} />{/if}</div>
    {:else if field.type === 'link'}
      {@render groupLabel(id, field, text, at)}
      <LinkField {level} {id} {at} {text} {says} chosen={chosenEntry} empty={noEntry} />
    {:else if field.type === 'richtext'}
      {@render groupLabel(id, field, text, at)}
      <RichText {id} labelId="{id}-l" {locale} {uiLocale} tier={field.tier} invalid={!!err} describedby={says} value={str(at)} address={address(at)} {session} onchange={(md, history) => write(at, md, history)} />
      {#if reference}<ReferencePeek {reference} path={address(at)} tier={field.tier} {uiLocale} />{/if}
    {:else if field.type === 'group'}
      <details class="group" open>
        <summary>{text}<span class="count">{m.field_count({ count: field.fields.length }, options)}</span></summary>
        <div class="form">{@render nested(field.fields, at, mode, displayedRoot)}</div>
      </details>
    {:else if field.type === 'array' && gallery(field) && !translating}
      {@const items = rows(at)}
      {@const preset = field.item[0]?.type === 'image' ? field.item[0].preset : {}}
      {@render groupLabel(id, field, text, at)}
      <div class="list gallery" {id} role="group" aria-labelledby="{id}-l">
        <DragDropProvider onDragStart={(e) => begun(at, e)} onDragOver={(e) => over(at, e)} onDragEnd={(e) => ended(at, e)}>
        {#each items as _row, i (keyOf(items, i))}
          {@const s = sortable(() => keyOf(items, i), () => i, GALLERY_SENSORS)}
          {@const cell = [...at, String(i)]}
          {@const name = m.field_gallery_image({ index: i + 1, count: items.length }, options)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -- the edit button is the keyboard route -->
          <div class={['gallery-item', { 'is-dragging': s.isDragging }]} {@attach s.attach} onclick={(e) => !e.defaultPrevented && (editing = { id, index: i })}>
            <span class="thumb"><MediaImage src={src(cell)} alt="" loading="lazy" style="object-position: {dot(cell)[0]}% {dot(cell)[1]}%" {uiLocale} /></span>
            <span class="gallery-number">{i + 1}</span>
            {#if !str([...cell, 'alt'])}<span class="gallery-no-alt">{m.field_gallery_no_alt({}, options)}</span>{/if}
            <div class="row-controls">
              <button class="btn btn-ghost btn-icon handle" type="button" aria-label={m.field_reorder({ item: name }, options)} disabled={structureLocked} {@attach s.attachHandle}>{@render icon('M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01')}</button>
              <button class="btn btn-ghost btn-icon" type="button" aria-label={m.field_gallery_edit({ index: i + 1 }, options)} onclick={() => (editing = { id, index: i })}>{@render icon('M4 20h4L19 9l-4-4L4 16zM14 6l4 4')}</button>
              <button class="btn btn-ghost btn-icon remove-row" type="button" aria-label={m.field_remove({ item: name }, options)} disabled={structureLocked} onclick={() => drop(at, i)}>{@render icon('M7 7l10 10M17 7 7 17')}</button>
            </div>
          </div>
        {/each}
        </DragDropProvider>
        <button class="btn btn-sm add" type="button" aria-label={m.field_list_add_label({ field: text }, options)} disabled={structureLocked} onclick={() => (picker = id)}>{m.field_gallery_add({}, options)}</button>
      </div>
      {#if picker === id}
        <Media kind="images" label={text} {preset} base={mediaBase} many {uiLocale} onpick={(picks) => pickedInto(at, picks)} onclose={() => (picker = '')} />
      {/if}
      {#if editing?.id === id && items[editing.index] !== undefined}
        {@const i = editing.index}
        {@const cell = [...at, String(i)]}
        {@const cellId = `${id}.${i}`}
        <Modal labelledby="{cellId}-h" panelClass="dialog gallery-dialog" initialFocus="input" onclose={() => (editing = undefined)}>
          <header><h2 id="{cellId}-h">{m.field_gallery_image({ index: i + 1, count: items.length }, options)}</h2></header>
          <ImageCard {level} id={cellId} at={cell} ratio={aspect(preset)} onframe={() => (framing = cellId)} onreplace={() => (picker = cellId)} onremove={() => { drop(at, i); editing = undefined; }} locked={structureLocked} />
          <div class="actions"><button class="btn btn-primary" type="button" onclick={() => (editing = undefined)}>{m.field_gallery_done({}, options)}</button></div>
        </Modal>
        {#if framing === cellId}
          <Focal name={text} url={src(cell)} focal={point(cell)} presets={preset.ratio ? [{ label: text, preset }] : []} {uiLocale} onsave={(moved) => { write([...cell, 'focal'], centred(moved) ? undefined : moved); framing = ''; }} onclose={() => (framing = '')} />
        {/if}
        {#if picker === cellId}
          <Media kind="images" label={text} {preset} base={mediaBase} {uiLocale} onpick={(picks) => picked(cell, 'image', picks)} onclose={() => (picker = '')} />
        {/if}
      {/if}
    {:else if field.type === 'array'}
      {@const items = rows(at)}
      {@const scalar = field.item.length === 1 && field.item[0]?.path.length === 0}
      {@render groupLabel(id, field, text, at)}
      <div class="list" {id} role="group" aria-labelledby="{id}-l">
        <DragDropProvider onDragStart={(e) => begun(at, e)} onDragOver={(e) => over(at, e)} onDragEnd={(e) => ended(at, e)}>
        {#each items as row, i (keyOf(items, i))}
          {@const s = sortable(() => keyOf(items, i), () => i)}
          {@const name = m.field_row_name({ field: text, index: i + 1 }, options)}
          {@const open = broken([...at, String(i)])}
          {@const shut = !open && folded[keyOf(items, i)] !== false}
          {#if scalar}
          <div class={['row-card', { 'is-scalar': true, 'is-dragging': s.isDragging }]} {@attach !translating && s.attach}>
            <div class="row-fields">{@render nested(field.item, [...at, String(i)], mode, displayedRoot, `${text} ${i + 1}`)}</div>
            {#if !translating}{@render controls(at, i, name, s.attachHandle)}{/if}
          </div>
          {:else}
          <article class={['block-card section-card', { 'is-dragging': s.isDragging, 'is-folded': shut }]} id="{id}.{i}" aria-labelledby="{id}.{i}-h" {@attach !translating && s.attach}>
            <header>
              <button class="btn btn-ghost fold section-toggle" type="button" disabled={open} aria-expanded={!shut} aria-controls="{id}.{i}-b" onclick={() => { const opening = shut; folded[keyOf(items, i)] = !opening; if (opening) onreveal?.([...at, String(i)]); }}>
                {@render icon('m9 6 6 6-6 6')}
                <span class="section-number">{i + 1}</span>
                <span class="section-copy"><span class="label" id="{id}.{i}-h">{name}</span>{#if shut} <span class="excerpt">{excerpt(row, field.item)}</span>{/if}</span>
              </button>
              {#if !translating}{@render controls(at, i, name, s.attachHandle)}{/if}
            </header>
            {#if !shut}<div class="form" id="{id}.{i}-b">{@render nested(field.item, [...at, String(i)], mode, displayedRoot, `${text} ${i + 1}`)}</div>{/if}
          </article>
          {/if}
        {:else}
          <p class="hint">{m.field_list_empty({}, options)}</p>
        {/each}
        </DragDropProvider>
        {#if !translating}
          <button class="btn btn-sm add" type="button" aria-label={m.field_list_add_label({ field: text }, options)} disabled={structureLocked} onclick={() => add(at, scalar ? '' : { _id: newId('default') })}>{m.field_list_add({}, options)}</button>
        {/if}
      </div>
    {:else if field.type === 'blocks'}
      {@const items = rows(at)}
      {@render groupLabel(id, field, text, at)}
      <div class="list" {id} role="group" aria-labelledby="{id}-l">
        <DragDropProvider onDragStart={(e) => begun(at, e)} onDragOver={(e) => over(at, e)} onDragEnd={(e) => ended(at, e)}>
        {#each items as row, i (keyOf(items, i))}
          {@const name = blockName(row)}
          {@const inner = blockFields(row)}
          {@const label = block(row)._label || capitalise(name.replace(/([a-z])([A-Z])/g, '$1 $2'))}
          {@const s = sortable(() => keyOf(items, i), () => i)}
          {@const open = broken([...at, String(i)])}
          {@const shut = !open && folded[keyOf(items, i)] !== false}
          <article class={['block-card section-card', { 'is-dragging': s.isDragging, 'is-folded': shut }]} id="{id}.{i}" aria-labelledby="{id}.{i}-h" {@attach !translating && s.attach}>
            <header>
              <button class="btn btn-ghost fold section-toggle" type="button" disabled={open} aria-expanded={!shut} aria-controls="{id}.{i}-b" onclick={() => { const opening = shut; folded[keyOf(items, i)] = !opening; if (opening) onreveal?.([...at, String(i)]); }}>
                {@render icon('m9 6 6 6-6 6')}
                <span class="section-number">{i + 1}</span>
                <span class="section-copy"><span class="label" id="{id}.{i}-h" title="{block(row)._type} · {block(row)._id}">{label}</span>{#if shut} <span class="excerpt">{excerpt(row, inner)}</span>{/if}</span>
              </button>
              {#if !translating}{@render controls(at, i, name, s.attachHandle, true)}{/if}
            </header>
            {#if shut}
              <!-- folded: the header is the whole card -->
            {:else if inner}
              <div class="form" id="{id}.{i}-b">{@render nested(inner, [...at, String(i)], mode, displayedRoot)}</div>
            {:else}
              <p class="ref-note" id="{id}.{i}-b">{block(row)._ref ?? m.field_block_missing({ type: block(row)._type ?? '' }, options)} — {m.field_not_editable({}, options)}</p>
            {/if}
          </article>
        {:else}
          <p class="hint">{m.field_list_empty({}, options)}</p>
        {/each}
        </DragDropProvider>
        {#if !translating}
        <div class="pop-anchor">
          <button class="btn btn-sm add" type="button" disabled={structureLocked} aria-haspopup="dialog" aria-expanded={picker === id} onclick={() => (picker = id)}>{m.field_add_block({}, options)}</button>
          {#if picker === id}
            <Modal labelledby="{id}-picker-h" panelClass="dialog block-picker" initialFocus=".type-card" onclose={() => (picker = '')}>
              <header><h2 id="{id}-picker-h">{m.field_add_block({}, options)}</h2></header>
              <div class="types">
                {#each field.types as type (type)}
                  <button class="type-card" type="button" value={type} disabled={structureLocked} onclick={() => { add(at, { _type: type, _id: newId('default') }); picker = ''; }}>{labelIn(blockLabels?.[type], uiLocale) ?? type}</button>
                {/each}
              </div>
              <div class="actions">
                <button class="btn" type="button" onclick={() => (picker = '')}>{m.common_cancel({}, options)}</button>
              </div>
            </Modal>
          {/if}
        </div>
        {/if}
      </div>
    {:else if field.type === 'image'}
      {@render groupLabel(id, field, text, at)}
      <ImageField {level} {id} {at} {field} {text} {says} />
    {:else if field.type === 'file'}
      {@render groupLabel(id, field, text, at)}
      <FileField {level} {id} {at} {field} {text} {says} />
    {:else if field.type === 'reference'}
      {@render groupLabel(id, field, text, at)}
      {#if picker === id}
        <PagePicker {id} label={text} labelId="{id}-l" {uiLocale} collection={field.collection} chosen={str(at)} onpick={(e) => { write(at, e.path); picker = ''; }} onclose={() => (picker = '')} />
      {:else if str(at)}
        {@render chosenEntry(id, `${id}-l`, says, str(at), () => (picker = id))}
      {:else}
        {@render noEntry(id, `${id}-l`, says, m.field_choose_named({ field: text }, options), () => (picker = id))}
      {/if}
    {:else if field.type === 'embed'}
      <EmbedField {level} {id} {at} {field} {text} {says} {bad} bind:pasting bind:refused />
    {:else if field.type === 'seo'}
      {@render groupLabel(id, field, text, at)}
      <SeoField {level} {id} {at} {says} {locale} {inheritedSeo} {site} {servedAt} />
    {:else}
      <div class="label-row"><label for={id}>{text}</label></div>
      <p class="hint" {id}>{m.field_not_editable_yet({}, options)}</p>
    {/if}
    {#if err}<p class="error" id="{id}-err">{err}</p>{/if}
    {#if marked}{@render stale(marked)}{/if}
  </div>
  {#if afterTitle && at.join('.') === titleKey}{@render afterTitle()}{/if}
{/snippet}

{#each plain.slice(0, foldAt) as field (field.path.join('.'))}{@render row(field)}{/each}
{#if advanced.length > 0}
  <details class="group advanced" open={advanced.some((f) => problemOf(f, [...path, ...f.path]))}>
    <summary>{m.field_advanced({}, options)}<span class="count">{m.field_count({ count: advanced.length }, options)}</span></summary>
    <div class="form">{#each advanced as field (field.path.join('.'))}{@render row(field)}{/each}</div>
  </details>
{/if}
{#each plain.slice(foldAt) as field (field.path.join('.'))}{@render row(field)}{/each}

<style>
  .section-count { margin-left: auto; color: var(--ink-3); font-size: var(--text-xs); font-weight: 400; }
  .section-card > header { align-items: flex-start; }
  .section-card > header .section-toggle { width: auto; min-width: 0; flex: 1; justify-content: flex-start; align-items: flex-start; gap: 8px; padding: 5px 3px; text-align: left; white-space: normal; }
  .section-toggle > :global(svg) { flex: none; margin-top: 2px; }
  .section-number { flex: none; min-width: 20px; font-size: var(--text-xs); font-variant-numeric: tabular-nums; color: var(--ink-3); line-height: 20px; }
  .section-copy { display: grid; gap: 3px; min-width: 0; }
  .section-card > header .label { max-width: none; font-size: var(--text-sm); }
  .section-card > header .excerpt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; font-size: var(--text-xs); font-weight: 400; white-space: normal; overflow-wrap: anywhere; }
  .section-card > header :global(.row-controls) { flex: none; margin-top: 3px; }
</style>
