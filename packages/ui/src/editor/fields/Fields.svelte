<script lang="ts">
import { type DragDropEventHandlers, DragDropProvider } from '@dnd-kit/svelte';
import { createSortable, isSortable } from '@dnd-kit/svelte/sortable';
import {
  EMBED_LABELS,
  type EmbedRefusalReason,
  type EmbedValue,
  embedThumb,
  type Field,
  type Form,
  fieldAddress,
  labelIn,
  newId,
  type Preset,
  parseEmbedUrl,
  type ResolvedSeo,
  SEO_DESCRIPTION_LIMIT,
  SEO_TITLE_LIMIT,
  SOCIAL_CARD,
  type Translation,
  unsafeLinkScheme,
  type WordPart,
} from '@handover/core';
import { tick } from 'svelte';
import Menus, { type Menu } from '../../content/Menus.svelte';
import PagePicker from '../../content/PagePicker.svelte';
import { EMPTY_ENTRY_DIRECTORY, type Pickable, readEntryDirectory } from '../../entry-directory.js';
import type { UiLocale } from '../../i18n.js';
import { formatFieldTime, messageOptions } from '../../i18n.js';
import Focal from '../../media/Focal.svelte';
import Media from '../../media/Media.svelte';
import { fileSize, type MediaItem } from '../../media/upload.js';
import * as m from '../../paraglide/messages.js';
import MediaImage from '../../shared/MediaImage.svelte';
import type {
  EntrySession,
  FieldChange,
  FieldCommandResult,
  FieldHistory,
  ListCommandResult,
  ListOperation,
} from '../entry-session.svelte';
import Fields from './Fields.svelte';
import RichText from './RichText.svelte';
import TextField from './TextField.svelte';

type Data = Record<string, unknown>;
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
  openMediaPicker = 0,
  viewRoot,
  structureLocked = false,
  textOnly = false,
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
  /** A drag-only rendering copy shared with recursive field levels. */
  viewRoot?: Data;
  /** A persisted action may allow prose edits while freezing list structure. */
  structureLocked?: boolean;
  /** During machine translation, only plain and rich source prose remains editable. */
  textOnly?: boolean;
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
let dismissed = $state<string[]>([]);
// A `role="dialog"` takes focus when it opens and hands it back to the marker on close.
let popover = $state<HTMLElement>();
$effect(() => {
  if (opened) popover?.focus();
});
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
// A `site` that is not a URL prints no host rather than throwing.
const host = $derived.by(() => {
  try {
    return site ? new URL(site).host : '';
  } catch {
    return '';
  }
});
const crumbs = $derived(
  [host, ...(servedAt ?? '').split('/').filter(Boolean).map(decodeURIComponent)].join(' › '),
);

let projection = $state<Data>();
const displayedRoot = $derived(projection ?? viewRoot ?? root);

function readFrom(data: Data, at: readonly string[]): unknown {
  return at.reduce<unknown>((node, key) => (node as Data | undefined)?.[key], data);
}
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

const str = (at: readonly string[]) => {
  const v = read(at);
  return typeof v === 'string' ? v : '';
};
const num = (at: readonly string[]) => {
  const v = read(at);
  return typeof v === 'number' ? v : '';
};
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
  listCommand(at, { type: 'insert', index: Array.isArray(held) ? held.length : 0, value: item });
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
  listCommand(at, { type: 'duplicate', index });
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
const sortable = (id: () => string, index: () => number) =>
  createSortable({
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
    const v = f.path.reduce<unknown>((node, key) => (node as Data | undefined)?.[key], row);
    if (typeof v === 'string' && v.trim()) return v.length > 80 ? `${v.slice(0, 79)}…` : v;
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
let known = $state<Pickable>({ entries: [], locales: [] });
$effect(() => {
  if (fields.some((f) => f.type === 'reference' || f.type === 'link'))
    readEntryDirectory()
      .then((p) => (known = p))
      .catch(() => (known = EMPTY_ENTRY_DIRECTORY));
});

const aspect = (preset: Preset) => preset.ratio?.replace(':', ' / ') ?? '4 / 3';
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
/** Which embed field has the paste box open over a value it already holds. */
let pasting = $state('');
/** The last paste that was not a link we know, and the field it was made in. */
let refused = $state<{ id: string; reason?: EmbedRefusalReason }>({ id: '' });

// A control that replaces itself would drop focus, so focus follows onto its replacement.
const focusOn = (elementId: string) =>
  void tick().then(() => document.getElementById(elementId)?.focus());

// A hand-edited file can hold anything under an embed key; half a value draws no card.
function embedValue(at: readonly string[]): EmbedValue | undefined {
  const v = read(at) as EmbedValue | undefined;
  return v && typeof v.id === 'string' && v.provider in EMBED_LABELS ? v : undefined;
}

// A mistyped link must never empty the field; a recognised one replaces the title too.
function pasteEmbed(at: readonly string[], id: string, input: HTMLInputElement) {
  refused = { id: '' };
  if (!input.value.trim()) return;
  const parsed = parseEmbedUrl(input.value);
  if ('refused' in parsed) {
    refused = { id, reason: parsed.reason };
    return;
  }
  const { provider, id: chosen, start } = parsed.embed;
  // `title` and `start` are holes so each keeps its place in the file once typed.
  write(at, { provider, id: chosen, title: undefined, start });
  input.value = '';
  pasting = '';
  focusOn(`${id}-change`);
}
const embedRefusal = (reason: EmbedRefusalReason | undefined) => {
  if (reason === 'shortened-map') return m.field_embed_shortened_map({}, messageOptions(uiLocale));
  if (reason === 'embed-code') return m.field_embed_code({}, messageOptions(uiLocale));
  if (reason === 'map-view') return m.field_embed_map_view({}, messageOptions(uiLocale));
  return m.field_embed_unknown({}, messageOptions(uiLocale));
};
// Every key a hole, so a description typed before a title does not land above it in the file.
const SEO_SHAPE = {
  title: undefined,
  description: undefined,
  image: undefined,
  noindex: undefined,
  canonical: undefined,
};
function seoWrite(at: readonly string[], key: string, value: unknown) {
  const held = read(at) as Record<string, unknown> | undefined;
  if (!translating && (held === undefined || !(key in held)))
    write(at, { ...SEO_SHAPE, ...held, [key]: value });
  else write([...at, key], value);
}

const bytes = (at: readonly string[]) =>
  fileSize(read([...at, 'bytes']) as number | undefined, uiLocale);

/** One picked asset as the format stores it — and in that order. */
const stored = (type: 'image' | 'file', item: MediaItem, pageAlt?: unknown) =>
  type === 'image'
    ? // A page keeps its own words; otherwise selection takes a snapshot of the library default.
      {
        src: item.src,
        alt: typeof pageAlt === 'string' ? pageAlt : item.alt || undefined,
        width: item.width,
        height: item.height,
        focal: centred(item.focal) ? undefined : item.focal,
      }
    : { src: item.src, name: item.filename, bytes: item.bytes, mime: item.mime };

/** The middle is where a crop holds when nothing says otherwise, so it is not written. */
const centred = (focal?: [number, number] | null) =>
  !focal || (focal[0] === 0.5 && focal[1] === 0.5);

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

const linkType = (at: readonly string[]) => (read([...at, 'type']) === 'url' ? 'url' : 'entry');
function setLinkType(at: readonly string[], type: 'url' | 'entry') {
  writeMany(at, [
    { path: ['type'], value: type },
    { path: [type === 'url' ? 'ref' : 'href'], value: undefined },
  ]);
}
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
  <div
    class="popover"
    role="dialog"
    tabindex="-1"
    bind:this={popover}
    aria-label={m.translation_changed_dialog({ source: sourceLabel }, options)}
    onkeydown={(e) => e.key === 'Escape' && close(stalePath, () => {})}
  >
    <div class="diff">
      <div class="row">
        <small>{translatedAt ? m.translation_when_at({ source: sourceLabel, date: when(translatedAt) }, options) : m.translation_when({ source: sourceLabel }, options)}</small
        >{#each sourceChanged[stalePath] ?? [] as part, i (i)}{#if part.mark === 'del'}<del
            >{part.text}</del
          >{:else if part.mark !== 'ins'}{part.text}{/if}{/each}
      </div>
      <div class="row">
        <small>{m.translation_now({ source: sourceLabel }, options)}</small
        >{#each sourceChanged[stalePath] ?? [] as part, i (i)}{#if part.mark === 'ins'}<ins
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
  <div class="label-row"><span id="{id}-l">{text}{#if 'required' in field && field.required}<span class="req" aria-hidden="true">*</span>{/if}</span>{#if prose(field)}{@render machineMark(address(at), text)}{/if}</div>
{/snippet}

{#snippet controls(at: readonly string[], i: number, name: string, handle: (node: HTMLElement) => () => void, duplicable = false)}
  <div class="row-controls">
    <button class="btn btn-ghost btn-icon handle" type="button" aria-label={m.field_reorder({ item: name }, messageOptions(uiLocale))} disabled={structureLocked} {@attach handle}>⋮⋮</button>
    {#if duplicable}<button class="btn btn-ghost btn-icon" type="button" aria-label={m.field_duplicate({ item: name }, messageOptions(uiLocale))} disabled={structureLocked} onclick={() => duplicate(at, i)}>⧉</button>{/if}
    <button class="btn btn-ghost btn-icon" type="button" aria-label={m.field_remove({ item: name }, messageOptions(uiLocale))} disabled={structureLocked} onclick={() => drop(at, i)}>×</button>
  </div>
{/snippet}

{#snippet altField(id: string, at: readonly string[])}
  <div class="field"><div class="label-row"><label for="{id}.alt">{m.field_alt_text({}, messageOptions(uiLocale))}</label><span class="mode">{m.field_per_language({}, messageOptions(uiLocale))}</span></div><input class="input" id="{id}.alt" type="text" value={str([...at, 'alt'])} oninput={(e) => write([...at, 'alt'], e.currentTarget.value || undefined)} /></div>
{/snippet}

{#snippet embedThumbnail(value: EmbedValue)}
  {@const still = embedThumb(value)}
  <span class="thumb" style="aspect-ratio: 16 / 9">{#if still}<MediaImage src={still} alt="" loading="lazy" {uiLocale} />{/if}</span>
{/snippet}

{#snippet titleField(id: string, at: readonly string[])}
  <div class="field"><div class="label-row"><label for="{id}.title">{m.field_title({}, messageOptions(uiLocale))}</label><span class="mode">{m.field_per_language({}, messageOptions(uiLocale))}</span></div><input class="input" id="{id}.title" type="text" value={str([...at, 'title'])} oninput={(e) => write([...at, 'title'], e.currentTarget.value || undefined)} /></div>
{/snippet}

{#snippet previews(at: readonly string[])}
  {@const title = str([...at, 'title']) || inheritedSeo?.title || ''}
  {@const said = str([...at, 'description']) || inheritedSeo?.description || ''}
  {@const desc = said.length > SEO_DESCRIPTION_LIMIT ? `${said.slice(0, SEO_DESCRIPTION_LIMIT).trimEnd()} …` : said}
  {@const own = read([...at, 'image']) !== undefined}
  {@const picture = own ? src([...at, 'image']) : inheritedSeo?.image ? `${mediaBase}/${inheritedSeo.image.src}` : ''}
  {@const of = locale.toUpperCase()}
  <div class="previews">
    <div class="preview-box">
      <p class="variant-title">{m.field_seo_search_preview({ locale: of }, messageOptions(uiLocale))}</p>
      <div class="snippet" role="group" aria-label={m.field_seo_search_preview_label({}, messageOptions(uiLocale))}>
        <div class="url"><span class="fav" aria-hidden="true">{host.charAt(0).toUpperCase()}</span><span class="crumbs">{crumbs}</span></div>
        <div class="title">{title}</div>
        <div class="desc">{desc}</div>
      </div>
    </div>
    <div class="preview-box">
      <p class="variant-title">{m.field_seo_social_card({ locale: of }, messageOptions(uiLocale))}</p>
      <div class="social-card" role="group" aria-label={m.field_seo_social_card_label({}, messageOptions(uiLocale))}>
        <div class="thumb">{#if picture}<MediaImage src={picture} alt="" {uiLocale} />{/if}</div>
        <div class="body"><div class="domain">{host}</div><div class="title">{title}</div><div class="desc">{desc}</div></div>
      </div>
    </div>
  </div>
{/snippet}

{#snippet seoWords(id: string, at: readonly string[], key: string, label: string, limit: number, placeholder: string, hint: string)}
  {@const value = str([...at, key])}
  {@const described = [`${id}.${key}-meter`, hint ? `${id}.${key}-hint` : ''].filter(Boolean).join(' ')}
  {@const over = value.trim().length > limit}
  <div class="field">
    <div class="label-row"><label for="{id}.{key}">{label}</label><span class="meter" class:is-over={over} id="{id}.{key}-meter">{value.trim().length ? m.field_seo_meter({ count: value.trim().length, limit }, messageOptions(uiLocale)) : m.field_seo_meter_empty({ limit }, messageOptions(uiLocale))}{over ? ` — ${m.field_seo_may_cut({}, messageOptions(uiLocale))}` : ''}</span></div>
    {#if key === 'description'}
      <textarea class="input textarea" id="{id}.{key}" {placeholder} aria-describedby={described} {value} oninput={(e) => seoWrite(at, key, e.currentTarget.value || undefined)}></textarea>
    {:else}
      <input class="input" id="{id}.{key}" type="text" {placeholder} aria-describedby={described} {value} oninput={(e) => seoWrite(at, key, e.currentTarget.value || undefined)} />
    {/if}
    <div class="gauge" class:is-long={over} aria-hidden="true"><span style="width: {Math.min(100, Math.round((value.trim().length / limit) * 100))}%"></span></div>
    {#if hint}<p class="hint" id="{id}.{key}-hint">{hint}</p>{/if}
  </div>
{/snippet}

{#snippet nameField(id: string, at: readonly string[])}
  <div class="field"><div class="label-row"><label for="{id}.name">{m.field_display_name({}, messageOptions(uiLocale))}</label><span class="mode">{m.field_per_language({}, messageOptions(uiLocale))}</span></div><input class="input" id="{id}.name" type="text" value={str([...at, 'name'])} oninput={(e) => write([...at, 'name'], e.currentTarget.value || undefined)} /></div>
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
          {#each known.locales as of (of)}<span class="chip" class:chip-missing={!found.locales.includes(of)}>{of.toUpperCase()}</span>{/each}
        </span>
      {/if}
      <button class="btn btn-ghost btn-sm remove" type="button" onclick={open}>{m.field_change({}, messageOptions(uiLocale))}</button>
    </div>
  </div>
{/snippet}

{#snippet noEntry(id: string, labelId: string, says: string | undefined, action: string, open: () => void)}
  <div class="list-empty" {id} role="group" aria-labelledby={labelId} aria-describedby={says}>
    <span>{m.field_nothing_chosen({}, messageOptions(uiLocale))}</span>
    <button class="btn btn-sm" type="button" onclick={open}>{action}</button>
  </div>
{/snippet}

{#snippet labelRow(id: string, field: Field, text: string, at: readonly string[] = [])}
  <div class="label-row">
    <label for={id}>{text}{#if 'required' in field && field.required}<span class="req" aria-hidden="true">*</span>{/if}</label>
    {#if prose(field)}{@render machineMark(address(at), text)}{/if}
  </div>
{/snippet}

{#each shown as field (field.path.join('.'))}
  {@const at = [...path, ...field.path]}
  {@const id = `${prefix}-${at.join('.')}`}
  {@const mode = modeOf(field)}
  {@const text = field.label || rowLabel}
  {@const err = problemOf(field, at)}
  {@const bad = err ? 'true' : undefined}
  {@const says = err ? `${id}-err` : undefined}
  {@const marked = [address(at), childAddress(at, 'label')].find((p) => p && opened === p)}
  <div class="field" data-field-type={field.type} id="{id}-field" tabindex="-1" class:is-invalid={err} class:pop-anchor={marked} inert={textOnly && !structural(field) && ((field.type !== 'text' && field.type !== 'richtext') || mode !== true) ? true : undefined}>
    {#if field.type === 'menus'}
      {@render groupLabel(id, field, text, at)}
      <Menus {id} labelId="{id}-l" menus={rows(at) as Menu[]} {locale} {uiLocale} {translating} {sourceLabel} />
    {:else if translating && mode === 'duplicate' && !structural(field)}
      {@render groupLabel(id, field, text, at)}
      <div class="readonly" {id} role="region" tabindex="-1" aria-labelledby="{id}-l">{read(at) ?? ''}</div>
      <p class="hint">{m.field_same_every_language({}, messageOptions(uiLocale))}</p>
    {:else if field.type === 'text'}
      {@render labelRow(id, field, text, at)}
      <TextField {id} invalid={bad} describedBy={says} required={field.required} value={str(at)} onvalue={(value) => write(at, value)} />
    {:else if field.type === 'number'}
      {@render labelRow(id, field, text, at)}
      <input class="input" {id} type="number" step="any" aria-invalid={bad} aria-describedby={says} aria-required={field.required ? 'true' : undefined} value={num(at)} oninput={(e) => write(at, e.currentTarget.value === '' ? undefined : e.currentTarget.valueAsNumber)} />
    {:else if field.type === 'boolean'}
      <label class="switch" for={id}><input type="checkbox" role="switch" {id} aria-invalid={bad} aria-describedby={says} aria-required={field.required ? 'true' : undefined} checked={read(at) === true} onchange={(e) => write(at, e.currentTarget.checked)} /><span>{text}</span></label>
    {:else if field.type === 'date'}
      {@render labelRow(id, field, text, at)}
      <input class="input" {id} type="date" aria-invalid={bad} aria-describedby={says} aria-required={field.required ? 'true' : undefined} value={str(at)} oninput={(e) => write(at, e.currentTarget.value || undefined)} />
    {:else if field.type === 'select'}
      {#if field.options.length <= 5}
        <fieldset aria-describedby={says}>
          <legend>{text}{#if field.required}<span class="req" aria-hidden="true">*</span>{/if}</legend>
          {#each field.options as option (option)}
            <label class="choice"><input type="radio" name={id} value={option} required={field.required} checked={read(at) === option} onchange={() => write(at, option)} /><span>{capitalise(option)}</span></label>
          {/each}
        </fieldset>
      {:else}
        {@render labelRow(id, field, text, at)}
        <select class="input" {id} aria-invalid={bad} aria-describedby={says} aria-required={field.required ? 'true' : undefined} value={str(at)} onchange={(e) => write(at, e.currentTarget.value || undefined)}>
          <option value="">{m.field_choose({}, messageOptions(uiLocale))}</option>
          {#each field.options as option (option)}
            <option value={option}>{capitalise(option)}</option>
          {/each}
        </select>
      {/if}
    {:else if field.type === 'link' && translating}
      <!-- A link's label is the half a translation owns. -->
      {@render groupLabel(id, field, text, at)}
      <div class="field"><div class="label-row"><label for="{id}.label">{m.field_link_label({}, messageOptions(uiLocale))}</label>{@render machineMark(childAddress(at, 'label'), `${text} label`)}</div><input class="input" id="{id}.label" type="text" value={str([...at, 'label'])} oninput={(e) => write([...at, 'label'], e.currentTarget.value || undefined)} /></div>
    {:else if field.type === 'link'}
      {@render groupLabel(id, field, text, at)}
      <div class="link-field-controls">
        <fieldset class="link-destination">
          <legend>{m.field_link_destination({}, messageOptions(uiLocale))}</legend>
          <div class="seg" role="group" aria-label={m.field_link_type({}, messageOptions(uiLocale))}>
            <button type="button" aria-pressed={linkType(at) === 'entry'} onclick={() => setLinkType(at, 'entry')}>{m.field_link_page_entry({}, messageOptions(uiLocale))}</button>
            <button type="button" aria-pressed={linkType(at) === 'url'} onclick={() => setLinkType(at, 'url')}>URL</button>
          </div>
          {#if linkType(at) === 'url'}
            {@const scheme = unsafeLinkScheme('default', str([...at, 'href']))}
            <div class="field" class:is-invalid={scheme}>
              <div class="label-row"><label for="{id}.href">{m.field_link_address({}, messageOptions(uiLocale))}</label></div>
              <input class="input" id="{id}.href" type="url" placeholder={m.field_link_address_placeholder({}, messageOptions(uiLocale))} aria-invalid={scheme ? 'true' : undefined} aria-describedby={scheme ? `${id}.href-err` : undefined} value={str([...at, 'href'])} oninput={(e) => writeMany(at, [{ path: ['type'], value: 'url' }, { path: ['href'], value: e.currentTarget.value }])} />
              {#if scheme}<p class="error" id="{id}.href-err">{m.field_link_scheme_not_allowed({ scheme }, messageOptions(uiLocale))}</p>{/if}
            </div>
          {:else if picker === id}
            <PagePicker {id} label={text} labelId="{id}-l" {uiLocale} chosen={str([...at, 'ref'])} onpick={(e) => { writeMany(at, [{ path: ['type'], value: 'entry' }, { path: ['ref'], value: e.path }]); picker = ''; }} onclose={() => (picker = '')} />
          {:else if str([...at, 'ref'])}
            {@render chosenEntry(`${id}.ref`, `${id}-l`, says, str([...at, 'ref']), () => (picker = id))}
          {:else}
            {@render noEntry(`${id}.ref`, `${id}-l`, says, m.field_link_choose({}, messageOptions(uiLocale)), () => (picker = id))}
          {/if}
        </fieldset>
        <div class="field"><div class="label-row"><label for="{id}.label">{m.field_link_label({}, messageOptions(uiLocale))}</label></div><input class="input" id="{id}.label" type="text" value={str([...at, 'label'])} oninput={(e) => write([...at, 'label'], e.currentTarget.value || undefined)} /></div>
        <label class="check" for="{id}.newTab"><input type="checkbox" id="{id}.newTab" checked={read([...at, 'newTab']) === true} onchange={(e) => write([...at, 'newTab'], e.currentTarget.checked || undefined)} /><span>{m.field_link_new_tab({}, messageOptions(uiLocale))}</span></label>
      </div>
    {:else if field.type === 'richtext'}
      {@render groupLabel(id, field, text, at)}
      <RichText {id} labelId="{id}-l" {locale} {uiLocale} tier={field.tier} invalid={!!err} describedby={says} value={str(at)} address={address(at)} {session} onchange={(md, history) => write(at, md, history)} />
    {:else if field.type === 'group'}
      <details class="group" open>
        <summary>{text}<span class="count">{m.field_count({ count: field.fields.length }, messageOptions(uiLocale))}</span></summary>
        <div class="form"><Fields fields={field.fields} bind:root {blocks} {blockLabels} {problems} path={at} {translating} {machine} {ontranslate} {sourceChanged} {sourceLabel} {translatedAt} {onretranslate} {prefix} {mediaBase} {locale} {uiLocale} {site} {servedAt} {session} {oncommand} viewRoot={displayedRoot} inherited={mode} {structureLocked} {textOnly} /></div>
      </details>
    {:else if field.type === 'array'}
      {@const items = rows(at)}
      {@const scalar = field.item.length === 1 && field.item[0]?.path.length === 0}
      {@const isGallery = gallery(field)}
      {@render groupLabel(id, field, text, at)}
      <div class="list" {id} role="group" aria-labelledby="{id}-l">
        <DragDropProvider onDragStart={(e) => begun(at, e)} onDragOver={(e) => over(at, e)} onDragEnd={(e) => ended(at, e)}>
        {#each items as row, i (keyOf(items, i))}
          {@const s = sortable(() => keyOf(items, i), () => i)}
          <div class="row-card" class:is-dragging={s.isDragging} {@attach s.attach}>
            <div class="row-fields"><Fields fields={field.item} bind:root {blocks} {blockLabels} {problems} path={[...at, String(i)]} rowLabel="{text} {i + 1}" {translating} {machine} {ontranslate} {sourceChanged} {sourceLabel} {translatedAt} {onretranslate} {prefix} {mediaBase} {locale} {uiLocale} {site} {servedAt} {session} {oncommand} viewRoot={displayedRoot} inherited={mode} {structureLocked} {textOnly} /></div>
            {#if !translating}{@render controls(at, i, m.field_row_name({ field: text, index: i + 1 }, messageOptions(uiLocale)), s.attachHandle)}{/if}
          </div>
        {:else}
          <p class="hint">{m.field_list_empty({}, messageOptions(uiLocale))}</p>
        {/each}
        </DragDropProvider>
        {#if !translating}
          <button class="btn btn-sm add" type="button" disabled={structureLocked} onclick={() => (isGallery ? (picker = id) : add(at, scalar ? '' : { _id: newId('default') }))}>{m.field_list_add({ field: text }, messageOptions(uiLocale))}</button>
        {/if}
      </div>
      {#if isGallery && picker === id}
        <Media
          kind="images"
          label={text}
          preset={field.item[0]?.type === 'image' ? field.item[0].preset : {}}
          base={mediaBase}
          many
          {uiLocale}
          onpick={(items) => pickedInto(at, items)}
          onclose={() => (picker = '')}
        />
      {/if}
    {:else if field.type === 'blocks'}
      {@const items = rows(at)}
      {@render groupLabel(id, field, text, at)}
      <div class="list" {id} role="group" aria-labelledby="{id}-l">
        <DragDropProvider onDragStart={(e) => begun(at, e)} onDragOver={(e) => over(at, e)} onDragEnd={(e) => ended(at, e)}>
        {#each items as row, i (keyOf(items, i))}
          {@const name = blockName(row)}
          {@const inner = blockFields(row)}
          {@const s = sortable(() => keyOf(items, i), () => i)}
          {@const open = broken([...at, String(i)])}
          {@const shut = !open && folded[keyOf(items, i)] === true}
          <article class="block-card" id="{id}.{i}" aria-labelledby="{id}.{i}-h" class:is-dragging={s.isDragging} class:is-folded={shut} {@attach s.attach}>
            <header>
              <button class="btn btn-ghost btn-icon fold" type="button" disabled={open} aria-expanded={!shut} aria-controls="{id}.{i}-b" aria-label={shut ? m.field_expand({ item: name }, messageOptions(uiLocale)) : m.field_collapse({ item: name }, messageOptions(uiLocale))} onclick={() => (folded[keyOf(items, i)] = !shut)}>{shut ? '▸' : '▾'}</button>
              <span class="label" id="{id}.{i}-h" title="{block(row)._type} · {block(row)._id}">{block(row)._label || name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase())}</span>
              {#if shut}<span class="excerpt">{excerpt(row, inner)}</span>{/if}
              {#if !translating}{@render controls(at, i, name, s.attachHandle, true)}{/if}
            </header>
            {#if shut}
              <!-- folded: the header is the whole card -->
            {:else if inner}
              <div class="form" id="{id}.{i}-b"><Fields fields={inner} bind:root {blocks} {blockLabels} {problems} path={[...at, String(i)]} {translating} {machine} {ontranslate} {sourceChanged} {sourceLabel} {translatedAt} {onretranslate} {prefix} {mediaBase} {locale} {uiLocale} {site} {servedAt} {session} {oncommand} viewRoot={displayedRoot} inherited={mode} {structureLocked} {textOnly} /></div>
            {:else}
              <p class="ref-note" id="{id}.{i}-b">{block(row)._ref ?? m.field_block_missing({ type: block(row)._type ?? '' }, messageOptions(uiLocale))} — {m.field_not_editable({}, messageOptions(uiLocale))}</p>
            {/if}
          </article>
        {:else}
          <p class="hint">{m.field_list_empty({}, messageOptions(uiLocale))}</p>
        {/each}
        </DragDropProvider>
        {#if !translating}
        <div class="pop-anchor">
          <button class="btn btn-sm add" type="button" disabled={structureLocked} aria-expanded={picker === id} onclick={() => (picker = picker === id ? '' : id)}>{m.field_add_block({}, messageOptions(uiLocale))}</button>
          {#if picker === id}
            <div class="popover block-picker">
              <div class="types">
                {#each field.types as type (type)}
                  <button class="type-card" type="button" value={type} disabled={structureLocked} onclick={() => { add(at, { _type: type, _id: newId('default') }); picker = ''; }}>{labelIn(blockLabels?.[type], uiLocale) ?? type}</button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
        {/if}
      </div>
    {:else if field.type === 'image' && translating}
      <!-- A translation owns the words and not the picture: the alt, and nothing else. -->
      {@render groupLabel(id, field, text, at)}
      <div class="media-card" {id} role="group" tabindex="-1" aria-labelledby="{id}-l">
        <span class="thumb" style="aspect-ratio: {aspect(field.preset)}"><MediaImage src={src(at)} alt="" style="object-position: {dot(at)[0]}% {dot(at)[1]}%" {uiLocale} /><span class="focal" style="left: {dot(at)[0]}%; top: {dot(at)[1]}%" aria-hidden="true"></span></span>
        <div class="meta">
          <div><div class="sub">{str([...at, 'src'])}</div></div>
          {@render altField(id, at)}
          <p class="hint">{m.field_picture_same({}, messageOptions(uiLocale))}</p>
        </div>
      </div>
    {:else if field.type === 'image' && read(at) !== undefined}
      {@render groupLabel(id, field, text, at)}
      <div class="media-card" {id} role="group" tabindex="-1" aria-labelledby="{id}-l">
        <span class="thumb" style="aspect-ratio: {aspect(field.preset)}"><MediaImage src={src(at)} alt="" style="object-position: {dot(at)[0]}% {dot(at)[1]}%" {uiLocale} /><span class="focal" style="left: {dot(at)[0]}%; top: {dot(at)[1]}%" aria-hidden="true"></span></span>
        <div class="meta">
          <div><div class="sub">{str([...at, 'src'])} · {num([...at, 'width'])} × {num([...at, 'height'])}</div></div>
          {@render altField(id, at)}
          <div class="actions">
            <button class="btn btn-sm" type="button" onclick={() => (framing = id)}>{m.field_picture_set_focal({}, messageOptions(uiLocale))}</button>
            <button class="btn btn-sm" type="button" onclick={() => (picker = id)}>{m.field_replace({}, messageOptions(uiLocale))}</button>
            <button class="btn btn-sm btn-ghost" type="button" onclick={() => write(at, undefined)}>{m.field_remove_value({}, messageOptions(uiLocale))}</button>
          </div>
          {#if field.preset.ratio}<p class="hint">{m.field_image_ratio({ ratio: field.preset.ratio }, messageOptions(uiLocale))}</p>{/if}
        </div>
      </div>
    {:else if field.type === 'image'}
      {@render groupLabel(id, field, text, at)}
      <!-- svelte-ignore a11y_no_static_element_interactions -- the child button is the control -->
      <div class="dropzone" role="group" aria-labelledby="{id}-l" aria-describedby={says} ondragover={(e) => e.preventDefault()} ondrop={(e) => dropOn(id, e)}>
        <span>{m.field_image_drop({}, messageOptions(uiLocale))}</span>
        {#if field.preset.ratio || field.preset.min}<span class="hint">{[field.preset.ratio, field.preset.min && m.field_image_min_width({ min: field.preset.min }, messageOptions(uiLocale))].filter(Boolean).join(' · ')}</span>{/if}
        <span class="hint">{m.field_image_formats({ max: field.preset.max ?? 2400 }, messageOptions(uiLocale))}</span>
        <button class="btn btn-sm" type="button" onclick={() => (picker = id)}>{m.field_picture_choose({}, messageOptions(uiLocale))}</button>
      </div>
    {:else if field.type === 'file' && translating}
      <!-- The download is one file for every language; what it is called is not. -->
      {@render groupLabel(id, field, text, at)}
      <div class="media-card is-file" {id} role="group" tabindex="-1" aria-labelledby="{id}-l">
        <div class="file-icon" aria-hidden="true">{(str([...at, 'mime']).split('/').pop() ?? '').toUpperCase()}</div>
        <div class="meta">
          <div><div class="sub">{str([...at, 'src'])}</div></div>
          {@render nameField(id, at)}
          <p class="hint">{m.field_file_same({}, messageOptions(uiLocale))}</p>
        </div>
      </div>
    {:else if field.type === 'file' && read(at) !== undefined}
      {@render groupLabel(id, field, text, at)}
      <div class="media-card is-file" {id} role="group" tabindex="-1" aria-labelledby="{id}-l">
        <div class="file-icon" aria-hidden="true">{(str([...at, 'mime']).split('/').pop() ?? '').toUpperCase()}</div>
        <div class="meta">
          <div><div class="sub">{str([...at, 'src'])} · {bytes(at)} · {str([...at, 'mime'])}</div></div>
          {@render nameField(id, at)}
          <div class="actions">
            <button class="btn btn-sm" type="button" onclick={() => (picker = id)}>{m.field_replace({}, messageOptions(uiLocale))}</button>
            <button class="btn btn-sm btn-ghost" type="button" onclick={() => write(at, undefined)}>{m.field_remove_value({}, messageOptions(uiLocale))}</button>
          </div>
        </div>
      </div>
    {:else if field.type === 'file'}
      {@render groupLabel(id, field, text, at)}
      <!-- svelte-ignore a11y_no_static_element_interactions -- the child button is the control -->
      <div class="dropzone" role="group" aria-labelledby="{id}-l" aria-describedby={says} ondragover={(e) => e.preventDefault()} ondrop={(e) => dropOn(id, e)}>
        <span>{m.field_file_drop({}, messageOptions(uiLocale))}</span>
        <span class="hint">{m.field_file_types({ formats: field.accept.map((mime) => (mime.split('/').pop() ?? '').toUpperCase()).join(', ') }, messageOptions(uiLocale))}</span>
        <button class="btn btn-sm" type="button" onclick={() => (picker = id)}>{m.field_picture_choose({}, messageOptions(uiLocale))}</button>
      </div>
    {:else if field.type === 'reference'}
      {@render groupLabel(id, field, text, at)}
      {#if picker === id}
        <PagePicker {id} label={text} labelId="{id}-l" {uiLocale} collection={field.collection} chosen={str(at)} onpick={(e) => { write(at, e.path); picker = ''; }} onclose={() => (picker = '')} />
      {:else if str(at)}
        {@render chosenEntry(id, `${id}-l`, says, str(at), () => (picker = id))}
      {:else}
        {@render noEntry(id, `${id}-l`, says, m.field_choose_named({ field: text }, messageOptions(uiLocale)), () => (picker = id))}
      {/if}
    {:else if field.type === 'embed' && translating}
      {@const value = embedValue(at)}
      <!-- A translation owns the words and not the video: the title, and nothing else. -->
      {@render groupLabel(id, field, text, at)}
      {#if value}
        <div class="media-card" {id} role="group" aria-labelledby="{id}-l">
          {@render embedThumbnail(value)}
          <div class="meta">
            <div><div class="name"><span class="badge badge-info">{EMBED_LABELS[value.provider]}</span> <span class="sub">{value.id}</span></div></div>
            {@render titleField(id, at)}
            <p class="hint">{m.field_video_same({}, messageOptions(uiLocale))}</p>
          </div>
        </div>
      {:else}
        <p class="hint" {id}>{m.field_list_empty({}, messageOptions(uiLocale))}</p>
      {/if}
    {:else if field.type === 'embed'}
      {@const value = embedValue(at)}
      {#if value && pasting !== id}
        {@render groupLabel(id, field, text, at)}
      {:else}
        <div class="label-row"><label for={id} id="{id}-l">{text}{#if field.required}<span class="req" aria-hidden="true">*</span>{/if}</label></div>
        <input class="input" {id} type="url" placeholder={m.field_embed_placeholder({}, messageOptions(uiLocale))} aria-invalid={refused.id === id ? 'true' : bad} aria-describedby={[refused.id === id ? `${id}-paste` : '', value ? `${id}-keep` : '', says].filter(Boolean).join(' ') || undefined} oninput={(e) => pasteEmbed(at, id, e.currentTarget)} />
        {#if refused.id === id}<p class="error" id="{id}-paste">{embedRefusal(refused.reason)}</p>{/if}
        {#if value}<p class="hint" id="{id}-keep">{m.field_embed_keep_hint({}, messageOptions(uiLocale))}</p>{/if}
      {/if}
      {#if value}
        <div class="media-card" id={pasting === id ? undefined : id} role="group" aria-labelledby="{id}-l" aria-describedby={pasting === id ? undefined : says}>
          {@render embedThumbnail(value)}
          <div class="meta">
            <div><div class="name"><span class="badge badge-info">{EMBED_LABELS[value.provider]}</span> <span class="sub">{value.id}</span></div></div>
            {#if pasting === id}
              <div class="actions"><button class="btn btn-sm btn-ghost" type="button" onclick={() => { pasting = ''; refused = { id: '' }; focusOn(`${id}-change`); }}>{m.field_embed_keep({}, messageOptions(uiLocale))}</button></div>
            {:else}
              {@render titleField(id, at)}
              {#if value.provider !== 'google-maps'}
                <div class="field"><div class="label-row"><label for="{id}.start">{m.field_embed_start({}, messageOptions(uiLocale))}</label></div><input class="input" id="{id}.start" type="number" min="0" step="1" aria-describedby="{id}.start-hint" value={num([...at, 'start'])} oninput={(e) => write([...at, 'start'], e.currentTarget.value === '' ? undefined : e.currentTarget.valueAsNumber)} /><p class="hint" id="{id}.start-hint">{m.field_embed_seconds_optional({}, messageOptions(uiLocale))}</p></div>
              {/if}
              <div class="actions">
                <button class="btn btn-sm" id="{id}-change" type="button" onclick={() => { pasting = id; focusOn(id); }}>{m.field_change({}, messageOptions(uiLocale))}</button>
                <button class="btn btn-sm btn-ghost" type="button" onclick={() => { write(at, undefined); pasting = ''; focusOn(id); }}>{m.field_remove_value({}, messageOptions(uiLocale))}</button>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    {:else if field.type === 'seo' && translating}
      <!-- A translation owns the words a page is found by: title, description, alt. -->
      {@render groupLabel(id, field, text, at)}
      <div class="form" {id} role="group" aria-labelledby="{id}-l" aria-describedby={says}>
        {@render seoWords(id, at, 'title', m.field_seo_search_title({}, messageOptions(uiLocale)), SEO_TITLE_LIMIT, inheritedSeo?.title ?? '', m.field_seo_title_fallback({}, messageOptions(uiLocale)))}
        {@render seoWords(id, at, 'description', m.field_seo_description({}, messageOptions(uiLocale)), SEO_DESCRIPTION_LIMIT, inheritedSeo?.description ?? '', '')}
        {#if read([...at, 'image']) !== undefined}
          <div class="media-card">
            <span class="thumb" style="aspect-ratio: {aspect(SOCIAL_CARD)}"><MediaImage src={src([...at, 'image'])} alt="" style="object-position: {dot([...at, 'image'])[0]}% {dot([...at, 'image'])[1]}%" {uiLocale} /></span>
            <div class="meta">
              {@render altField(`${id}.image`, [...at, 'image'])}
              <p class="hint">{m.field_picture_same({}, messageOptions(uiLocale))}</p>
            </div>
          </div>
        {/if}
        {#if host}{@render previews(at)}{/if}
      </div>
    {:else if field.type === 'seo'}
      {@const image = [...at, 'image']}
      {@const hiding = read([...at, 'noindex']) === true}
      {@const scheme = unsafeLinkScheme('default', str([...at, 'canonical']))}
      {@render groupLabel(id, field, text, at)}
      <div class="form" {id} role="group" aria-labelledby="{id}-l" aria-describedby={says}>
        {@render seoWords(id, at, 'title', m.field_seo_search_title({}, messageOptions(uiLocale)), SEO_TITLE_LIMIT, inheritedSeo?.title ?? '', m.field_seo_pattern_fallback({}, messageOptions(uiLocale)))}
        {@render seoWords(id, at, 'description', m.field_seo_description({}, messageOptions(uiLocale)), SEO_DESCRIPTION_LIMIT, inheritedSeo?.description ?? '', '')}
        <div class="field">
          <div class="label-row"><span id="{id}.image-l">{m.field_seo_social_image({}, messageOptions(uiLocale))}</span><span class="mode">{m.field_same_every_language({}, messageOptions(uiLocale))}</span></div>
          {#if read(image) !== undefined}
            <div class="media-card" id="{id}.image" role="group" tabindex="-1" aria-labelledby="{id}.image-l">
              <span class="thumb" style="aspect-ratio: {aspect(SOCIAL_CARD)}"><MediaImage src={src(image)} alt="" style="object-position: {dot(image)[0]}% {dot(image)[1]}%" {uiLocale} /><span class="focal" style="left: {dot(image)[0]}%; top: {dot(image)[1]}%" aria-hidden="true"></span></span>
              <div class="meta">
                <div><div class="sub">{str([...image, 'src'])} · {num([...image, 'width'])} × {num([...image, 'height'])}</div></div>
                {@render altField(`${id}.image`, image)}
                <div class="actions">
                  <button class="btn btn-sm" type="button" onclick={() => (framing = `${id}.image`)}>{m.field_picture_set_focal({}, messageOptions(uiLocale))}</button>
                  <button class="btn btn-sm" type="button" onclick={() => (picker = `${id}.image`)}>{m.field_replace({}, messageOptions(uiLocale))}</button>
                  <button class="btn btn-sm btn-ghost" type="button" onclick={() => write(image, undefined)}>{inheritedSeo?.image ? m.field_seo_site_default({}, messageOptions(uiLocale)) : m.field_remove_value({}, messageOptions(uiLocale))}</button>
                </div>
              </div>
            </div>
          {:else}
            <!-- svelte-ignore a11y_no_static_element_interactions -- the child button is the control -->
            <div class="dropzone" role="group" aria-labelledby="{id}.image-l" ondragover={(e) => e.preventDefault()} ondrop={(e) => dropOn(`${id}.image`, e)}>
              <span>{inheritedSeo?.image ? m.field_seo_site_card({}, messageOptions(uiLocale)) : m.field_image_drop({}, messageOptions(uiLocale))}</span>
              <span class="hint">{SOCIAL_CARD.ratio} · {m.field_image_min_width({ min: SOCIAL_CARD.min ?? 0 }, messageOptions(uiLocale))}</span>
              <button class="btn btn-sm" type="button" onclick={() => (picker = `${id}.image`)}>{m.field_picture_choose({}, messageOptions(uiLocale))}</button>
            </div>
          {/if}
        </div>
        <div class="field">
          <label class="switch" for="{id}.noindex"><input type="checkbox" role="switch" id="{id}.noindex" checked={hiding} onchange={(e) => seoWrite(at, 'noindex', e.currentTarget.checked)} /><span>{m.field_seo_hide({}, messageOptions(uiLocale))}</span></label>
          {#if hiding}
            <p class="notice notice-warn">{m.field_seo_hide_notice({}, messageOptions(uiLocale))}</p>
          {/if}
        </div>
        {#if host}{@render previews(at)}{/if}
        <details class="group">
          <summary>{m.field_seo_canonical({}, messageOptions(uiLocale))}{#if str([...at, 'canonical'])}<span class="count">{str([...at, 'canonical'])}</span>{/if}</summary>
          <div class="field" class:is-invalid={scheme}>
            <div class="label-row"><label for="{id}.canonical">{m.field_seo_canonical({}, messageOptions(uiLocale))}</label></div>
            <input class="input" id="{id}.canonical" type="url" aria-invalid={scheme ? 'true' : undefined} aria-describedby="{id}.canonical-hint{scheme ? ` ${id}.canonical-err` : ''}" value={str([...at, 'canonical'])} oninput={(e) => seoWrite(at, 'canonical', e.currentTarget.value || undefined)} />
            {#if scheme}<p class="error" id="{id}.canonical-err">{m.field_link_scheme_not_allowed({ scheme }, messageOptions(uiLocale))}</p>{/if}
            <p class="hint" id="{id}.canonical-hint">{m.field_seo_canonical_hint({}, messageOptions(uiLocale))}</p>
          </div>
        </details>
      </div>
    {:else}
      <div class="label-row"><label for={id}>{text}</label></div>
      <p class="hint" {id}>{m.field_not_editable_yet({}, messageOptions(uiLocale))}</p>
    {/if}
    {#if err}<p class="error" id="{id}-err">{err}</p>{/if}
    {#if marked}{@render stale(marked)}{/if}
    {#if framing === id && field.type === 'image'}
      <!-- The page's own dot wins over the library's default and is the same in every language. -->
      <Focal
        name={text}
        url={src(at)}
        focal={point(at)}
        presets={field.preset.ratio ? [{ label: text, preset: field.preset }] : []}
        {uiLocale}
        onsave={(moved) => { write([...at, 'focal'], centred(moved) ? undefined : moved); framing = ''; }}
        onclose={() => (framing = '')}
      />
    {/if}
    {#if framing === `${id}.image` && field.type === 'seo'}
      {@const image = [...at, 'image']}
      <!-- A 1.91:1 card cut from a 3:2 photo loses a band top and bottom. -->
      <Focal
        name={m.field_seo_social_image({}, messageOptions(uiLocale))}
        url={src(image)}
        focal={point(image)}
        presets={[{ label: m.field_seo_social_image({}, messageOptions(uiLocale)), preset: SOCIAL_CARD }]}
        {uiLocale}
        onsave={(moved) => { write([...image, 'focal'], centred(moved) ? undefined : moved); framing = ''; }}
        onclose={() => (framing = '')}
      />
    {/if}
    {#if picker === `${id}.image` && field.type === 'seo'}
      <Media
        kind="images"
        label={m.field_seo_social_image({}, messageOptions(uiLocale))}
        preset={SOCIAL_CARD}
        base={mediaBase}
        {dropped}
        {uiLocale}
        onpick={(items) => { seoWrite(at, 'image', stored('image', items[0] as MediaItem)); picker = ''; dropped = []; }}
        onclose={() => { picker = ''; dropped = []; }}
      />
    {/if}
    {#if picker === id && (field.type === 'image' || field.type === 'file')}
      <Media
        kind={field.type === 'image' ? 'images' : 'files'}
        label={text}
        preset={field.type === 'image' ? field.preset : {}}
        accept={field.type === 'file' ? field.accept : []}
        base={mediaBase}
        {dropped}
        {uiLocale}
        onpick={(items) => picked(at, field.type as 'image' | 'file', items)}
        onclose={() => { picker = ''; dropped = []; }}
      />
    {/if}
  </div>
{/each}
