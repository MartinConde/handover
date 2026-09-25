<script lang="ts">
import {
  type Field,
  type Form,
  keptMachine,
  type ResolvedSeo,
  type WordPart,
} from '@handover/core';
import type { Snippet } from 'svelte';
import { messageDetail, messageText, responseMessage, type UiMessage } from '../errors.js';
import { formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, uncertainResponse } from '../request.js';
import type { EntrySession } from './entry-session.svelte';
import Fields from './fields/Fields.svelte';
import type { Reference } from './fields/ReferencePeek.svelte';

type Data = Record<string, unknown>;
let {
  collection,
  slug,
  locale,
  session,
  fields,
  blocks,
  blockLabels,
  data = $bindable(),
  problems = {},
  source,
  locked = false,
  stale = false,
  answered,
  work,
  mediaBase = '',
  inheritedSeo,
  translator = false,
  actionBlocked = false,
  url,
  site,
  uiLocale = 'en',
  heading,
  next,
  reference,
  references = [],
  mark,
  onreference,
  onjump,
  onsaved,
  onclose,
  onturnoff,
}: {
  collection: string;
  slug: string;
  /** Never the language the entry's structure is edited in. */
  locale: string;
  /** Entry-lifetime state: this pane may mount and unmount without losing its draft. */
  session: EntrySession;
  fields: readonly Field[];
  blocks: Record<string, Field[]>;
  blockLabels?: Form['blockLabels'];
  data: Data;
  problems?: Record<string, string>;
  mediaBase?: string;
  inheritedSeo?: ResolvedSeo;
  source: string;
  /** The lock is on all of the entry's languages, so this column reads like the other one. */
  locked?: boolean;
  stale?: boolean;
  /** Source texts this file answers, out of those the source holds. */
  answered?: { written: number; of: number };
  /** The source paths this language is asked for, and those its file leaves empty. */
  work?: { paths: string[]; unanswered: string[] };
  translator?: boolean;
  /** Another entry-wide persisted action is already in flight. */
  actionBlocked?: boolean;
  url?: string;
  site?: string;
  uiLocale?: UiLocale;
  /** Draws the pane's `h2#pane-{locale}` when the editor offers a choice of language there. */
  heading?: Snippet<[string]>;
  /** The queue's way on to the next entry, when the entry was opened from a filtered list. */
  next?: Snippet;
  /** The language drawn read-only under each field, when one is chosen and still valid. */
  reference?: Reference;
  /** Languages that can be the reference; none draws no control. */
  references?: string[];
  /** The state mark a language carries in the editor's switchers. */
  mark?: Snippet<[string]>;
  onreference?: (locale: string | undefined) => void;
  /** Shows the field at this source path in this pane; false when it is no longer drawn. */
  onjump?: (path: string) => Promise<boolean>;
  /** The entry keeps `pending`: this column is thrown away on a screen change, its edit is not. */
  onsaved?: (pending: boolean, data?: Data) => void;
  onclose?: () => void;
  /** Absent when the language cannot go. */
  onturnoff?: () => void;
} = $props();

const saveState = $derived(session.saveState(locale));
const options = $derived(messageOptions(uiLocale));
// svelte-ignore state_referenced_locally -- the loaded file is the initial value on purpose
let base = $state<Data>(structuredClone($state.snapshot(session.snapshot(locale))));
const saving = $derived(saveState.phase === 'saving');
let fillFailure = $state<UiMessage>();
let retryPaths = $state<string[]>();
const failed = $derived(saveState.phase === 'failed' || fillFailure !== undefined);
$effect(() => {
  if (saveState.phase === 'saving') fillFailure = undefined;
});

let behindState = $state<'idle' | 'loading' | 'loaded' | 'failed'>('idle');
let behindRequest = 0;
// Only read for a stale file, so an entry nobody has translated pays nothing for the marker.
let behind = $state<{
  from?: string;
  otherSource?: boolean;
  translatedAt?: string;
  changed: Record<string, WordPart[]>;
}>({
  changed: {},
});
async function loadBehind() {
  const mine = ++behindRequest;
  behindState = 'loading';
  try {
    const res = await fetch(`/admin/api/source/${collection}/${slug}/${locale}`);
    if (!res.ok) throw new Error(`Marker request failed (${res.status})`);
    const body = (await res.json()) as typeof behind;
    if (mine !== behindRequest) return;
    behind = body;
    behindState = 'loaded';
  } catch {
    if (mine === behindRequest) behindState = 'failed';
  }
}
$effect(() => {
  if (!stale) {
    behindState = 'loaded';
    return;
  }
  void loadBehind();
  return () => {
    behindRequest += 1;
  };
});

const isUnsaved = $derived(session.unsaved(locale));
const machine = $derived(keptMachine('default', base, data));
const filling = $derived(session.machineTranslationPending(locale));
const mutationBlocked = $derived(locked || actionBlocked || session.localeMutationBlocked(locale));

// The session reserves the entry before flushing, then owns the request and acknowledgement.
async function fill(paths?: string[]) {
  fillFailure = undefined;
  retryPaths = paths;
  let refusal: UiMessage | undefined;
  const result = await session.machineTranslate(locale, async () => {
    const res = await fetch(`/admin/api/translate/${collection}/${slug}/${locale}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(paths ? { paths } : {}),
    });
    if (!res.ok) {
      refusal = uncertainResponse(res)
        ? { code: 'TRANSLATION_UNCONFIRMED', status: res.status }
        : await translationFailure(res);
      return undefined;
    }
    return (await res.json()) as { data: Data; pending: boolean; revision?: string };
  });
  if (!result.ok && (result.reason === 'request' || result.reason === 'stale'))
    fillFailure = refusal ?? {
      code: result.reason === 'stale' ? 'TRANSLATION_STALE' : 'TRANSLATION_FAILED',
    };
  if (!result.ok) return;
  const body = result.response;
  base = structuredClone(body.data);
  data = session.snapshot(locale);
  onsaved?.(body.pending, body.data);
}

async function translationFailure(response: Response): Promise<UiMessage> {
  const message = await responseMessage(response, 'TRANSLATION_FAILED');
  if (message.detail || !response.headers.get('content-type')?.startsWith('text/plain'))
    return message;
  const detail = (await response.clone().text()).trim();
  return detail ? { ...message, detail } : message;
}

/** The publish reads D1, so a click a second after typing must find this language there. */
async function flush(): Promise<boolean> {
  return session.flush();
}

const named = (of: string) => formatLanguageName(of, uiLocale);

let referenceOpen = $state(false);
let referenceTrigger = $state<HTMLButtonElement>();
function closeReference() {
  referenceOpen = false;
  referenceTrigger?.focus();
}
function chooseReference(of: string | undefined) {
  onreference?.(of);
  closeReference();
}
// The markers the reader still sees, which is what the to-do list counts as stale work.
let dismissed = $state<string[]>([]);
const marked = $derived(Object.keys(behind.changed).filter((at) => !dismissed.includes(at)));
const todo = $derived.by(() => {
  const outstanding = new Set([...(work?.unanswered ?? []), ...marked]);
  const inOrder = (work?.paths ?? []).filter((path) => outstanding.has(path));
  const seen = new Set(inOrder);
  return [...inOrder, ...marked.filter((path) => !seen.has(path))];
});
// Until the server has said what changed, an empty list is ignorance, not a finished language.
const settled = $derived(!stale || behindState === 'loaded');
let cursor = $state<string>();
// The run as it stood at the last jump: answering a field must not send the next press to the top.
let trail = $state<string[]>([]);
let said = $state('');

function startFrom(list: string[]) {
  const here = list.indexOf(cursor ?? '');
  if (here >= 0) return here;
  const was = trail.indexOf(cursor ?? '');
  for (const path of was >= 0 ? trail.slice(was + 1) : []) {
    const at = list.indexOf(path);
    if (at >= 0) return at - 1;
  }
  return -1;
}

/** Visit the next outstanding field; what is no longer drawn is passed over, not announced. */
async function nextTodo() {
  const list = todo;
  if (!list.length) {
    said = settled ? m.translation_todo_none({}, options) : '';
    return;
  }
  const start = startFrom(list);
  for (let step = 1; step <= list.length; step++) {
    const at = (start + step) % list.length;
    const path = list[at];
    if (path && (await onjump?.(path))) {
      cursor = path;
      trail = list;
      said =
        start >= 0 && start + step >= list.length ? m.translation_todo_wrapped({}, options) : '';
      return;
    }
  }
  said = '';
}

// No shortcut framework: one chord, in the pane it belongs to, yielding to whatever owns the key.
function paneKey(event: KeyboardEvent) {
  if (event.key !== 'ArrowDown' || !event.altKey) return;
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  if ((event.target as HTMLElement | null)?.closest('select, .picker, .popover, .menu')) return;
  event.preventDefault();
  void nextTodo();
}

const failureText = $derived(fillFailure ? messageText(fillFailure, uiLocale) : '');
const failureDetail = $derived(fillFailure ? messageDetail(fillFailure, uiLocale) : '');
</script>

<svelte:window
  onclick={(e) => referenceOpen && !(e.target as HTMLElement).closest('.reference-pick') && (referenceOpen = false)}
  onkeydown={(e) => e.key === 'Escape' && referenceOpen && (e.target as HTMLElement).closest('.reference-pick') && closeReference()}
/>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- the chord belongs to the pane, not to one field -->
<section class="pane is-locale" aria-labelledby="pane-{locale}" onkeydown={paneKey}>
  <div class="pane-head">
    {#if heading}{@render heading(locale)}{:else}<h2 id="pane-{locale}">{named(locale)}</h2>{/if}
    {#if answered}
      <span class="mode answered">{answered.of ? m.editor_language_answered({ written: answered.written, count: answered.of }, options) : m.editor_language_no_source_text({}, options)}</span>
    {/if}
    {#if stale}
      <span class="mode">{behind.otherSource && behind.from ? m.translation_other_source({ language: named(behind.from), source: named(source) }, options) : m.translation_source_changed({ source: named(source) }, options)}</span>
    {/if}
    <span class={['autosave', { 'is-saving': saving, 'is-offline': failed }]}>
      {#if saving}{m.editor_save_saving({}, options)}{:else if failed}{m.editor_save_not_saved({}, options)} {#if fillFailure?.code === 'TRANSLATION_UNCONFIRMED'}<button type="button" class="btn-link" onclick={() => location.reload()}>{m.editor_lock_reload({}, options)}</button>{:else}<button type="button" class="btn-link" onclick={() => fillFailure ? fill(retryPaths) : flush()}>{fillFailure ? m.translation_retry({}, options) : m.editor_save_retry({}, options)}</button>{/if}{:else if isUnsaved}{m.editor_save_unsaved_changes({}, options)}{:else}{m.editor_save_saved({}, options)}{/if}
    </span>
    <span class="spacer"></span>
    <span class="visually-hidden" role="status">{said}</span>
    {#if work}
      <button class="btn btn-sm btn-todo" type="button" onclick={() => void nextTodo()}>{m.translation_todo_next({}, options)}</button>
    {/if}
    {@render next?.()}
    {#if references.length}
      <div class="pop-anchor reference-pick">
        <button class="btn btn-sm" type="button" aria-expanded={referenceOpen} aria-controls="reference-languages" bind:this={referenceTrigger} onclick={() => (referenceOpen = !referenceOpen)}>
          {m.translation_reference_pick({ language: reference?.label ?? m.translation_reference_none({}, options) }, options)}
        </button>
        {#if referenceOpen}
          <div class="menu reference-menu" id="reference-languages">
            <button type="button" aria-pressed={!reference} onclick={() => chooseReference(undefined)}>{m.translation_reference_none({}, options)}</button>
            {#each references as of (of)}
              <button type="button" aria-pressed={reference?.locale === of} onclick={() => chooseReference(of)}>{named(of)}{@render mark?.(of)}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    {#if translator}
      <button class="btn btn-sm btn-fill" type="button" disabled={filling || locked || actionBlocked} onclick={() => fill()}>
        {m.translation_fill_empty({}, options)}
      </button>
    {/if}
    {#if onturnoff}
      <button class="btn btn-sm btn-off" type="button" disabled={locked} onclick={onturnoff}>
        {m.translation_turn_off({ language: named(locale) }, options)}
      </button>
    {/if}
    {#if onclose}
      <button
        class="btn btn-ghost btn-sm"
        type="button"
        aria-label={m.translation_close_side_by_side({}, options)}
        onclick={onclose}>×</button
      >
    {/if}
  </div>
  {#if fillFailure}
    <div class="notice notice-danger" role="alert">{failureText} {failureDetail}</div>
  {/if}
  {#if stale && behindState === 'failed'}
    <div class="notice notice-danger marker-load-failure" role="alert">
      {m.translation_markers_load_failed({}, options)}
      <button class="btn-link" type="button" onclick={loadBehind}>{m.common_retry({}, options)}</button>
    </div>
  {/if}
  <form class="form" onsubmit={(e) => e.preventDefault()}>
    <fieldset disabled={mutationBlocked}>
      <Fields
        {fields}
        {blocks}
        {blockLabels}
        {problems}
        {machine}
        {mediaBase}
        {inheritedSeo}
        {locale}
        {uiLocale}
        {session}
        bind:root={data}
        translating
        ontranslate={translator ? (path) => fill([path]) : undefined}
        onretranslate={translator ? (path) => fill([path]) : undefined}
        sourceChanged={behind.changed}
        bind:dismissed
        sourceLabel={named(source)}
        translatedAt={behind.translatedAt ?? ''}
        prefix="t"
        {reference}
        {site}
        servedAt={url}
      />
    </fieldset>
  </form>
</section>
