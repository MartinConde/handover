<script lang="ts">
import {
  type EmbedRefusalReason,
  type Field,
  type Form,
  fieldAddress,
  labelIn,
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
import type { MediaItem } from '../../media/upload.js';
import * as m from '../../paraglide/messages.js';
import type { FieldHistory } from '../entry-history.svelte';
import type {
  EntrySession,
  FieldChange,
  FieldCommandResult,
  ListCommandResult,
} from '../entry-session.svelte';
import EmbedField from './EmbedField.svelte';
import Fields from './Fields.svelte';
import FileField from './FileField.svelte';
import { type Data, type FieldLevel, readFrom, stored } from './field-level.js';
import ImageField from './ImageField.svelte';
import LinkField from './LinkField.svelte';
import ListField from './ListField.svelte';
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
  // Keyed as `formOf` returns them.
  blocks?: Record<string, Field[]>;
  blockLabels?: Form['blockLabels'];
  // What the collection schema will not accept, by the same dotted path the ids use.
  problems?: Record<string, string>;
  // Names a field whose own path is empty: one scalar row of an array.
  rowLabel?: string;
  // This is a language the entry is translated into: it owns its words and nothing else.
  translating?: boolean;
  // The paths a machine's words are still standing at: the file's `_machine`.
  machine?: string[];
  // Absent when the site has nothing to translate with.
  ontranslate?: (path: string) => void;
  // What the source language changed since translation, by the address `machine` uses.
  sourceChanged?: Record<string, WordPart[]>;
  // Markers the reader has dismissed; the pane owns the list so its to-do agrees with it.
  dismissed?: string[];
  // What the source language is called, for the two lines the marker opens.
  sourceLabel?: string;
  // The older line's timestamp: when somebody translated this file.
  translatedAt?: string;
  // Re-translates from the source as it reads now.
  onretranslate?: (path: string) => void;
  // The translation mode the fields inherit; a group hands its own down.
  inherited?: Translation;
  // Starts the field ids; two forms on one screen cannot share it.
  prefix?: string;
  // Where a stored media key is served from; without it a thumbnail has no source.
  mediaBase?: string;
  // The language this column writes: what a link typed into rich text has to point at.
  locale?: string;
  uiLocale?: UiLocale;
  // Resolved by the build's own `resolveSeo`, so the greyed value and the emitted tag agree.
  inheritedSeo?: ResolvedSeo;
  // The site's origin, for the SEO previews; none, and the panel draws none.
  site?: string;
  // The path this language serves the entry at; the previews print it under the origin.
  servedAt?: string;
  // Production writes cross this entry-lifetime boundary; omission is for isolated fixtures.
  session?: EntrySession;
  // Receives acknowledgements and explicit refusals for inspector/Canvas consumers.
  oncommand?: (result: FieldCommandResult | ListCommandResult) => void;
  // A changing request opens this level's single image field without an extra inspector click.
  openMediaPicker?: number;
  onreveal?: (path: readonly string[]) => void;
  // A drag-only rendering copy shared with recursive field levels.
  viewRoot?: Data;
  // A persisted action may allow prose edits while freezing list structure.
  structureLocked?: boolean;
  // During machine translation, only plain and rich source prose remains editable.
  textOnly?: boolean;
  // Another language's words, drawn read only under each translated field.
  reference?: Reference;
  // Drawn right under the entry's title field: the editor puts the address there.
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

let opened = $state('');
// Dismiss lasts for the screen's life: what would bring the marker back is a reload anyway.
const behind = (path: string) => !dismissed.includes(path) && sourceChanged[path] !== undefined;
const when = (iso: string) => {
  const at = Date.parse(iso);
  return at ? formatFieldTime(at, uiLocale) : '';
};
// Read the marker before `opened` moves: closing is what takes the argument away.
const close = (path: string, then: (path: string) => void) => {
  const marker = document.getElementById(`stale-${path}`);
  opened = '';
  then(path);
  marker?.focus();
};

// `_machine` and the translation route name a field by file address, not form position.
const address = (at: readonly string[]) => fieldAddress(at, root) ?? '';
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

// One widget action is one command even when it changes several stored properties.
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
// This page's own dot, in percentages; the middle is what a page that set none crops around.
const point = (at: readonly string[]): [number, number] => {
  const stored = read([...at, 'focal']);
  const [x, y] = Array.isArray(stored) ? (stored as unknown[]) : [];
  return [typeof x === 'number' ? x : 0.5, typeof y === 'number' ? y : 0.5];
};
// One paste box and one paste refusal per level, by field id.
let pasting = $state('');
let refused = $state<{ id: string; reason?: EmbedRefusalReason }>({ id: '' });

function picked(at: readonly string[], type: 'image' | 'file', items: MediaItem[]) {
  const held = read(at) as { alt?: unknown } | undefined;
  write(at, stored(type, items[0] as MediaItem, held?.alt));
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
  get projection() {
    return projection;
  },
  set projection(copy) {
    projection = copy;
  },
  get view() {
    return displayedRoot;
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
    <button
      class="btn btn-ghost btn-translate"
      type="button"
      aria-label={m.translation_field_aria({ field: text }, options)}
      onclick={() => ontranslate?.(path)}>{m.translation_field({}, options)}</button
    >
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
    <div class="actions">
      {#if onretranslate}
        <button class="btn btn-sm" type="button" onclick={() => close(stalePath, onretranslate)}>{m.translation_retranslate({}, options)}</button>
      {/if}
      <button class="btn btn-sm btn-ghost" type="button" onclick={() => close(stalePath, (p) => (dismissed = [...dismissed, p]))}>{m.translation_dismiss({}, options)}</button>
    </div>
  </div>
{/snippet}

{#snippet groupLabel(id: string, field: Field, text: string, at: readonly string[] = [])}
  <div class="label-row">
    <span id="{id}-l"
      >{text}{#if 'required' in field && field.required}<span class="req" aria-hidden="true">*</span
        >{/if}</span
    >{#if field.type === 'array' || field.type === 'blocks'}<span class="section-count"
        >{m.field_item_count({ count: rows(at).length }, options)}</span
      >{/if}{#if prose(field)}{@render machineMark(address(at), text)}{/if}
  </div>
{/snippet}

{#snippet chosenEntry(
  id: string,
  labelId: string,
  says: string | undefined,
  ref: string,
  open: () => void,
)}
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
    <label for={id}
      >{text}{#if 'required' in field && field.required}<span class="req" aria-hidden="true">*</span
        >{/if}</label
    >
    {#if prose(field)}{@render machineMark(address(at), text)}{/if}
  </div>
{/snippet}

{#snippet nested(
  inner: readonly Field[],
  at: readonly string[],
  mode: Translation,
  view: Data,
  rowLabel?: string,
)}<Fields
    fields={inner}
    bind:root
    {blocks}
    {blockLabels}
    {problems}
    path={at}
    {rowLabel}
    {translating}
    {machine}
    {ontranslate}
    {sourceChanged}
    bind:dismissed
    {sourceLabel}
    {translatedAt}
    {onretranslate}
    {prefix}
    {mediaBase}
    {locale}
    {uiLocale}
    {site}
    {servedAt}
    {session}
    {oncommand}
    {onreveal}
    viewRoot={view}
    inherited={mode}
    {structureLocked}
    {textOnly}
    {reference}
  />{/snippet}

{#snippet row(field: Field)}
  {@const at = [...path, ...field.path]}
  {@const id = `${prefix}-${at.join('.')}`}
  {@const mode = modeOf(field)}
  {@const text = field.label || rowLabel}
  {@const err = problemOf(field, at)}
  {@const bad = err ? 'true' : undefined}
  {@const says = err ? `${id}-err` : undefined}
  {@const marked = [address(at), childAddress(at, 'label')].find((p) => p && opened === p)}
  <div
    class={['field', { 'is-invalid': err, 'pop-anchor': marked }]}
    data-field-type={field.type}
    id="{id}-field"
    tabindex="-1"
    inert={textOnly &&
    !structural(field) &&
    ((field.type !== 'text' && field.type !== 'richtext') || mode !== true)
      ? true
      : undefined}
  >
    {#if field.type === 'menus'}
      {@render groupLabel(id, field, text, at)}
      <Menus
        {id}
        labelId="{id}-l"
        menus={rows(at) as Menu[]}
        {locale}
        {uiLocale}
        {translating}
        {sourceLabel}
        variants={field.variants}
      />
    {:else if translating && mode === 'duplicate' && !structural(field)}
      {@render groupLabel(id, field, text, at)}
      <div class="readonly" {id} role="region" tabindex="-1" aria-labelledby="{id}-l">
        {read(at) ?? ''}
      </div>
      <p class="hint">{m.field_same_every_language({}, options)}</p>
    {:else if field.type === 'text'}
      {@render labelRow(id, field, text, at)}
      <TextField
        {id}
        invalid={bad}
        describedBy={says}
        required={field.required}
        value={str(at)}
        onvalue={(value) => write(at, value)}
      />
      {#if reference}<ReferencePeek {reference} path={address(at)} {uiLocale} />{/if}
    {:else if field.type === 'number'}
      {@render labelRow(id, field, text, at)}
      <input
        class="input"
        {id}
        type="number"
        step="any"
        aria-invalid={bad}
        aria-describedby={says}
        aria-required={field.required ? 'true' : undefined}
        value={num(at)}
        oninput={(e) =>
          write(at, e.currentTarget.value === '' ? undefined : e.currentTarget.valueAsNumber)}
      />
    {:else if field.type === 'boolean'}
      <label class="switch" for={id}
        ><input
          type="checkbox"
          role="switch"
          {id}
          aria-invalid={bad}
          aria-describedby={says}
          aria-required={field.required ? 'true' : undefined}
          checked={read(at) === true}
          onchange={(e) =>
            write(
              at,
              e.currentTarget.checked || field.required || heldWhenOpened(at)
                ? e.currentTarget.checked
                : undefined,
            )}
        /><span>{text}</span></label
      >
    {:else if field.type === 'date'}
      {@render labelRow(id, field, text, at)}
      <input
        class="input"
        {id}
        type="date"
        aria-invalid={bad}
        aria-describedby={says}
        aria-required={field.required ? 'true' : undefined}
        value={str(at)}
        oninput={(e) => write(at, e.currentTarget.value || undefined)}
      />
    {:else if field.type === 'select'}
      {#if field.options.length <= 5}
        <fieldset aria-describedby={says}>
          <legend
            >{text}{#if field.required}<span class="req" aria-hidden="true">*</span>{/if}</legend
          >
          {#each field.options as option (option)}
            <label class="choice"
              ><input
                type="radio"
                name={id}
                value={option}
                required={field.required}
                checked={read(at) === option}
                onchange={() => write(at, option)}
              /><span>{labelIn(field.optionLabels?.[option], uiLocale) ?? capitalise(option)}</span
              ></label
            >
          {/each}
        </fieldset>
      {:else}
        {@render labelRow(id, field, text, at)}
        <select
          class="input"
          {id}
          aria-invalid={bad}
          aria-describedby={says}
          aria-required={field.required ? 'true' : undefined}
          value={str(at)}
          onchange={(e) => write(at, e.currentTarget.value || undefined)}
        >
          <option value="">{m.field_choose({}, options)}</option>
          {#each field.options as option (option)}
            <option value={option}
              >{labelIn(field.optionLabels?.[option], uiLocale) ?? capitalise(option)}</option
            >
          {/each}
        </select>
      {/if}
    {:else if field.type === 'link' && translating}
      <!-- A link's label is the half a translation owns. -->
      {@render groupLabel(id, field, text, at)}
      <div class="field"
        ><div class="label-row"
          ><label for="{id}.label">{m.field_link_label({}, options)}</label>{@render machineMark(
            childAddress(at, 'label'),
            `${text} label`,
          )}</div
        ><input
          class="input"
          id="{id}.label"
          type="text"
          value={str([...at, 'label'])}
          oninput={(e) => write([...at, 'label'], e.currentTarget.value || undefined)}
        />{#if reference}<ReferencePeek
            {reference}
            path={childAddress(at, 'label')}
            {uiLocale}
          />{/if}</div
      >
    {:else if field.type === 'link'}
      {@render groupLabel(id, field, text, at)}
      <LinkField {level} {id} {at} {text} {says} chosen={chosenEntry} empty={noEntry} />
    {:else if field.type === 'richtext'}
      {@render groupLabel(id, field, text, at)}
      <RichText
        {id}
        labelId="{id}-l"
        {locale}
        {uiLocale}
        tier={field.tier}
        invalid={!!err}
        describedby={says}
        value={str(at)}
        address={address(at)}
        {session}
        onchange={(md, history) => write(at, md, history)}
      />
      {#if reference}<ReferencePeek
          {reference}
          path={address(at)}
          tier={field.tier}
          {uiLocale}
        />{/if}
    {:else if field.type === 'group'}
      <details class="group" open>
        <summary
          >{text}<span class="count">{m.field_count({ count: field.fields.length }, options)}</span
          ></summary
        >
        <div class="form">{@render nested(field.fields, at, mode, displayedRoot)}</div>
      </details>
    {:else if field.type === 'array' || field.type === 'blocks'}
      {@render groupLabel(id, field, text, at)}
      <ListField
        {level}
        {id}
        {at}
        {field}
        {text}
        {mode}
        form={nested}
        bind:root
        {session}
        {locale}
        {oncommand}
        {onreveal}
        {blocks}
        {blockLabels}
        {problems}
      />
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
</style>
