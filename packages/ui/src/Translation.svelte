<script lang="ts">
import { type Field, keptMachine, type ResolvedSeo, type WordPart } from '@handover/core';
import type { EntrySession } from './entry-session.svelte';
import Fields from './Fields.svelte';
import { request as fetch } from './request.js';

type Data = Record<string, unknown>;
let {
  collection,
  slug,
  locale,
  session,
  fields,
  blocks,
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
  /** The entry keeps `pending`: this column is thrown away on a screen change, its edit is not. */
  onsaved?: (pending: boolean, data?: Data) => void;
  onclose?: () => void;
  /** Absent when the language cannot go. */
  onturnoff?: () => void;
} = $props();

const saveState = $derived(session.saveState(locale));
// svelte-ignore state_referenced_locally -- the loaded file is the initial value on purpose
let base = $state<Data>(structuredClone($state.snapshot(session.snapshot(locale))));
const saving = $derived(saveState.phase === 'saving');
let fillFailed = $state(false);
const failed = $derived(saveState.phase === 'failed' || fillFailed);
$effect(() => {
  if (saveState.phase === 'saving') fillFailed = false;
});

// Only read for a stale file, so an entry nobody has translated pays nothing for the marker.
let behind = $state<{ translatedAt?: string; changed: Record<string, WordPart[]> }>({
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
  fillFailed = false;
  const result = await session.machineTranslate(locale, async () => {
    const res = await fetch(`/admin/api/translate/${collection}/${slug}/${locale}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(paths ? { paths } : {}),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as { data: Data; pending: boolean; revision?: string };
  });
  fillFailed = !result.ok && (result.reason === 'request' || result.reason === 'stale');
  if (!result.ok) return;
  const body = result.response;
  base = structuredClone(body.data);
  data = session.snapshot(locale);
  onsaved?.(body.pending, body.data);
}

// Two objects that differ only in key order are the same words.
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, value) =>
    isPlain(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value,
  );
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `reshape` walks this column's own data, so words typed here and not yet saved are kept. */
export function sync(reshape: (target: Data) => Data): void {
  if (session.localeMutationBlocked(locale)) return;
  const target = $state.snapshot(data) as Data;
  const next = reshape(target);
  // A `_version` added on open would be a save on open; stamping it is the save's business.
  if (!('_version' in target)) delete next._version;
  if (canon(next) !== canon(target)) {
    session.synchronizeSnapshot(locale, next);
    data = session.snapshot(locale);
  }
}

export function unsaved(): boolean {
  return session.unsaved(locale);
}

/** The publish reads D1, so a click a second after typing must find this language there. */
export async function flush(): Promise<boolean> {
  return session.flush();
}

const LANGUAGES = new Intl.DisplayNames(['en'], { type: 'language' });
const named = (of: string) => {
  try {
    return LANGUAGES.of(of) ?? of;
  } catch {
    return of;
  }
};
</script>

<section class="pane is-locale" aria-labelledby="pane-{locale}">
  <div class="pane-head">
    <h2 id="pane-{locale}">{named(locale)}</h2>
    {#if stale}
      <span class="mode">{named(source)} changed since this was translated</span>
    {/if}
    <span class="autosave" class:is-saving={saving} class:is-offline={failed}>
      {#if saving}Saving…{:else if failed}Not saved <button type="button" class="btn-link" onclick={() => flush()}>Retry save</button>{:else if isUnsaved}Unsaved changes{:else}Saved{/if}
    </span>
    <span class="spacer"></span>
    {#if translator}
      <button class="btn btn-sm btn-fill" type="button" disabled={filling || locked || actionBlocked} onclick={() => fill()}>
        Translate what's empty
      </button>
    {/if}
    {#if onturnoff}
      <button class="btn btn-sm btn-off" type="button" disabled={locked} onclick={onturnoff}>
        Turn {named(locale)} off
      </button>
    {/if}
    {#if onclose}
      <button
        class="btn btn-ghost btn-sm"
        type="button"
        aria-label="Close side by side"
        onclick={onclose}>×</button
      >
    {/if}
  </div>
  <form class="form" onsubmit={(e) => e.preventDefault()}>
    <fieldset disabled={mutationBlocked}>
      <Fields
        {fields}
        {blocks}
        {problems}
        {machine}
        {mediaBase}
        {inheritedSeo}
        {locale}
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
