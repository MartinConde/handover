<script lang="ts">
import { type Field, keptMachine, type ResolvedSeo } from '@handover/core';
import Fields from './Fields.svelte';

type Data = Record<string, unknown>;
let {
  collection,
  slug,
  locale,
  tab = '',
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
  redirect,
  onsaved,
  onrefused,
  onclose,
  onturnoff,
}: {
  collection: string;
  slug: string;
  /** The language this column is of — never the one the entry's structure is edited in. */
  locale: string;
  /** The editor's tab token: the lock is the tab's, and this column's saves are its saves. */
  tab?: string;
  fields: readonly Field[];
  blocks: Record<string, Field[]>;
  /** Where a stored media key is served from; an alt is written beside the picture it describes. */
  mediaBase?: string;
  /** What this language's page would say with nothing typed into the SEO panel. */
  inheritedSeo?: ResolvedSeo;
  /** This language's file as the editor last saw it. */
  data: Data;
  /** The language it was translated from, for the header. */
  source: string;
  /** Somebody else is editing this entry. The lock is on all of its languages, so this
      column reads like the other one. */
  locked?: boolean;
  /** Its source language has moved on since somebody translated this. A warning, no more. */
  stale?: boolean;
  /** The site has something to machine-translate with; without one, none of it is drawn. */
  translator?: boolean;
  /** The URL this language serves the entry at, for the dialog that offers to take it away. */
  url?: string;
  /** Where its readers go once it has: nothing when the collection has nowhere to send them. */
  redirect?: string;
  /** A save landed: whether this language's file is now ahead of the repository. The entry
      keeps it, because this column is thrown away when the screen changes and its edit is not. */
  onsaved?: (pending: boolean) => void;
  /** A save was refused: somebody took the entry over. The lock is the entry's, so what the
      screen does about it belongs to the entry rather than to this column. */
  onrefused?: (lock: unknown) => void;
  /** Close the second column; nothing when it is the only one on screen. */
  onclose?: () => void;
  /** Turn this language off for the entry, which deletes its file; true when it happened. */
  onturnoff?: () => Promise<boolean>;
} = $props();

// svelte-ignore state_referenced_locally -- the loaded file is the initial value on purpose
let data = $state<Data>(structuredClone(loaded));
// svelte-ignore state_referenced_locally -- the loaded file is the initial value on purpose
let saved = $state(JSON.stringify(loaded));
// The file as the server last had it. The badge on a machine-filled field has to come off as
// somebody types over it and not on the next open, and what says so is the same comparison the
// save makes: the words this file had against the words the form has now.
// svelte-ignore state_referenced_locally -- the loaded file is the initial value on purpose
let base = $state<Data>(loaded);
let saving = $state(false);
let failed = $state(false);
// Whether the stored draft of this language differs from its file in git — the server's answer
// to the last save. A file with a draft already waiting when the entry opened is not counted:
// the publish drawer is what lists those.
// What the collection schema will not accept in this file yet, by field path — the server's
// answer to the last save, the same as the entry's own form. The publish is where it blocks.
let problems = $state<Record<string, string>>({});

const json = $derived(JSON.stringify(data));
const machine = $derived(keptMachine('default', base, data));
let filling = $state(false);

/**
 * A machine's first draft. Without `paths` every field this language has nothing in yet is
 * filled — one button for the column; with them, the one field a Translate button is on.
 *
 * Whatever is in the form goes first: the fill is written against the stored draft, so an edit
 * still inside the wait would be overwritten by the answer coming back.
 */
async function fill(paths?: string[]) {
  if (json !== saved) await save();
  if (failed) return;
  filling = true;
  const res = await fetch(`/admin/api/translate/${collection}/${slug}/${locale}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(paths ? { paths } : {}),
  });
  filling = false;
  failed = !res.ok;
  if (!res.ok) return;
  const body = (await res.json()) as { data: Data; pending: boolean };
  base = structuredClone(body.data);
  data = body.data;
  saved = JSON.stringify(body.data);
  onsaved?.(body.pending);
}

// The same wait as the entry's own form, and its own row: the two languages are two files.
$effect(() => {
  if (json === saved) return;
  const timer = setTimeout(save, 2000);
  return () => clearTimeout(timer);
});

async function save() {
  const sent = json;
  saving = true;
  const res = await fetch(`/admin/api/drafts/${collection}/${slug}/${locale}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data, tab }),
  });
  saving = false;
  if (res.status === 409) {
    onrefused?.(await res.json());
    return;
  }
  failed = !res.ok;
  if (!res.ok) return;
  saved = sent;
  const body = (await res.json()) as {
    pending: boolean;
    problems: { path: string; message: string }[];
  };
  onsaved?.(body.pending);
  problems = Object.fromEntries(body.problems.map((p) => [p.path, p.message]));
}

/** Whether this language holds an edit the drafts table has not got yet. */
export function unsaved(): boolean {
  return json !== saved;
}

/**
 * Whatever is still inside the wait, stored. The publish reads the rows, so a click made a
 * second after typing here has to find this language in D1 as well as the other one.
 */
export async function flush(): Promise<boolean> {
  if (json !== saved) await save();
  return !failed;
}

// Turning this language off deletes its file, so it is confirmed the way a delete is. The
// dialog is here rather than in the entry because the control is: the header of the column it
// is about, which is also where focus comes back to.
let asking = $state(false);
let offing = $state(false);
let trigger = $state<HTMLButtonElement>();
let panel = $state<HTMLElement>();
$effect(() => {
  if (asking) panel?.focus();
});
function stopAsking() {
  asking = false;
  trigger?.focus();
}
async function turnOff() {
  offing = true;
  const done = await onturnoff?.();
  offing = false;
  if (!done) stopAsking();
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
      {#if saving}Saving…{:else if failed}Not saved{:else if json !== saved}Unsaved changes{:else}Saved{/if}
    </span>
    <span class="spacer"></span>
    {#if translator}
      <button class="btn btn-sm btn-fill" type="button" disabled={filling || locked} onclick={() => fill()}>
        Translate what's empty
      </button>
    {/if}
    {#if onturnoff}
      <button
        class="btn btn-sm btn-off"
        type="button"
        bind:this={trigger}
        disabled={locked}
        onclick={() => (asking = true)}>Turn {named(locale)} off</button
      >
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
        prefix="t"
      />
    </fieldset>
  </form>
</section>

<!-- The entry list's delete dialog, for what is a delete of one file. Not aria-modal for the
     same reason it is not: the shell behind stays reachable until the design gate gives these
     the drawer's inert treatment. -->
<svelte:window onkeydown={(e) => e.key === 'Escape' && asking && stopAsking()} />

{#if asking}
  <div class="scrim">
    <div class="dialog" role="dialog" aria-labelledby="off-{locale}" bind:this={panel} tabindex="-1">
      <h2 id="off-{locale}">Turn {named(locale)} off for this entry?</h2>
      <p>
        The {named(locale)} file leaves the repository in one commit and the entry is no longer
        offered in {named(locale)}.
        {#if url && redirect}
          Readers of {url} are sent to {redirect}.
        {:else if url}
          Readers of {url} will get a 404 — this collection has nowhere to send them.
        {/if}
        Unpublished changes to {named(locale)} are dropped.
      </p>
      <div class="actions">
        <button class="btn" type="button" onclick={stopAsking}>Cancel</button>
        <button class="btn btn-danger" type="button" disabled={offing} onclick={turnOff}>
          {offing ? 'Turning off…' : 'Turn off'}
        </button>
      </div>
    </div>
  </div>
{/if}
