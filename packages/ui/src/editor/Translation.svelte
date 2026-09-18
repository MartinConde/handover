<script lang="ts">
import {
  type Field,
  type Form,
  keptMachine,
  type ResolvedSeo,
  type WordPart,
} from '@handover/core';
import { messageText, responseMessage, type UiMessage } from '../errors.js';
import { formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, uncertainResponse } from '../request.js';
import type { EntrySession } from './entry-session.svelte';
import Fields from './fields/Fields.svelte';

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
  mediaBase = '',
  inheritedSeo,
  translator = false,
  actionBlocked = false,
  url,
  site,
  uiLocale = 'en',
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
  translator?: boolean;
  /** Another entry-wide persisted action is already in flight. */
  actionBlocked?: boolean;
  url?: string;
  site?: string;
  uiLocale?: UiLocale;
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

// Only read for a stale file, so an entry nobody has translated pays nothing for the marker.
let behind = $state<{
  from?: string;
  otherSource?: boolean;
  translatedAt?: string;
  changed: Record<string, WordPart[]>;
}>({
  changed: {},
});
$effect(() => {
  if (!stale) return;
  let live = true;
  fetch(`/admin/api/source/${collection}/${slug}/${locale}`)
    .then((res) => (res.ok ? res.json() : { changed: {} }))
    .then((body) => {
      if (live) behind = body as typeof behind;
    })
    .catch(() => {});
  return () => {
    live = false;
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
const failureText = $derived(fillFailure ? messageText(fillFailure, uiLocale) : '');
const failureDetail = $derived(
  fillFailure?.detail ? m.common_technical_detail({ detail: fillFailure.detail }, options) : '',
);
</script>

<section class="pane is-locale" aria-labelledby="pane-{locale}">
  <div class="pane-head">
    <h2 id="pane-{locale}">{named(locale)}</h2>
    {#if stale}
      <span class="mode">{behind.otherSource && behind.from ? m.translation_other_source({ language: named(behind.from), source: named(source) }, options) : m.translation_source_changed({ source: named(source) }, options)}</span>
    {/if}
    <span class={['autosave', { 'is-saving': saving, 'is-offline': failed }]}>
      {#if saving}{m.editor_save_saving({}, options)}{:else if failed}{m.editor_save_not_saved({}, options)} {#if fillFailure?.code === 'TRANSLATION_UNCONFIRMED'}<button type="button" class="btn-link" onclick={() => location.reload()}>{m.editor_lock_reload({}, options)}</button>{:else}<button type="button" class="btn-link" onclick={() => fillFailure ? fill(retryPaths) : flush()}>{fillFailure ? m.translation_retry({}, options) : m.editor_save_retry({}, options)}</button>{/if}{:else if isUnsaved}{m.editor_save_unsaved_changes({}, options)}{:else}{m.editor_save_saved({}, options)}{/if}
    </span>
    <span class="spacer"></span>
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
        sourceLabel={named(source)}
        translatedAt={behind.translatedAt ?? ''}
        prefix="t"
        {site}
        servedAt={url}
      />
    </fieldset>
  </form>
</section>
