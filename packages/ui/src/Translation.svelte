<script lang="ts">
import { type Field, keptMachine } from '@handover/core';
import Fields from './Fields.svelte';

type Data = Record<string, unknown>;
let {
  collection,
  slug,
  locale,
  fields,
  blocks,
  data: loaded,
  source,
  stale = false,
  translator = false,
  onsaved,
  onclose,
}: {
  collection: string;
  slug: string;
  /** The language this column is of — never the one the entry's structure is edited in. */
  locale: string;
  fields: readonly Field[];
  blocks: Record<string, Field[]>;
  /** This language's file as the editor last saw it. */
  data: Data;
  /** The language it was translated from, for the header. */
  source: string;
  /** Its source language has moved on since somebody translated this. A warning, no more. */
  stale?: boolean;
  /** The site has something to machine-translate with; without one, none of it is drawn. */
  translator?: boolean;
  /** A save landed: whether this language's file is now ahead of the repository. The entry
      keeps it, because this column is thrown away when the screen changes and its edit is not. */
  onsaved?: (pending: boolean) => void;
  /** Close the second column; nothing when it is the only one on screen. */
  onclose?: () => void;
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
    body: JSON.stringify({ data }),
  });
  saving = false;
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
      <button class="btn btn-sm btn-fill" type="button" disabled={filling} onclick={() => fill()}>
        Translate what's empty
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
    <Fields
      {fields}
      {blocks}
      {problems}
      {machine}
      bind:root={data}
      translating
      ontranslate={translator ? (path) => fill([path]) : undefined}
      prefix="t"
    />
  </form>
</section>
