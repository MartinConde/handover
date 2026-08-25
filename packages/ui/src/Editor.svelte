<script lang="ts">
import { type Drift, entryUrl, type Field, LOCK_TTL } from '@handover/core';
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
    /** Somebody marked it "Not ready yet" — the toggle opens pressed, whoever they were. */
    held?: boolean;
    /** What the collection schema will not accept yet, by field path. */
    problems: { path: string; message: string }[];
    /** The field this collection is keyed on, when it is not `title`. */
    titleField?: string;
    /** The languages the site declares. */
    locales: string[];
    /** The site's default, which is what says whether a language's URLs carry its segment. */
    defaultLocale: string;
    /** The one this entry's structure is edited in, and the one a translation is made from:
        the site default only where the entry has a file in it. */
    sourceLocale: string;
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
    /** The page above it, where a language that loses its file sends its readers. */
    index?: string;
    /** Whether the default language's URLs carry its segment. */
    prefixDefaultLocale?: boolean;
  };
  /** A file of this entry was made, removed or settled: it has to be read again, screen with it. */
  onchanged: () => void;
} = $props();

// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let data = $state<Data>(structuredClone(entry.data));
// The last shape the draft row holds; the loaded data is already in it, hence no write on open.
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let saved = $state(JSON.stringify(entry.data));
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let drafted = $state(entry.pending.includes(entry.sourceLocale));
let saving = $state(false);
let saveFailed = $state(false);
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let held = $state(entry.held === true);
// A draft stores whatever was typed, so what the schema still wants is the server's answer to
// every save rather than a reason to refuse one; the publish is where it blocks.
// svelte-ignore state_referenced_locally -- the loaded entry is the initial value on purpose
let problems = $state(byPath(entry.problems));
// Which language the switcher has, and whether the second column is open. Two independent
// things: the second column is always the default language beside a translation.
// svelte-ignore state_referenced_locally -- the language the entry is written in is where it opens
let locale = $state(entry.sourceLocale);
let side = $state(false);
let pane = $state<ReturnType<typeof Translation>>();
// A second language stored ahead of the repository. It lives here rather than in the column,
// which is thrown away whenever the screen changes and would take the fact with it.
let translated = $state(false);

// Every control below is about having more than one language, so a site that declares one
// draws none of them — not greyed, not always-1-of-1, absent.
const many = $derived(entry.locales.length > 1);
const others = $derived(entry.locales.filter((l) => l !== entry.sourceLocale));
// The column beside the language the entry is written in: the one the switcher has, or the
// first other language when the switcher is on that one.
const target = $derived(locale === entry.sourceLocale ? others[0] : locale);
const shown = $derived(side ? target : locale === entry.sourceLocale ? undefined : locale);
// A translation on its own: the switcher is on another language and the second column is shut.
const alone = $derived(!side && shown !== undefined);
// The entry always has the file it was opened on; the others are the ones that can be absent.
const untranslated = (of: string) => of !== entry.sourceLocale && !(of in entry.translations);
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
  return res.ok;
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
const elsewhere = $derived(entry.pending.some((l) => l !== entry.sourceLocale));
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

/**
 * The soft lock on this entry — every language of it at once, since they share a structure.
 * `undefined` until the first answer comes back; the tab that has it edits, the tab that has
 * not reads.
 */
type Lock = {
  held_by: { id: string; name: string | null } | null;
  mine: boolean;
  expires_at: number | null;
};
let lock = $state<Lock>();
// A save came back refused: somebody took the entry over while this tab had it. Its own state
// rather than the lock's, because the two banners say different things about the same fact.
let lost = $state(false);
let taking = $state(false);
let takePanel = $state<HTMLElement>();
let takeTrigger = $state<HTMLButtonElement>();
$effect(() => {
  if (taking) takePanel?.focus();
});
// Cancel gives focus back to the button that opened it; taking over reads the entry again and
// there is no banner left to go back to.
function cancelTake() {
  taking = false;
  takeTrigger?.focus();
}
// When the last answer came back, and when this tab last extended a lock of its own.
let asked = $state(0);
let beatAt = 0;
const locked = $derived(lock !== undefined && !lock.mine);
const holder = $derived(lock?.held_by?.name || 'Somebody else');
// How long ago the holder last typed: the lock is taken by a beat and beats ride on the
// autosave, so the expiry it carries is that keystroke plus one lifetime.
const idle = $derived(lock?.expires_at ? asked - (lock.expires_at - LOCK_TTL) : 0);

$effect(() => {
  void beat(true);
});

// While somebody else has it, the banner has to age and the lock has to be seen running out.
// The poll only reads: an entry changes hands when somebody presses Take over, not because a
// tab was watching when the last beat lapsed.
$effect(() => {
  if (!locked) return;
  const timer = setInterval(() => beat(false), 30000);
  return () => clearInterval(timer);
});

async function beat(claim: boolean) {
  const res = await fetch(`/admin/api/locks/${collection}/${slug}`, {
    method: claim ? 'POST' : 'GET',
  }).catch(() => undefined);
  if (!res?.ok) return;
  lock = (await res.json()) as Lock;
  asked = Date.now();
  if (lock.mine) beatAt = asked;
}

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
  // Somebody pressed Take over. The words are not lost — they are in the shared draft the new
  // holder is carrying on from — but this tab is reading from here on.
  if (res.status === 409) {
    lost = true;
    lock = (await res.json()) as Lock;
    return;
  }
  saveFailed = !res.ok;
  if (res.ok) {
    // Typing is what holds the entry, and this is where the CMS hears it. Once every three
    // quarters of a lifetime, so a fast typist is not a write per pause. A refused save is not
    // a beat: the lock it would push out is not ours any more.
    if (Date.now() - beatAt >= 45000) void beat(true);
    saved = sent;
    // Whether the stored draft differs from the file in git is the server's answer, not ours.
    const body = (await res.json()) as { pending: boolean; problems: Problem[] };
    drafted = body.pending;
    problems = byPath(body.problems);
  }
}

// The one thing that takes somebody else's work away, so it confirms first. The entry is read
// again afterwards: there is one shared draft, and carrying on from it means loading what they
// left rather than saving this tab's form over it.
async function takeOver() {
  busy = true;
  const res = await fetch(`/admin/api/locks/${collection}/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ take: true }),
  });
  busy = false;
  taking = false;
  if (!res.ok) return;
  lock = (await res.json()) as Lock;
  onchanged();
}

// "Not ready yet". The flag lives on the draft rows, so whatever is in the form is stored
// first — otherwise the entry is held back and the words that made somebody hold it are not.
async function toggleHold() {
  const next = !held;
  busy = true;
  if (json !== saved) await autosave();
  if (saveFailed || lost) {
    busy = false;
    return;
  }
  if (pane?.unsaved()) await pane.flush();
  const res = await fetch(`/admin/api/hold/${collection}/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hold: next }),
  });
  busy = false;
  if (res.ok) held = ((await res.json()) as { held: unknown }).held === true;
}

// Scrolling there is not enough on its own: the count is a button, so it has to land somewhere.
function goToFirst() {
  const field = document.getElementById(`f-${missing[0]}`);
  field?.scrollIntoView({ block: 'center' });
  field?.focus();
}

// Publishing is the drawer's job, over every draft at once; the entry's own edit only has
// to be in D1 before it opens, so a click inside the autosave window is not lost.
// The header's half of publishing: this entry, whole, and nothing else anybody has been
// working on. It commits, so it confirms first.
let confirming = $state(false);
let sending = $state(false);
let publishFailed = $state('');
// Somebody committed to one of this entry's files after it was opened. Detection only: taking
// theirs whole is the drawer's Discard, and choosing field by field is the three-way view.
let conflicted = $state(false);
let publishButton = $state<HTMLButtonElement>();
let publishPanel = $state<HTMLElement>();
$effect(() => {
  if (confirming) publishPanel?.focus();
});

// The languages this publish would write. `drafted` is the live answer for the one the form
// saves; the rest are as the entry was read, plus whatever the second column has since sent.
const going = $derived(
  entry.locales.filter(
    (of) =>
      (of === entry.sourceLocale ? drafted : entry.pending.includes(of)) ||
      (of === target && translated),
  ),
);

async function askToPublish() {
  if (json !== saved) await autosave();
  if (saveFailed) return;
  // The other language is its own file and its own row, and the publish reads the rows.
  if (pane && !(await pane.flush())) return;
  publishFailed = '';
  confirming = true;
}

function closePublish() {
  confirming = false;
  publishButton?.focus();
}

async function publishEntry() {
  sending = true;
  publishFailed = '';
  const res = await fetch('/admin/api/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: [`${collection}/${slug}`] }),
  });
  sending = false;
  if (res.ok) {
    confirming = false;
    // The rows are re-seeded on the commit and a hold comes off with them, so the screen is
    // read again rather than patched here.
    onchanged();
    return;
  }
  // A repository the App cannot reach is the server's own sentence; nothing else adds to it.
  if (res.status === 503) {
    publishFailed = await res.text();
    return;
  }
  if (res.status === 422) {
    publishFailed =
      'Nothing was published. Something this entry needs is still missing — open each of its languages to see what.';
    return;
  }
  if (res.status === 409) {
    const body = await res.text();
    const parsed = JSON.parse(body.startsWith('{') ? body : '{}') as { reason?: string };
    // Drift is the panel this screen already draws; a file somebody else changed is not, and
    // the way out of that one is in the drawer.
    if (parsed.reason !== 'drift') {
      closePublish();
      conflicted = true;
      return;
    }
    publishFailed =
      "Nothing was published. This entry's languages disagree about which blocks it has — the panel on this screen is where that is settled.";
    return;
  }
  publishFailed = `Nothing was published (${res.status}).`;
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
  entry.localizedSlugs === true && (locale === entry.sourceLocale || !untranslated(locale)),
);
const routing = $derived({
  locales: entry.locales,
  defaultLocale: entry.defaultLocale,
  prefixDefaultLocale: entry.prefixDefaultLocale,
});
const url = $derived(entryUrl('default', routing, entry.route, address || slug, locale) ?? '');
// The part in front of the address, so what is being typed reads as the URL it will be.
const before = $derived(entryUrl('default', routing, entry.route, '', locale) ?? '');

// Turning a language off commits, and the screen is read again afterwards: whatever is in the
// other form goes into its row first, the way an address change stores everything before it
// writes. The column's own draft is not flushed — it goes with the file.
async function turnOff(): Promise<boolean> {
  if (json !== saved) await autosave();
  return shown !== undefined && (await offer(shown, false));
}

// What the second column's Turn-off dialog names: the URL that language serves this entry at,
// and where its readers go afterwards — nothing when the collection has no page above it.
const localeUrl = (of: string) =>
  entryUrl('default', routing, entry.route, entry.addresses?.[of] || slug, of) ?? undefined;
const localeIndex = (of: string) => entryUrl('default', routing, entry.index, '', of) ?? undefined;

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

<svelte:window
  onkeydown={(e) => {
    if (e.key !== 'Escape') return;
    if (confirming) closePublish();
    else if (taking) cancelTake();
  }}
/>

<main class="main main-editor">
  {#each entry.offerProblems ?? [] as problem (problem)}
    <div class="lock-banner is-offer">
      This entry's file says something its languages contradict — {problem}. Fix it in the
      repository; until then the files are what counts.
    </div>
  {/each}
  {#if lost}
    <!-- Leads with where the work went, because the fear is that it is gone: the draft rows are
         in D1 and the new holder carries on from them, so "lost" is never true of the words. -->
    <div class="lock-banner is-lost">
      {holder} took over this entry. Everything you wrote is in the shared draft — {holder} is carrying
      on from it.
      <button class="btn-link" type="button" onclick={onchanged}>Reload</button>
    </div>
  {:else if locked}
    <div class="lock-banner">
      {#if lock?.held_by}
        Being edited by {lock.held_by.name || 'somebody else'}
        <span class="when">
          {idle >= 60000
            ? '— nothing typed for a minute; the lock frees itself after two'
            : '— active a few seconds ago'}
        </span>
        <button class="btn-link" type="button" bind:this={takeTrigger} onclick={() => (taking = true)}>Take over</button>
      {:else}
        Nobody is editing this entry any more.
        <button class="btn-link" type="button" onclick={onchanged}>Reload</button>
      {/if}
    </div>
  {/if}
  {#if entry.drift.length}
    <div class="lock-banner is-drift">
      The languages of this entry disagree about its blocks — publishing is blocked until that is
      settled.
    </div>
  {/if}
  <header class="entry-header" class:is-held={held}>
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
        {#if conflicted}
          <span class="badge badge-danger">Changed in the repository since you opened it</span>
        {/if}
        <button
          class="hold-toggle"
          type="button"
          aria-pressed={held}
          disabled={locked || lost || busy || (!dirty && !held)}
          title={dirty || held ? undefined : 'There is nothing unpublished to hold back yet'}
          onclick={toggleHold}
        ><span class="dot" aria-hidden="true"></span> Not ready yet</button>
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
                  {of.toUpperCase()}{#if off(of)}<span class="visually-hidden"> — turned off for this entry</span>{:else if untranslated(of)}<span class="visually-hidden"> — not translated yet</span><span class="mark is-empty" aria-hidden="true"></span>{:else if entry.stale.includes(of)}<span class="visually-hidden"> — {language(entry.sourceLocale)} changed since this was translated</span><span class="mark" aria-hidden="true"></span>{/if}
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
          aria-haspopup="dialog"
          aria-expanded={confirming}
          disabled={!dirty || saving || missing.length > 0 || entry.drift.length > 0 || locked}
          title={locked
            ? 'Somebody else is editing this entry'
            : entry.drift.length
            ? 'The languages of this entry disagree about its blocks'
            : missing.length
              ? 'Fill in what is missing before publishing this entry'
              : undefined}
          onclick={askToPublish}
          bind:this={publishButton}
        >Publish this entry</button>
        <button class="btn btn-ghost" type="button" disabled aria-label="More actions">⋯</button>
      </div>
    </div>
    {#if conflicted}
      <p class="subline">
        Somebody changed this in the repository after you opened it. Open Unpublished changes to
        discard yours and take what is there now.
      </p>
    {/if}
    {#if held}
      <p class="subline">On hold — won't be included when others publish</p>
    {/if}
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
          <button class="btn-link" type="button" disabled={locked} onclick={editAddress}>Edit web address</button>
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
          <fieldset disabled={locked}>
            <Fields fields={entry.fields} blocks={entry.blocks} {problems} bind:root={data} />
          </fieldset>
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
                <button class="btn" type="button" disabled={busy || locked} onclick={() => offer(shown, true)}>
                  Turn {language(shown)} back on
                </button>
              </div>
            {:else}
              <div class="is-wide">
                <p>
                  Creating it copies the structure and everything that reads the same in every
                  language. The text fields start empty.
                </p>
                <button class="btn btn-primary btn-create" type="button" disabled={busy || locked} onclick={() => createFrom(shown)}>
                  Create from {language(entry.sourceLocale)}
                </button>
                {#if entry.translator}
                  <button class="btn btn-fill" type="button" disabled={busy || locked} onclick={() => createFilled(shown)}>
                    Create and pre-fill
                  </button>
                {/if}
                <p>
                  Or <button class="btn-link" type="button" disabled={busy || locked} onclick={() => offer(shown, false)}>don't offer this entry in {language(shown)}</button> — no file is written for it.
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
            source={entry.sourceLocale}
            {locked}
            stale={entry.stale.includes(shown)}
            translator={entry.translator}
            url={localeUrl(shown)}
            redirect={localeIndex(shown)}
            onsaved={(pending) => (translated = pending)}
            onrefused={(taken) => {
              lost = true;
              lock = taken as Lock;
            }}
            onclose={side ? () => leaving(() => (side = false)) : undefined}
            onturnoff={turnOff}
          />
        {/key}
      {/if}
    {/if}
  </div>
  <!-- It commits, so it confirms — and it names everything that goes with the entry, which is
       every language file. What it never offers is a choice of what to include: an entry
       publishes whole or not at all, and picking is what the drawer is for. -->
  {#if confirming}
    <div class="scrim">
      <!-- Not aria-modal: the screen under it is not inert, and claiming a trap that is not
           there is worse than not claiming it. -->
      <div class="dialog" role="dialog" aria-labelledby="publish-h" tabindex="-1" bind:this={publishPanel}>
        <h2 id="publish-h">Publish {title}?</h2>
        <p>
          This publishes it on its own. Anything else you have been working on stays unpublished.
        </p>
        {#if many && going.length}
          <ul class="publish-set">
            <li>
              <span class="chips" aria-label="Languages">
                {#each going as of (of)}<span class="chip">{of.toUpperCase()}</span>{/each}
              </span>
              {going.length === 1
                ? `The ${language(going[0] ?? '')} file`
                : `All ${going.length} language files`}
            </li>
          </ul>
        {/if}
        <p class="rebuild-note">
          One commit, then the site rebuilds — live in 1–3 minutes. The admin may reload while it
          deploys.
        </p>
        {#if publishFailed}<div class="notice notice-danger" role="alert">{publishFailed}</div>{/if}
        <div class="actions">
          <button class="btn" type="button" onclick={closePublish}>Cancel</button>
          <button class="btn btn-primary" type="button" disabled={sending} onclick={publishEntry}>
            {sending ? 'Publishing…' : 'Publish this entry'}
          </button>
        </div>
      </div>
    </div>
  {/if}
  {#if taking}
    <div class="scrim">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="take-h" tabindex="-1" bind:this={takePanel}>
        <h2 id="take-h">Take over editing from {holder}?</h2>
        <p>
          Nothing {holder} has written is lost — there is one shared draft and you carry on from
          where they left off.
        </p>
        <p>Their next save is refused and they are told you took over.</p>
        <div class="actions">
          <button class="btn" type="button" onclick={cancelTake}>Cancel</button>
          <button class="btn btn-primary" type="button" disabled={busy} onclick={takeOver}>Take over</button>
        </div>
      </div>
    </div>
  {/if}
</main>
