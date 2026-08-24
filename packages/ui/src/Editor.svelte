<script lang="ts">
import { type Drift, entryUrl, type Field } from '@handover/core';
import DriftPanel from './Drift.svelte';
import Fields from './Fields.svelte';
import Translation from './Translation.svelte';

type Data = Record<string, unknown>;
type Problem = { path: string; message: string };
const byPath = (problems: Problem[]) =>
  Object.fromEntries(problems.map((p) => [p.path, p.message]));
let {
  collection,
  slug,
  entry,
  onpublish,
  onchanged,
}: {
  collection: string;
  slug: string;
  entry: {
    fields: readonly Field[];
    blocks: Record<string, Field[]>;
    data: Data;
    /** The languages whose file this entry has a draft ahead of in git. */
    pending: string[];
    /** What the collection schema will not accept yet, by field path. */
    problems: { path: string; message: string }[];
    /** The field this collection is keyed on, when it is not `title`. */
    titleField?: string;
    /** The languages the site declares. */
    locales: string[];
    /** The one the entry's structure is edited in, and the one a translation is made from. */
    defaultLocale: string;
    /** The languages it is offered in; the rest are turned off and get no file. */
    offered: string[];
    /** What its own `_locales` says that the files it has contradict — a hand edit or a merge. */
    offerProblems?: string[];
    /** The other languages this entry has a file in, parsed; none where it has no other file. */
    translations: Record<string, Data>;
    /** Which of them were translated from a source language that has moved on since. */
    stale: string[];
    /** The blocks this entry's languages disagree about; publishing waits on these. */
    drift: Drift[];
    /** The site has something to machine-translate with: without one, none of it is offered. */
    translator?: boolean;
    /** This collection serves an address per language; without it the row is not drawn at all. */
    localizedSlugs?: boolean;
    /** The address each language serves this entry at, empty meaning under the file name. */
    addresses?: Record<string, string>;
    /** The collection's own route, which is what an address is a segment of. */
    route?: string;
    /** Whether the default language's URLs carry its segment. */
    prefixDefaultLocale?: boolean;
  };
  /** Open the pending-changes drawer, which is where publishing happens. */
  onpublish: () => void;
  /** A file of this entry was made, removed or settled: it has to be read again, screen with it. */
  onchanged: () => void;
} = $props();

// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let data = $state<Data>(structuredClone(entry.data));
// The last shape the draft row holds; the loaded data is already in it, hence no write on open.
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let saved = $state(JSON.stringify(entry.data));
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let drafted = $state(entry.pending.includes(entry.defaultLocale));
let saving = $state(false);
let saveFailed = $state(false);
// A draft stores whatever was typed, so what the schema still wants is the server's answer to
// every save rather than a reason to refuse one; the publish is where it blocks.
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let problems = $state(byPath(entry.problems));
// Which language the switcher has, and whether the second column is open. Two independent
// things: the second column is always the default language beside a translation.
// svelte-ignore state_referenced_locally -- the entry's default language is where it opens
let locale = $state(entry.defaultLocale);
let side = $state(false);
let pane = $state<ReturnType<typeof Translation>>();
// A second language stored ahead of the repository. It lives here rather than in the column,
// which is thrown away whenever the screen changes and would take the fact with it.
let translated = $state(false);

// Every control below is about having more than one language, so a site that declares one
// draws none of them — not greyed, not always-1-of-1, absent.
const many = $derived(entry.locales.length > 1);
const others = $derived(entry.locales.filter((l) => l !== entry.defaultLocale));
// The column beside the default language: the one the switcher has, or the first other
// language when the switcher is on the default one.
const target = $derived(locale === entry.defaultLocale ? others[0] : locale);
const shown = $derived(side ? target : locale === entry.defaultLocale ? undefined : locale);
// A translation on its own: the switcher is on another language and the second column is shut.
const alone = $derived(!side && shown !== undefined);
// The entry always has the file it was opened on; the others are the ones that can be absent.
const untranslated = (of: string) => of !== entry.defaultLocale && !(of in entry.translations);
// Turned off for this entry: no file is written for it and the site does not offer it.
const off = (of: string) => !entry.offered.includes(of);
let busy = $state(false);

// The two answers to a language with no file. Both change which files the entry has, so the
// screen is read again rather than patched here.
async function ask(url: string, init: RequestInit = {}) {
  busy = true;
  const res = await fetch(url, { method: 'POST', ...init });
  busy = false;
  if (res.ok) onchanged();
}

const createFrom = (of: string) => ask(`/admin/api/drafts/${collection}/${slug}/${of}`);
// Create from English and then a machine's first draft of it, as one answer to the offer: the
// file has to exist before anything can be written into it.
async function createFilled(of: string) {
  busy = true;
  const made = await fetch(`/admin/api/drafts/${collection}/${slug}/${of}`, { method: 'POST' });
  if (made.ok)
    await fetch(`/admin/api/translate/${collection}/${slug}/${of}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  busy = false;
  if (made.ok) onchanged();
}
const offer = (of: string, on: boolean) =>
  ask(`/admin/api/entries/${collection}/${slug}/locales`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      locales: on
        ? entry.locales.filter((l) => l === of || !off(l))
        : entry.offered.filter((l) => l !== of),
    }),
  });

const json = $derived(JSON.stringify(data));
const missing = $derived(Object.keys(problems));
const named = $derived(data[entry.titleField ?? 'title']);
const title = $derived(typeof named === 'string' && named ? named : slug);
// A language other than the one this screen's form saves, already ahead of the repository when
// the entry was read. It stands until the entry is read again: a false offer costs an empty
// drawer, a false refusal loses the draft behind a disabled button.
const elsewhere = $derived(entry.pending.some((l) => l !== entry.defaultLocale));
// The second column is its own file, so an edit only made there is still something to publish.
const dirty = $derived(
  drafted || elsewhere || translated || json !== saved || (pane?.unsaved() ?? false),
);
const LANGUAGES = new Intl.DisplayNames(['en'], { type: 'language' });
const language = (of: string) => {
  try {
    return LANGUAGES.of(of) ?? of;
  } catch {
    return of;
  }
};

// Autosave. The wait restarts on every keystroke, so a burst of typing is one write.
$effect(() => {
  if (json === saved) return;
  const timer = setTimeout(autosave, 2000);
  return () => clearTimeout(timer);
});

async function autosave() {
  const sent = json;
  saving = true;
  const res = await fetch(`/admin/api/drafts/${collection}/${slug}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  saving = false;
  saveFailed = !res.ok;
  if (res.ok) {
    saved = sent;
    // Whether the stored draft differs from the file in git is the server's answer, not ours.
    const body = (await res.json()) as { pending: boolean; problems: Problem[] };
    drafted = body.pending;
    problems = byPath(body.problems);
  }
}

// Scrolling there is not enough on its own: the count is a button, so it has to land somewhere.
function goToFirst() {
  const field = document.getElementById(`f-${missing[0]}`);
  field?.scrollIntoView({ block: 'center' });
  field?.focus();
}

// Publishing is the drawer's job, over every draft at once; the entry's own edit only has
// to be in D1 before it opens, so a click inside the autosave window is not lost.
async function openDrawer() {
  if (json !== saved) await autosave();
  if (saveFailed) return;
  // The other language is its own file and its own row, and the publish reads the rows.
  if (pane && !(await pane.flush())) return;
  onpublish();
}

// The second column holds one language and goes when the screen changes under it — closed, or
// pointed at another language. Its wait would go with it, so whatever is in it is sent before
// the change; the request outlives the component, and the screen does not wait on it.
function leaving(change: () => void) {
  if (pane?.unsaved()) pane.flush();
  change();
}

// The address the language on screen serves this entry at. Its own control and its own write:
// unlike a field it is validated and has to be unique, and moving a published one owes a
// redirect. The file name never moves with it — renaming is the other action.
let editing = $state(false);
let typed = $state('');
let addressFailed = $state('');
const address = $derived(entry.addresses?.[locale] ?? '');
// A language with no file has no address: the offer to make one stands where the form would be.
const addressable = $derived(
  entry.localizedSlugs === true && (locale === entry.defaultLocale || !untranslated(locale)),
);
const routing = $derived({
  locales: entry.locales,
  defaultLocale: entry.defaultLocale,
  prefixDefaultLocale: entry.prefixDefaultLocale,
});
const url = $derived(entryUrl('default', routing, entry.route, address || slug, locale) ?? '');
// The part in front of the address, so what is being typed reads as the URL it will be.
const before = $derived(entryUrl('default', routing, entry.route, '', locale) ?? '');

function editAddress() {
  typed = address;
  addressFailed = '';
  editing = true;
}

// Everything on screen is stored first: this write goes into the same rows, and the screen is
// read again afterwards so both columns come back with the address the server settled on.
async function saveAddress() {
  busy = true;
  if (json !== saved) await autosave();
  if (pane?.unsaved()) await pane.flush();
  const res = await fetch(`/admin/api/entries/${collection}/${slug}/address/${locale}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: typed.trim() }),
  });
  busy = false;
  if (!res.ok) {
    addressFailed = await res.text();
    return;
  }
  editing = false;
  onchanged();
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
</script>

<main class="main main-editor">
  {#each entry.offerProblems ?? [] as problem (problem)}
    <div class="lock-banner is-offer">
      This entry's file says something its languages contradict — {problem}. Fix it in the
      repository; until then the files are what counts.
    </div>
  {/each}
  {#if entry.drift.length}
    <div class="lock-banner is-drift">
      The languages of this entry disagree about its blocks — publishing is blocked until that is
      settled.
    </div>
  {/if}
  <header class="entry-header">
    <div class="crumbs">
      <span>{capitalise(collection)}</span><span class="sep" aria-hidden="true">/</span><span>{title}</span>
      <span class="autosave" class:is-saving={saving} class:is-offline={saveFailed}>
        {#if saving}Saving…{:else if saveFailed}Not saved{:else if json !== saved}Unsaved changes{:else}Saved{/if}
      </span>
    </div>
    <div class="title-row">
      <h1>{title}</h1>
      <div class="meta">
        <span class="status"><span class="dot" aria-hidden="true"></span> Live</span>
        {#if missing.length}
          <button class="problems" type="button" onclick={goToFirst}>
            {missing.length} problem{missing.length === 1 ? '' : 's'}
          </button>
        {/if}
      </div>
      <div class="actions">
        {#if many}
          {#if entry.locales.length < 5}
            <div class="seg" role="group" aria-label="Language">
              {#each entry.locales as of (of)}
                <button type="button" class:is-off={off(of)} aria-pressed={locale === of} onclick={() => leaving(() => (locale = of))}>
                  {of.toUpperCase()}{#if off(of)}<span class="visually-hidden"> — turned off for this entry</span>{:else if untranslated(of)}<span class="visually-hidden"> — not translated yet</span><span class="mark is-empty" aria-hidden="true"></span>{:else if entry.stale.includes(of)}<span class="visually-hidden"> — {language(entry.defaultLocale)} changed since this was translated</span><span class="mark" aria-hidden="true"></span>{/if}
                </button>
              {/each}
            </div>
          {:else}
            <label class="visually-hidden" for="entry-locale">Language</label>
            <select
              class="input"
              id="entry-locale"
              value={locale}
              onchange={(e) => leaving(() => (locale = e.currentTarget.value))}
            >
              {#each entry.locales as of (of)}
                <option value={of}>{language(of)}</option>
              {/each}
            </select>
          {/if}
          <button class="btn btn-sbs" type="button" aria-pressed={side} onclick={() => leaving(() => (side = !side))}>Side by side</button>
        {/if}
        <button class="btn btn-preview" type="button" disabled title="Preview is not available yet">Preview</button>
        <button
          class="btn btn-primary"
          type="button"
          disabled={!dirty || saving || missing.length > 0 || entry.drift.length > 0}
          title={entry.drift.length
            ? 'The languages of this entry disagree about its blocks'
            : missing.length
              ? 'Fill in what is missing before publishing this entry'
              : undefined}
          onclick={openDrawer}
        >Publish…</button>
        <button class="btn btn-ghost" type="button" disabled aria-label="More actions">⋯</button>
      </div>
    </div>
    {#if addressable}
      <p class="slug-row">
        {#if editing}
          <span class="url">{before}</span>
          <label class="visually-hidden" for="entry-address">Web address in {language(locale)}</label>
          <input class="input" id="entry-address" type="text" bind:value={typed} placeholder={slug} />
          <button class="btn btn-sm" type="button" disabled={busy} onclick={saveAddress}>Save</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick={() => (editing = false)}>Cancel</button>
          {#if addressFailed}<span class="mode is-bad">{addressFailed}</span>{/if}
        {:else}
          <span class="url">{url}</span>
          {#if !address}<span class="mode">Same as the file name</span>{/if}
          <button class="btn-link" type="button" onclick={editAddress}>Edit web address</button>
        {/if}
      </p>
    {/if}
    <div class="tabs" role="tablist" aria-label="Entry sections">
      <button type="button" role="tab" aria-selected="true">Content</button>
      <button type="button" role="tab" aria-selected="false" disabled>SEO</button>
      <button type="button" role="tab" aria-selected="false" disabled>History</button>
    </div>
  </header>
  <!-- A decision to make, not a form to fill: the panel stands where the form would be, because
       every field on it belongs to a structure the languages have not agreed on yet. -->
  <div class="entry-body" class:has-pane={!entry.drift.length && !alone}>
    {#if entry.drift.length}
      <DriftPanel
        {collection}
        {slug}
        drift={entry.drift}
        locales={entry.locales}
        onresolved={onchanged}
      />
    {:else}
      <!-- The default language's form is the one the structure is edited in, so it is not
           drawn when the switcher is on another language and the second column is shut. -->
      {#if !alone}
        <form class="form" onsubmit={(e) => e.preventDefault()}>
          <Fields fields={entry.fields} blocks={entry.blocks} {problems} bind:root={data} />
        </form>
      {/if}
      {#if shown === undefined}
        <aside class="pane" aria-label="Right pane">
          <div><strong>Right pane</strong>Preview or a second language, later.</div>
        </aside>
      {:else if untranslated(shown)}
        <!-- An empty form here would autosave a file nobody asked for, so the language with no
             file is an offer instead: make one from the source language, or say the entry is
             not offered in it at all. -->
        <section class="pane is-locale" aria-labelledby="pane-{shown}">
          <div class="pane-head"><h2 id="pane-{shown}">{language(shown)}</h2></div>
          <div class="empty">
            {#if off(shown)}
              <div class="is-wide">
                <p>
                  This entry is not offered in {language(shown)}. No {language(shown)} file is
                  written and the site does not link to one.
                </p>
                <button class="btn" type="button" disabled={busy} onclick={() => offer(shown, true)}>
                  Turn {language(shown)} back on
                </button>
              </div>
            {:else}
              <div class="is-wide">
                <p>
                  Creating it copies the structure and everything that reads the same in every
                  language. The text fields start empty.
                </p>
                <button class="btn btn-primary btn-create" type="button" disabled={busy} onclick={() => createFrom(shown)}>
                  Create from {language(entry.defaultLocale)}
                </button>
                {#if entry.translator}
                  <button class="btn btn-fill" type="button" disabled={busy} onclick={() => createFilled(shown)}>
                    Create and pre-fill
                  </button>
                {/if}
                <p>
                  Or <button class="btn-link" type="button" disabled={busy} onclick={() => offer(shown, false)}>don't offer this entry in {language(shown)}</button> — no file is written for it.
                </p>
              </div>
            {/if}
          </div>
        </section>
      {:else}
        <!-- Keyed: another language is another file, not the same one under a new name. -->
        {#key shown}
          <Translation
            bind:this={pane}
            {collection}
            {slug}
            locale={shown}
            fields={entry.fields}
            blocks={entry.blocks}
            data={entry.translations[shown] ?? {}}
            source={entry.defaultLocale}
            stale={entry.stale.includes(shown)}
            translator={entry.translator}
            onsaved={(pending) => (translated = pending)}
            onclose={side ? () => leaving(() => (side = false)) : undefined}
          />
        {/key}
      {/if}
    {/if}
  </div>
</main>
