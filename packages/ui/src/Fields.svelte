<script lang="ts">
import { type DragDropEventHandlers, DragDropProvider } from '@dnd-kit/svelte';
import { createSortable, isSortable } from '@dnd-kit/svelte/sortable';
import {
  EMBED_LABELS,
  type EmbedValue,
  embedThumb,
  type Field,
  fieldAddress,
  newId,
  type Preset,
  parseEmbedUrl,
  type ResolvedSeo,
  SEO_DESCRIPTION_LIMIT,
  SEO_TITLE_LIMIT,
  SOCIAL_CARD,
  seoMeter,
  type Translation,
  unsafeLinkScheme,
  type WordPart,
} from '@handover/core';
import { tick } from 'svelte';
import Fields from './Fields.svelte';
import Focal from './Focal.svelte';
import Media from './Media.svelte';
import Menus, { type Menu } from './Menus.svelte';
import PagePicker, { type Pickable, readPickable } from './PagePicker.svelte';
import RichText from './RichText.svelte';
import { fileSize, type MediaItem } from './upload.js';

type Data = Record<string, unknown>;
let {
  fields,
  root = $bindable(),
  path = [],
  blocks = {},
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
  inheritedSeo,
  site,
  servedAt,
}: {
  fields: readonly Field[];
  root: Data;
  path?: readonly string[];
  /** Fields per block type, keyed as `formOf` returns them. */
  blocks?: Record<string, Field[]>;
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
  /**
   * What the source language has said since this file was translated, by the same address
   * `machine` uses. A field named here carries the amber marker; opening it shows the words.
   */
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
  /**
   * What this page would say with nothing typed in the panel — the site's defaults resolved by
   * the same `resolveSeo` the build runs, so the greyed value and the emitted tag agree. Not
   * handed down the recursion: it belongs to the entry's own `seo` field, which is a tab.
   */
  inheritedSeo?: ResolvedSeo;
  /** The site's origin, for the SEO previews; none, and the panel draws none. */
  site?: string;
  /** The path this language serves the entry at, which the previews print under the origin. */
  servedAt?: string;
} = $props();

const modeOf = (field: Field): Translation => field.i18n ?? inherited;
// A group, an array or a blocks field is walked whatever its own mode says, because a field
// inside it can say otherwise.
const structural = (field: Field) =>
  field.type === 'group' || field.type === 'array' || field.type === 'blocks';
// Widgets a translation has nothing to act on: a `reference` points at the same entry in every
// language, and an unsupported field has no value to show. Neither is given to the second
// language as a picture of the first language's value it cannot change.
const FIXED = new Set(['reference', 'unsupported']);
const shown = $derived(
  translating
    ? fields.filter((f) => structural(f) || (modeOf(f) !== false && !FIXED.has(f.type)))
    : fields,
);

// One picker at a time per form level; the field id says which is open.
let picker = $state('');

// One stale marker open at a time, named by the field's address. Dismiss takes the marker off
// for as long as the screen is open: what would put it back is the source language moving
// again, and that is a reload either way.
let opened = $state('');
let dismissed = $state<string[]>([]);
// It says `role="dialog"`, so it takes focus when it opens and hands it back to the marker when
// it closes; axe scores nothing on either. Escape closes it like any other layer here.
let popover = $state<HTMLElement>();
$effect(() => {
  if (opened) popover?.focus();
});
const behind = (path: string) => !dismissed.includes(path) && sourceChanged[path] !== undefined;
// "20 Aug 10:14". Which English this is, not how long ago — a distance says nothing about that.
const WHEN = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const when = (iso: string) => {
  const at = Date.parse(iso);
  return at ? WHEN.format(at) : '';
};
const close = (path: string, then: (path: string) => void) => {
  const marker = document.getElementById(`stale-${path}`);
  opened = '';
  then(path);
  marker?.focus();
};

// Where the file names this field: `blocks[_id=k3nf9a2p].heading`, which is what `_machine`
// and the machine translation route both address it by. The form knows it by its position.
const address = (at: readonly string[]) => fieldAddress('default', at, root);
// Prose is the half a translation owns — the fields this column draws as something to type in.
// Not conditional on having a machine: the stale marker and the machine badge are worth having
// on a site with nothing to translate with, and only the Translate button is the machine's.
const prose = (field: Field) => translating && (field.type === 'text' || field.type === 'richtext');
// `coastalhomes.example › listings › seaview-cottage`: the address the way a search result prints
// it. The host is read out of `site`, and a `site` that is not an address prints nothing.
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

function read(at: readonly string[]): unknown {
  return at.reduce<unknown>((node, key) => (node as Data | undefined)?.[key], root);
}

// `undefined` removes the key so an optional field left empty is absent, not null.
function write(at: readonly string[], value: unknown) {
  let node = root;
  for (const key of at.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Data;
  }
  const last = at[at.length - 1] as string;
  if (value === undefined) delete node[last];
  else node[last] = value;
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

function add(at: readonly string[], item: unknown) {
  if (Array.isArray(read(at))) list(at).push(item);
  else write(at, [item]);
}
// A scalar row has no `_id`, so its card is keyed by a name of its own that moves with it;
// otherwise a reorder leaves the cards where they are and swaps the words in them.
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
  list(at).splice(index, 1);
  names.get(list(at))?.splice(index, 1);
}
type Handlers = Required<DragDropEventHandlers>;
// The list is rewritten as the card passes over each place it could land, so the others make
// room under it; a drag that is escaped puts the card back where it was picked up.
let origin = -1;
function begun(event: Parameters<Handlers['onDragStart']>[0]) {
  const { source } = event.operation;
  origin = isSortable(source) ? source.index : -1;
}
function over(at: readonly string[], event: Parameters<Handlers['onDragOver']>[0]) {
  const { source, target } = event.operation;
  if (!isSortable(source) || !isSortable(target) || source.index === target.index) return;
  move(list(at), source.index, target.index);
}
function ended(at: readonly string[], event: Parameters<Handlers['onDragEnd']>[0]) {
  const { source } = event.operation;
  if (!event.canceled || !isSortable(source) || origin < 0 || source.index === origin) return;
  move(list(at), source.index, origin);
}
// The handle is the only thing that drags: the row's inputs keep their pointer and keyboard.
// Both arguments are read lazily: an eager read would remake the sortable on every reorder,
// and a sortable born at its new index has no move to animate.
const sortable = (id: () => string, index: () => number) =>
  createSortable({
    get id() {
      return id();
    },
    get index() {
      return index();
    },
    get disabled() {
      return translating;
    },
  });

const block = (row: unknown) =>
  row as { _type?: string; _id?: string; _label?: string; _ref?: string };
// Folded blocks, by the block's own key, so a fold rides along when the block is moved.
let folded = $state<Record<string, boolean>>({});
// A folded card still says what is in it: the first words it holds, in the order its form shows.
function excerpt(row: unknown, inner: Field[] | undefined): string {
  for (const f of inner ?? []) {
    const v = f.path.reduce<unknown>((node, key) => (node as Data | undefined)?.[key], row);
    if (typeof v === 'string' && v.trim()) return v.length > 80 ? `${v.slice(0, 79)}…` : v;
  }
  return '';
}
// A `_ref` block's content lives in a global, and an unknown `_type` has no fields to show;
// both are the same read-only card.
const blockName = (row: unknown) => block(row)._label || block(row)._type || '';
const blockFields = (row: unknown) =>
  block(row)._ref === undefined ? blocks[block(row)._type ?? ''] : undefined;

// A stored reference names an entry this form never picked, so the list is read for its
// title and the languages it has. Only where there is something on screen that needs one.
let known = $state<Pickable>({ entries: [], locales: [] });
$effect(() => {
  if (fields.some((f) => f.type === 'reference' || f.type === 'link'))
    readPickable().then((p) => (known = p));
});

// The picture as this field will show it: `16:9` is already what `aspect-ratio` wants.
const aspect = (preset: Preset) => preset.ratio?.replace(':', ' / ') ?? '4 / 3';
const src = (at: readonly string[]) => `${mediaBase}/${str([...at, 'src'])}`;
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
let refused = $state({ id: '', why: '' });

// A control that replaces itself takes the reader's place with it, so the focus follows the eye:
// onto the box that Change opened, and back onto Change when the box closes. Ids carry dots.
const focusOn = (elementId: string) =>
  void tick().then(() => document.getElementById(elementId)?.focus());

// A hand-edited file can hold anything under an embed key, and a card drawn from half a value
// is worse than the paste box.
function embedValue(at: readonly string[]): EmbedValue | undefined {
  const v = read(at) as EmbedValue | undefined;
  return v && typeof v.id === 'string' && v.provider in EMBED_LABELS ? v : undefined;
}

// A link that is not recognised leaves the value alone: a mistyped one must never empty the
// field. A recognised one replaces the whole value, title included — it named the old video.
function pasteEmbed(at: readonly string[], id: string, input: HTMLInputElement) {
  refused = { id: '', why: '' };
  if (!input.value.trim()) return;
  const parsed = parseEmbedUrl(input.value);
  if ('refused' in parsed) {
    refused = { id, why: parsed.refused };
    return;
  }
  const { provider, id: chosen, start } = parsed.embed;
  // The format's own order, with `title` and `start` left as holes: nothing is written for
  // either until somebody types one, and each keeps its place in the file when they do.
  write(at, { provider, id: chosen, title: undefined, start });
  input.value = '';
  pasting = '';
  focusOn(`${id}-change`);
}
// The format's order, every key a hole: a description typed before a search title must not put
// itself above it in the file. Assigning to a key an object already has keeps its place, so the
// shape is laid down the first time each key is written and nothing is stored for the rest.
const SEO_SHAPE = {
  title: undefined,
  description: undefined,
  image: undefined,
  noindex: undefined,
  canonical: undefined,
};
function seoWrite(at: readonly string[], key: string, value: unknown) {
  const held = read(at) as Record<string, unknown> | undefined;
  if (held === undefined || !(key in held)) write(at, { ...SEO_SHAPE, ...held });
  write([...at, key], value);
}

const bytes = (at: readonly string[]) => fileSize(read([...at, 'bytes']) as number | undefined);

/** One picked asset as the format stores it — and in that order. */
const stored = (type: 'image' | 'file', item: MediaItem) =>
  type === 'image'
    ? // `alt` is left as a hole rather than an empty string: nothing is written for it until
      // somebody types one, and it keeps its place in the file when they do. The dot comes with
      // the picture — it is the library's default, and only where somebody moved it off centre:
      // a page saying "crop around the middle" is the same page saying nothing.
      {
        src: item.src,
        alt: undefined,
        width: item.width,
        height: item.height,
        focal: centred(item.focal) ? undefined : item.focal,
      }
    : { src: item.src, name: item.filename, bytes: item.bytes, mime: item.mime };

/** Nothing to write down: the middle is where a crop holds when no page and no row says otherwise. */
const centred = (focal?: [number, number] | null) =>
  !focal || (focal[0] === 0.5 && focal[1] === 0.5);

function picked(at: readonly string[], type: 'image' | 'file', items: MediaItem[]) {
  write(at, stored(type, items[0] as MediaItem));
  picker = '';
}

// A gallery is an array whose row *is* the picture, so the picker takes several at once and each
// one is a row of its own, in the order they were ticked.
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
  write([...at, 'type'], type);
  write([...at, type === 'url' ? 'ref' : 'href'], undefined);
}
</script>

{#snippet machineMark(path: string, text: string)}
  {#if machine.includes(path)}<span class="badge badge-machine">Machine translated</span>{/if}
  {#if behind(path)}
    <button
      class="stale"
      id="stale-{path}"
      type="button"
      aria-haspopup="dialog"
      aria-expanded={opened === path}
      onclick={() => (opened = opened === path ? '' : path)}
      >{sourceLabel} changed since this was translated</button
    >
  {/if}
  {#if ontranslate}
    <button class="btn btn-ghost btn-translate" type="button" aria-label="Translate {text} from the source language" onclick={() => ontranslate?.(path)}>Translate</button>
  {/if}
{/snippet}

<!-- The source language before and after, so the decision is "does the German still say this?"
     and not "what changed, again?". Both lines are the same word diff read from either end. -->
{#snippet stale(stalePath: string)}
  <div
    class="popover"
    role="dialog"
    tabindex="-1"
    bind:this={popover}
    aria-label="What changed in {sourceLabel}"
    onkeydown={(e) => e.key === 'Escape' && close(stalePath, () => {})}
  >
    <div class="diff">
      <div class="row">
        <small>{sourceLabel}, when translated{translatedAt ? ` · ${when(translatedAt)}` : ''}</small
        >{#each sourceChanged[stalePath] ?? [] as part, i (i)}{#if part.mark === 'del'}<del
            >{part.text}</del
          >{:else if part.mark !== 'ins'}{part.text}{/if}{/each}
      </div>
      <div class="row">
        <small>{sourceLabel}, now</small
        >{#each sourceChanged[stalePath] ?? [] as part, i (i)}{#if part.mark === 'ins'}<ins
            >{part.text}</ins
          >{:else if part.mark !== 'del'}{part.text}{/if}{/each}
      </div>
    </div>
    <!-- The address is read before `opened` moves: a snippet's argument is re-read on demand,
         and closing the popover is what takes this one away. -->
    <div class="actions">
      {#if onretranslate}
        <button class="btn btn-sm" type="button" onclick={() => close(stalePath, onretranslate)}>Re-translate</button>
      {/if}
      <button class="btn btn-sm btn-ghost" type="button" onclick={() => close(stalePath, (p) => (dismissed = [...dismissed, p]))}>Dismiss</button>
    </div>
  </div>
{/snippet}

{#snippet groupLabel(id: string, field: Field, text: string, at: readonly string[] = [])}
  <div class="label-row"><span id="{id}-l">{text}{#if 'required' in field && field.required}<span class="req" aria-hidden="true">*</span>{/if}</span>{#if prose(field)}{@render machineMark(address(at), text)}{/if}</div>
{/snippet}

{#snippet controls(at: readonly string[], i: number, name: string, handle: (node: HTMLElement) => () => void)}
  <div class="row-controls">
    <button class="btn btn-ghost btn-icon handle" type="button" aria-label="Reorder {name}" {@attach handle}>⋮⋮</button>
    <button class="btn btn-ghost btn-icon" type="button" aria-label="Remove {name}" onclick={() => drop(at, i)}>×</button>
  </div>
{/snippet}

{#snippet altField(id: string, at: readonly string[])}
  <div class="field"><div class="label-row"><label for="{id}.alt">Alt text</label><span class="mode">Per language</span></div><input class="input" id="{id}.alt" type="text" value={str([...at, 'alt'])} oninput={(e) => write([...at, 'alt'], e.currentTarget.value || undefined)} /></div>
{/snippet}

{#snippet embedThumbnail(value: EmbedValue)}
  {@const still = embedThumb(value)}
  <span class="thumb" style="aspect-ratio: 16 / 9">{#if still}<img src={still} alt="" loading="lazy" />{/if}</span>
{/snippet}

{#snippet titleField(id: string, at: readonly string[])}
  <div class="field"><div class="label-row"><label for="{id}.title">Title</label><span class="mode">Per language</span></div><input class="input" id="{id}.title" type="text" value={str([...at, 'title'])} oninput={(e) => write([...at, 'title'], e.currentTarget.value || undefined)} /></div>
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
      <p class="variant-title">Search preview · {of}</p>
      <div class="snippet" role="group" aria-label="Search result preview">
        <div class="url"><span class="fav" aria-hidden="true">{host.charAt(0).toUpperCase()}</span><span class="crumbs">{crumbs}</span></div>
        <div class="title">{title}</div>
        <div class="desc">{desc}</div>
      </div>
    </div>
    <div class="preview-box">
      <p class="variant-title">Social card · {of}</p>
      <div class="social-card" role="group" aria-label="Social card preview">
        <div class="thumb">{#if picture}<img src={picture} alt="" />{/if}</div>
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
    <div class="label-row"><label for="{id}.{key}">{label}</label><span class="meter" class:is-over={over} id="{id}.{key}-meter">{seoMeter(value, limit)}</span></div>
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
  <div class="field"><div class="label-row"><label for="{id}.name">Display name</label><span class="mode">Per language</span></div><input class="input" id="{id}.name" type="text" value={str([...at, 'name'])} oninput={(e) => write([...at, 'name'], e.currentTarget.value || undefined)} /></div>
{/snippet}

{#snippet chosenEntry(id: string, labelId: string, says: string | undefined, ref: string, open: () => void)}
  {@const found = known.entries.find((e) => e.path === ref)}
  <div class="ref-list" {id} role="group" aria-labelledby={labelId} aria-describedby={says}>
    <div class="ref-item">
      <span class="title">{found?.title ?? ref}</span>
      {#if found}
        <span class="chips">
          {#each known.locales as of (of)}<span class="chip" class:chip-missing={!found.locales.includes(of)}>{of.toUpperCase()}</span>{/each}
        </span>
      {/if}
      <span class="path">{ref}</span>
      <button class="btn btn-ghost btn-sm remove" type="button" onclick={open}>Change</button>
    </div>
  </div>
{/snippet}

{#snippet noEntry(id: string, labelId: string, says: string | undefined, text: string, open: () => void)}
  <div class="list-empty" {id} role="group" aria-labelledby={labelId} aria-describedby={says}>
    <span>Nothing chosen yet</span>
    <button class="btn btn-sm" type="button" onclick={open}>Choose {text}</button>
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
  {@const err = problems[at.join('.')]}
  {@const bad = err ? 'true' : undefined}
  {@const says = err ? `${id}-err` : undefined}
  {@const marked = [address(at), `${address(at)}.label`].find((p) => opened === p)}
  <div class="field" class:is-invalid={err} class:pop-anchor={marked}>
    {#if field.type === 'menus'}
      {@render groupLabel(id, field, text, at)}
      <Menus {id} labelId="{id}-l" menus={rows(at) as Menu[]} {locale} {translating} />
    {:else if translating && mode === 'duplicate' && !structural(field)}
      {@render groupLabel(id, field, text, at)}
      <div class="readonly" {id} role="region" tabindex="-1" aria-labelledby="{id}-l">{read(at) ?? ''}</div>
      <p class="hint">Same in every language</p>
    {:else if field.type === 'text'}
      {@render labelRow(id, field, text, at)}
      {#if str(at).length > 80 || str(at).includes('\n')}
        <textarea class="input textarea" {id} aria-invalid={bad} aria-describedby={says} value={str(at)} oninput={(e) => write(at, e.currentTarget.value)}></textarea>
      {:else}
        <input class="input" {id} type="text" aria-invalid={bad} aria-describedby={says} value={str(at)} oninput={(e) => write(at, e.currentTarget.value)} />
      {/if}
    {:else if field.type === 'number'}
      {@render labelRow(id, field, text, at)}
      <input class="input" {id} type="number" step="any" aria-invalid={bad} aria-describedby={says} value={num(at)} oninput={(e) => write(at, e.currentTarget.value === '' ? undefined : e.currentTarget.valueAsNumber)} />
    {:else if field.type === 'boolean'}
      <label class="switch" for={id}><input type="checkbox" role="switch" {id} aria-invalid={bad} aria-describedby={says} checked={read(at) === true} onchange={(e) => write(at, e.currentTarget.checked)} /><span>{text}</span></label>
    {:else if field.type === 'date'}
      {@render labelRow(id, field, text, at)}
      <input class="input" {id} type="date" aria-invalid={bad} aria-describedby={says} value={str(at)} oninput={(e) => write(at, e.currentTarget.value || undefined)} />
    {:else if field.type === 'select'}
      {#if field.options.length <= 5}
        <fieldset aria-describedby={says}>
          <legend>{text}{#if field.required}<span class="req" aria-hidden="true">*</span>{/if}</legend>
          {#each field.options as option (option)}
            <label class="choice"><input type="radio" name={id} value={option} checked={read(at) === option} onchange={() => write(at, option)} /><span>{capitalise(option)}</span></label>
          {/each}
        </fieldset>
      {:else}
        {@render labelRow(id, field, text, at)}
        <select class="input" {id} aria-invalid={bad} aria-describedby={says} value={str(at)} onchange={(e) => write(at, e.currentTarget.value || undefined)}>
          <option value="">Choose…</option>
          {#each field.options as option (option)}
            <option value={option}>{capitalise(option)}</option>
          {/each}
        </select>
      {/if}
    {:else if field.type === 'link' && translating}
      <!-- A link's label is the half a translation owns; where it points is the same everywhere. -->
      {@render groupLabel(id, field, text, at)}
      <div class="field"><div class="label-row"><label for="{id}.label">Label</label>{@render machineMark(`${address(at)}.label`, `${text} label`)}</div><input class="input" id="{id}.label" type="text" value={str([...at, 'label'])} oninput={(e) => write([...at, 'label'], e.currentTarget.value || undefined)} /></div>
    {:else if field.type === 'link'}
      {@render groupLabel(id, field, text, at)}
      <div class="seg" role="group" aria-label="Link type">
        <button type="button" aria-pressed={linkType(at) === 'entry'} onclick={() => setLinkType(at, 'entry')}>Page / Entry</button>
        <button type="button" aria-pressed={linkType(at) === 'url'} onclick={() => setLinkType(at, 'url')}>URL</button>
      </div>
      {#if linkType(at) === 'url'}
        {@const scheme = unsafeLinkScheme('default', str([...at, 'href']))}
        <div class="field" class:is-invalid={scheme}>
          <div class="label-row"><label for="{id}.href">URL</label></div>
          <input class="input" id="{id}.href" type="url" aria-invalid={scheme ? 'true' : undefined} aria-describedby={scheme ? `${id}.href-err` : undefined} value={str([...at, 'href'])} oninput={(e) => { write([...at, 'type'], 'url'); write([...at, 'href'], e.currentTarget.value); }} />
          {#if scheme}<p class="error" id="{id}.href-err">{scheme}: links are not allowed</p>{/if}
        </div>
      {:else if picker === id}
        <PagePicker {id} label={text} labelId="{id}-l" chosen={str([...at, 'ref'])} onpick={(e) => { write([...at, 'type'], 'entry'); write([...at, 'ref'], e.path); picker = ''; }} onclose={() => (picker = '')} />
      {:else if str([...at, 'ref'])}
        {@render chosenEntry(`${id}.ref`, `${id}-l`, says, str([...at, 'ref']), () => (picker = id))}
      {:else}
        {@render noEntry(`${id}.ref`, `${id}-l`, says, 'a page or entry', () => (picker = id))}
      {/if}
      <div class="field"><div class="label-row"><label for="{id}.label">Label</label></div><input class="input" id="{id}.label" type="text" value={str([...at, 'label'])} oninput={(e) => write([...at, 'label'], e.currentTarget.value || undefined)} /></div>
      <label class="check" for="{id}.newTab"><input type="checkbox" id="{id}.newTab" checked={read([...at, 'newTab']) === true} onchange={(e) => write([...at, 'newTab'], e.currentTarget.checked || undefined)} /><span>Open in new tab</span></label>
    {:else if field.type === 'richtext'}
      {@render groupLabel(id, field, text, at)}
      <RichText {id} labelId="{id}-l" {locale} tier={field.tier} invalid={!!err} describedby={says} value={str(at)} onchange={(md) => write(at, md)} />
    {:else if field.type === 'group'}
      <details class="group" open>
        <summary>{text}<span class="count">{field.fields.length} fields</span></summary>
        <div class="form"><Fields fields={field.fields} bind:root {blocks} {problems} path={at} {translating} {machine} {ontranslate} {sourceChanged} {sourceLabel} {translatedAt} {onretranslate} {prefix} {mediaBase} {locale} {site} {servedAt} inherited={mode} /></div>
      </details>
    {:else if field.type === 'array'}
      {@const items = rows(at)}
      {@const scalar = field.item.length === 1 && field.item[0]?.path.length === 0}
      {@const isGallery = gallery(field)}
      {@render groupLabel(id, field, text, at)}
      <div class="list" {id} role="group" aria-labelledby="{id}-l">
        <DragDropProvider onDragStart={begun} onDragOver={(e) => over(at, e)} onDragEnd={(e) => ended(at, e)}>
        {#each items as row, i (keyOf(items, i))}
          {@const s = sortable(() => keyOf(items, i), () => i)}
          <div class="row-card" class:is-dragging={s.isDragging} {@attach s.attach}>
            <div class="row-fields"><Fields fields={field.item} bind:root {blocks} {problems} path={[...at, String(i)]} rowLabel="{text} {i + 1}" {translating} {machine} {ontranslate} {sourceChanged} {sourceLabel} {translatedAt} {onretranslate} {prefix} {mediaBase} {locale} {site} {servedAt} inherited={mode} /></div>
            {#if !translating}{@render controls(at, i, `${text} row ${i + 1}`, s.attachHandle)}{/if}
          </div>
        {:else}
          <p class="hint">Nothing here yet</p>
        {/each}
        </DragDropProvider>
        {#if !translating}
          <button class="btn btn-sm add" type="button" onclick={() => (isGallery ? (picker = id) : add(at, scalar ? '' : { _id: newId('default') }))}>Add to {text}</button>
        {/if}
      </div>
      {#if isGallery && picker === id}
        <Media
          kind="images"
          label={text}
          preset={field.item[0]?.type === 'image' ? field.item[0].preset : {}}
          base={mediaBase}
          many
          onpick={(items) => pickedInto(at, items)}
          onclose={() => (picker = '')}
        />
      {/if}
    {:else if field.type === 'blocks'}
      {@const items = rows(at)}
      {@render groupLabel(id, field, text, at)}
      <div class="list" {id} role="group" aria-labelledby="{id}-l">
        <DragDropProvider onDragStart={begun} onDragOver={(e) => over(at, e)} onDragEnd={(e) => ended(at, e)}>
        {#each items as row, i (keyOf(items, i))}
          {@const name = blockName(row)}
          {@const inner = blockFields(row)}
          {@const s = sortable(() => keyOf(items, i), () => i)}
          {@const shut = folded[keyOf(items, i)] === true}
          <article class="block-card" id="{id}.{i}" aria-labelledby="{id}.{i}-h" class:is-dragging={s.isDragging} class:is-folded={shut} {@attach s.attach}>
            <header>
              <button class="btn btn-ghost btn-icon fold" type="button" aria-expanded={!shut} aria-controls="{id}.{i}-b" aria-label="{shut ? 'Expand' : 'Collapse'} {name}" onclick={() => (folded[keyOf(items, i)] = !shut)}>{shut ? '▸' : '▾'}</button>
              <span class="label" id="{id}.{i}-h">{name}</span>
              <span class="type">{block(row)._type} · {block(row)._id}</span>
              {#if shut}<span class="excerpt">{excerpt(row, inner)}</span>{/if}
              {#if !translating}{@render controls(at, i, name, s.attachHandle)}{/if}
            </header>
            {#if shut}
              <!-- folded: the header is the whole card -->
            {:else if inner}
              <div class="form" id="{id}.{i}-b"><Fields fields={inner} bind:root {blocks} {problems} path={[...at, String(i)]} {translating} {machine} {ontranslate} {sourceChanged} {sourceLabel} {translatedAt} {onretranslate} {prefix} {mediaBase} {locale} {site} {servedAt} inherited={mode} /></div>
            {:else}
              <p class="ref-note" id="{id}.{i}-b">{block(row)._ref ?? `No “${block(row)._type}” block in the registry`} — not editable here</p>
            {/if}
          </article>
        {:else}
          <p class="hint">Nothing here yet</p>
        {/each}
        </DragDropProvider>
        {#if !translating}
        <div class="pop-anchor">
          <button class="btn btn-sm add" type="button" aria-expanded={picker === id} onclick={() => (picker = picker === id ? '' : id)}>Add block</button>
          {#if picker === id}
            <div class="popover block-picker">
              <div class="types">
                {#each field.types as type (type)}
                  <button class="type-card" type="button" value={type} onclick={() => { add(at, { _type: type, _id: newId('default') }); picker = ''; }}>{type}</button>
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
      <div class="media-card" role="group" aria-labelledby="{id}-l">
        <span class="thumb" style="aspect-ratio: {aspect(field.preset)}"><img src={src(at)} alt="" style="object-position: {dot(at)[0]}% {dot(at)[1]}%" /><span class="focal" style="left: {dot(at)[0]}%; top: {dot(at)[1]}%" aria-hidden="true"></span></span>
        <div class="meta">
          <div><div class="sub">{str([...at, 'src'])}</div></div>
          {@render altField(id, at)}
          <p class="hint">The picture is the same in every language.</p>
        </div>
      </div>
    {:else if field.type === 'image' && read(at) !== undefined}
      {@render groupLabel(id, field, text, at)}
      <div class="media-card" role="group" aria-labelledby="{id}-l">
        <span class="thumb" style="aspect-ratio: {aspect(field.preset)}"><img src={src(at)} alt="" style="object-position: {dot(at)[0]}% {dot(at)[1]}%" /><span class="focal" style="left: {dot(at)[0]}%; top: {dot(at)[1]}%" aria-hidden="true"></span></span>
        <div class="meta">
          <div><div class="sub">{str([...at, 'src'])} · {num([...at, 'width'])} × {num([...at, 'height'])}</div></div>
          {@render altField(id, at)}
          <div class="actions">
            <button class="btn btn-sm" type="button" onclick={() => (framing = id)}>Set focal point</button>
            <button class="btn btn-sm" type="button" onclick={() => (picker = id)}>Replace</button>
            <button class="btn btn-sm btn-ghost" type="button" onclick={() => write(at, undefined)}>Remove</button>
          </div>
          {#if field.preset.ratio}<p class="hint">Shown at {field.preset.ratio} wherever this field appears.</p>{/if}
        </div>
      </div>
    {:else if field.type === 'image'}
      {@render groupLabel(id, field, text, at)}
      <!-- svelte-ignore a11y_no_static_element_interactions -- the button inside is the control; the zone is a drop target -->
      <div class="dropzone" role="group" aria-labelledby="{id}-l" aria-describedby={says} ondragover={(e) => e.preventDefault()} ondrop={(e) => dropOn(id, e)}>
        <span>Drop an image or choose from library</span>
        {#if field.preset.ratio || field.preset.min}<span class="hint">{[field.preset.ratio, field.preset.min && `at least ${field.preset.min} px wide`].filter(Boolean).join(' · ')}</span>{/if}
        <span class="hint">JPEG, PNG or WebP · saved at up to {field.preset.max ?? 2400} px wide</span>
        <button class="btn btn-sm" type="button" onclick={() => (picker = id)}>Choose from library</button>
      </div>
    {:else if field.type === 'file' && translating}
      <!-- The download is one file for every language; what it is called is not. -->
      {@render groupLabel(id, field, text, at)}
      <div class="media-card is-file" role="group" aria-labelledby="{id}-l">
        <div class="file-icon" aria-hidden="true">{(str([...at, 'mime']).split('/').pop() ?? '').toUpperCase()}</div>
        <div class="meta">
          <div><div class="sub">{str([...at, 'src'])}</div></div>
          {@render nameField(id, at)}
          <p class="hint">The same file in every language.</p>
        </div>
      </div>
    {:else if field.type === 'file' && read(at) !== undefined}
      {@render groupLabel(id, field, text, at)}
      <div class="media-card is-file" role="group" aria-labelledby="{id}-l">
        <div class="file-icon" aria-hidden="true">{(str([...at, 'mime']).split('/').pop() ?? '').toUpperCase()}</div>
        <div class="meta">
          <div><div class="sub">{str([...at, 'src'])} · {bytes(at)} · {str([...at, 'mime'])}</div></div>
          {@render nameField(id, at)}
          <div class="actions">
            <button class="btn btn-sm" type="button" onclick={() => (picker = id)}>Replace</button>
            <button class="btn btn-sm btn-ghost" type="button" onclick={() => write(at, undefined)}>Remove</button>
          </div>
        </div>
      </div>
    {:else if field.type === 'file'}
      {@render groupLabel(id, field, text, at)}
      <!-- svelte-ignore a11y_no_static_element_interactions -- the button inside is the control; the zone is a drop target -->
      <div class="dropzone" role="group" aria-labelledby="{id}-l" aria-describedby={says} ondragover={(e) => e.preventDefault()} ondrop={(e) => dropOn(id, e)}>
        <span>Drop a file or choose from library</span>
        <span class="hint">{field.accept.map((m) => (m.split('/').pop() ?? '').toUpperCase()).join(', ')} up to 10 MB</span>
        <button class="btn btn-sm" type="button" onclick={() => (picker = id)}>Choose from library</button>
      </div>
    {:else if field.type === 'reference'}
      {@render groupLabel(id, field, text, at)}
      {#if picker === id}
        <PagePicker {id} label={text} labelId="{id}-l" collection={field.collection} chosen={str(at)} onpick={(e) => { write(at, e.path); picker = ''; }} onclose={() => (picker = '')} />
      {:else if str(at)}
        {@render chosenEntry(id, `${id}-l`, says, str(at), () => (picker = id))}
      {:else}
        {@render noEntry(id, `${id}-l`, says, text, () => (picker = id))}
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
            <p class="hint">The same video in every language.</p>
          </div>
        </div>
      {:else}
        <p class="hint" {id}>Nothing here yet</p>
      {/if}
    {:else if field.type === 'embed'}
      {@const value = embedValue(at)}
      {#if value && pasting !== id}
        {@render groupLabel(id, field, text, at)}
      {:else}
        <div class="label-row"><label for={id} id="{id}-l">{text}{#if field.required}<span class="req" aria-hidden="true">*</span>{/if}</label></div>
        <input class="input" {id} type="url" placeholder="Paste a YouTube, Vimeo or Google Maps link" aria-invalid={refused.id === id ? 'true' : bad} aria-describedby={[refused.id === id ? `${id}-paste` : '', value ? `${id}-keep` : '', says].filter(Boolean).join(' ') || undefined} oninput={(e) => pasteEmbed(at, id, e.currentTarget)} />
        {#if refused.id === id}<p class="error" id="{id}-paste">{refused.why}</p>{/if}
        {#if value}<p class="hint" id="{id}-keep">Still showing the video below until a new link is recognised.</p>{/if}
      {/if}
      {#if value}
        <div class="media-card" id={pasting === id ? undefined : id} role="group" aria-labelledby="{id}-l" aria-describedby={pasting === id ? undefined : says}>
          {@render embedThumbnail(value)}
          <div class="meta">
            <div><div class="name"><span class="badge badge-info">{EMBED_LABELS[value.provider]}</span> <span class="sub">{value.id}</span></div></div>
            {#if pasting === id}
              <div class="actions"><button class="btn btn-sm btn-ghost" type="button" onclick={() => { pasting = ''; refused = { id: '', why: '' }; focusOn(`${id}-change`); }}>Keep this one</button></div>
            {:else}
              {@render titleField(id, at)}
              {#if value.provider !== 'google-maps'}
                <div class="field"><div class="label-row"><label for="{id}.start">Start at</label></div><input class="input" id="{id}.start" type="number" min="0" step="1" aria-describedby="{id}.start-hint" value={num([...at, 'start'])} oninput={(e) => write([...at, 'start'], e.currentTarget.value === '' ? undefined : e.currentTarget.valueAsNumber)} /><p class="hint" id="{id}.start-hint">Seconds, optional</p></div>
              {/if}
              <div class="actions">
                <button class="btn btn-sm" id="{id}-change" type="button" onclick={() => { pasting = id; focusOn(id); }}>Change</button>
                <button class="btn btn-sm btn-ghost" type="button" onclick={() => { write(at, undefined); pasting = ''; focusOn(id); }}>Remove</button>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    {:else if field.type === 'seo' && translating}
      <!-- A translation owns the words a page is found by and nothing else: the search title,
           the description, and what the picture is of. -->
      {@render groupLabel(id, field, text, at)}
      <div class="form" {id} role="group" aria-labelledby="{id}-l" aria-describedby={says}>
        {@render seoWords(id, at, 'title', 'Search title', SEO_TITLE_LIMIT, inheritedSeo?.title ?? '', 'Leave empty to use the page title.')}
        {@render seoWords(id, at, 'description', 'Description', SEO_DESCRIPTION_LIMIT, inheritedSeo?.description ?? '', '')}
        {#if read([...at, 'image']) !== undefined}
          <div class="media-card">
            <span class="thumb" style="aspect-ratio: {aspect(SOCIAL_CARD)}"><img src={src([...at, 'image'])} alt="" style="object-position: {dot([...at, 'image'])[0]}% {dot([...at, 'image'])[1]}%" /></span>
            <div class="meta">
              {@render altField(`${id}.image`, [...at, 'image'])}
              <p class="hint">The same picture in every language.</p>
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
        {@render seoWords(id, at, 'title', 'Search title', SEO_TITLE_LIMIT, inheritedSeo?.title ?? '', 'Leave empty to use the page title and the site’s own pattern.')}
        {@render seoWords(id, at, 'description', 'Description', SEO_DESCRIPTION_LIMIT, inheritedSeo?.description ?? '', '')}
        <div class="field">
          <div class="label-row"><span id="{id}.image-l">Social image</span><span class="mode">Same in every language</span></div>
          {#if read(image) !== undefined}
            <div class="media-card" role="group" aria-labelledby="{id}.image-l">
              <span class="thumb" style="aspect-ratio: {aspect(SOCIAL_CARD)}"><img src={src(image)} alt="" style="object-position: {dot(image)[0]}% {dot(image)[1]}%" /><span class="focal" style="left: {dot(image)[0]}%; top: {dot(image)[1]}%" aria-hidden="true"></span></span>
              <div class="meta">
                <div><div class="sub">{str([...image, 'src'])} · {num([...image, 'width'])} × {num([...image, 'height'])}</div></div>
                {@render altField(`${id}.image`, image)}
                <div class="actions">
                  <button class="btn btn-sm" type="button" onclick={() => (framing = `${id}.image`)}>Set focal point</button>
                  <button class="btn btn-sm" type="button" onclick={() => (picker = `${id}.image`)}>Replace</button>
                  <button class="btn btn-sm btn-ghost" type="button" onclick={() => write(image, undefined)}>{inheritedSeo?.image ? 'Use the site’s default' : 'Remove'}</button>
                </div>
              </div>
            </div>
          {:else}
            <!-- svelte-ignore a11y_no_static_element_interactions -- the button inside is the control; the zone is a drop target -->
            <div class="dropzone" role="group" aria-labelledby="{id}.image-l" ondragover={(e) => e.preventDefault()} ondrop={(e) => dropOn(`${id}.image`, e)}>
              <span>{inheritedSeo?.image ? 'The site’s own card is shared for this page' : 'Drop an image or choose from library'}</span>
              <span class="hint">{SOCIAL_CARD.ratio} · at least {SOCIAL_CARD.min} px wide</span>
              <button class="btn btn-sm" type="button" onclick={() => (picker = `${id}.image`)}>Choose from library</button>
            </div>
          {/if}
        </div>
        <div class="field">
          <label class="switch" for="{id}.noindex"><input type="checkbox" role="switch" id="{id}.noindex" checked={hiding} onchange={(e) => seoWrite(at, 'noindex', e.currentTarget.checked)} /><span>Hide this page from search engines</span></label>
          {#if hiding}
            <p class="notice notice-warn">This page is left out of the sitemap and search engines are asked not to list it. It stays on the site: anybody with the link can still open it, and it can take a few weeks to drop out of results.</p>
          {/if}
        </div>
        {#if host}{@render previews(at)}{/if}
        <details class="group">
          <summary>Canonical URL{#if str([...at, 'canonical'])}<span class="count">{str([...at, 'canonical'])}</span>{/if}</summary>
          <div class="field" class:is-invalid={scheme}>
            <div class="label-row"><label for="{id}.canonical">Canonical URL</label></div>
            <input class="input" id="{id}.canonical" type="url" aria-invalid={scheme ? 'true' : undefined} aria-describedby="{id}.canonical-hint{scheme ? ` ${id}.canonical-err` : ''}" value={str([...at, 'canonical'])} oninput={(e) => seoWrite(at, 'canonical', e.currentTarget.value || undefined)} />
            {#if scheme}<p class="error" id="{id}.canonical-err">{scheme}: links are not allowed</p>{/if}
            <p class="hint" id="{id}.canonical-hint">Only set this when the same page lives at another address.</p>
          </div>
        </details>
      </div>
    {:else}
      <div class="label-row"><label for={id}>{text}</label></div>
      <p class="hint" {id}>Not editable here yet</p>
    {/if}
    {#if err}<p class="error" id="{id}-err">{err}</p>{/if}
    {#if marked}{@render stale(marked)}{/if}
    {#if framing === id && field.type === 'image'}
      <!-- The page's own dot, over the field's own shape. It wins over the library's default
           for this page, and it is the same picture in every language. -->
      <Focal
        name={text}
        url={src(at)}
        focal={point(at)}
        presets={field.preset.ratio ? [{ label: text, preset: field.preset }] : []}
        onsave={(moved) => { write([...at, 'focal'], centred(moved) ? undefined : moved); framing = ''; }}
        onclose={() => (framing = '')}
      />
    {/if}
    {#if framing === `${id}.image` && field.type === 'seo'}
      {@const image = [...at, 'image']}
      <!-- A 1.91:1 card cut from a 3:2 photo loses a band top and bottom, so the card has the
           same dot a field's picture has, and it lives in the same place. -->
      <Focal
        name="Social image"
        url={src(image)}
        focal={point(image)}
        presets={[{ label: 'Social image', preset: SOCIAL_CARD }]}
        onsave={(moved) => { write([...image, 'focal'], centred(moved) ? undefined : moved); framing = ''; }}
        onclose={() => (framing = '')}
      />
    {/if}
    {#if picker === `${id}.image` && field.type === 'seo'}
      <Media
        kind="images"
        label="Social image"
        preset={SOCIAL_CARD}
        base={mediaBase}
        {dropped}
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
        onpick={(items) => picked(at, field.type as 'image' | 'file', items)}
        onclose={() => { picker = ''; dropped = []; }}
      />
    {/if}
  </div>
{/each}
