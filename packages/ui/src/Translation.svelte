<script lang="ts">
import { type Field, keptMachine, type ResolvedSeo, type WordPart } from '@handover/core';
import { untrack } from 'svelte';
import Fields from './Fields.svelte';
import { request as fetch } from './request.js';
import { type SaveState, saveCoordinator, saveLane } from './save';

type Data = Record<string, unknown>;
let {
  collection,
  slug,
  locale,
  tab = '',
  revision,
  onrevision,
  lane = saveLane(),
  fields,
  blocks,
  data: loaded,
  source,
  locked = false,
  stale = false,
  mediaBase = '',
  inheritedSeo,
  translator = false,
  url,
  site,
  onsaved,
  onactivity,
  onrefused,
  onclose,
  onturnoff,
}: {
  collection: string;
  slug: string;
  /** Never the language the entry's structure is edited in. */
  locale: string;
  /** The editor's tab token: this column's saves are the tab's saves. */
  tab?: string;
  revision?: string;
  onrevision?: (revision: string) => void;
  lane?: ReturnType<typeof saveLane>;
  fields: readonly Field[];
  blocks: Record<string, Field[]>;
  mediaBase?: string;
  inheritedSeo?: ResolvedSeo;
  data: Data;
  source: string;
  /** The lock is on all of the entry's languages, so this column reads like the other one. */
  locked?: boolean;
  stale?: boolean;
  translator?: boolean;
  url?: string;
  site?: string;
  /** The entry keeps `pending`: this column is thrown away on a screen change, its edit is not. */
  onsaved?: (pending: boolean, data?: Data) => void;
  onactivity?: () => void;
  /** The lock is the entry's, so what the screen does about a refusal belongs to the entry. */
  onrefused?: (lock: unknown) => void;
  onclose?: () => void;
  /** Absent when the language cannot go. */
  onturnoff?: () => void;
} = $props();

// svelte-ignore state_referenced_locally -- the loaded file is the initial value on purpose
let data = $state<Data>($state.snapshot(loaded));
// svelte-ignore state_referenced_locally -- the loaded file is the initial value on purpose
let saveState = $state<SaveState>({ saved: JSON.stringify(loaded), phase: 'idle' });
const saved = $derived(saveState.saved);
// svelte-ignore state_referenced_locally -- the loaded file is the initial value on purpose
let base = $state<Data>(loaded);
const saving = $derived(saveState.phase === 'saving');
let fillFailed = $state(false);
const failed = $derived(saveState.phase === 'failed' || fillFailed);
// The server's answer to the last save; the publish is where these block.
let problems = $state<Record<string, string>>({});

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

const json = $derived(JSON.stringify(data));
const machine = $derived(keptMachine('default', base, data));
let filling = $state(false);

// Flushed first: the fill is written against the stored draft and would overwrite a waiting edit.
async function fill(paths?: string[]) {
  if (!(await flush())) return;
  filling = true;
  const res = await fetch(`/admin/api/translate/${collection}/${slug}/${locale}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(paths ? { paths } : {}),
  });
  filling = false;
  fillFailed = !res.ok;
  if (!res.ok) return;
  const body = (await res.json()) as { data: Data; pending: boolean; revision?: string };
  if (body.revision) {
    revision = body.revision;
    onrevision?.(body.revision);
  }
  base = structuredClone(body.data);
  data = body.data;
  saves.accept(JSON.stringify(body.data));
  onsaved?.(body.pending, body.data);
}

// Subscribes only to the snapshot: a failure-state update must not schedule another retry.
$effect(() => {
  const dirty = json !== saved;
  return untrack(() => {
    if (dirty) onactivity?.();
    return saves.change();
  });
});

// svelte-ignore state_referenced_locally -- this coordinator belongs to the opened file
const saves = saveCoordinator({
  current: () => json,
  saved,
  lane,
  write: writeSave,
  onstate: (state) => {
    saveState = state;
  },
});

async function writeSave(sent: string): Promise<boolean> {
  fillFailed = false;
  const res = await fetch(`/admin/api/drafts/${collection}/${slug}/${locale}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: JSON.parse(sent), tab, revision }),
  });
  if (!res.ok) {
    if (res.status === 409) onrefused?.(await res.json());
    return false;
  }
  const body = (await res.json()) as {
    pending: boolean;
    problems: { path: string; message: string }[];
    revision?: string;
  };
  if (body.revision) {
    revision = body.revision;
    onrevision?.(body.revision);
  }
  onsaved?.(body.pending, JSON.parse(sent));
  problems = Object.fromEntries(body.problems.map((p) => [p.path, p.message]));
  return true;
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
  const target = $state.snapshot(data) as Data;
  const next = reshape(target);
  // A `_version` added on open would be a save on open; stamping it is the save's business.
  if (!('_version' in target)) delete next._version;
  if (canon(next) !== canon(target)) data = next;
}

export function unsaved(): boolean {
  return saves.unsaved();
}

/** The publish reads D1, so a click a second after typing must find this language there. */
export async function flush(): Promise<boolean> {
  return saves.flush();
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
      {#if saving}Saving…{:else if failed}Not saved <button type="button" class="btn-link" onclick={() => flush()}>Retry save</button>{:else if json !== saved}Unsaved changes{:else}Saved{/if}
    </span>
    <span class="spacer"></span>
    {#if translator}
      <button class="btn btn-sm btn-fill" type="button" disabled={filling || locked} onclick={() => fill()}>
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
    <fieldset disabled={locked}>
      <Fields
        {fields}
        {blocks}
        {problems}
        {machine}
        {mediaBase}
        {inheritedSeo}
        {locale}
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
