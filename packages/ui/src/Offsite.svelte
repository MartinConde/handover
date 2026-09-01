<script lang="ts">
import PagePicker, { type PickEntry } from './PagePicker.svelte';

/** One answer, which the server turns into a rule per language on the way in. */
export type Target =
  | { kind: 'index' }
  | { kind: 'entry'; value: string }
  | { kind: 'url'; value: string }
  | { kind: 'none' };

let {
  action,
  what,
  language = '',
  served,
  many = false,
  collection,
  index,
  busy = false,
  error = '',
  onconfirm,
  onhide,
  onclose,
}: {
  /** Hiding keeps the files and waits for a publish; deleting removes them in a commit now, and
      turning a language off removes that one language's file the same way. */
  action: 'hide' | 'delete' | 'off';
  /** What is coming off the site: one entry's title, or "4 listings" for a batch. */
  what: string;
  /** Turning off only: the language going, and the address it served the entry at. */
  language?: string;
  served?: string;
  /** Whether `what` is a batch, which is only the difference between two verbs. */
  many?: boolean;
  /** The collection these belong to: the overview is named for it, the button for one of them. */
  collection: string;
  /** The collection's page above it, pre-chosen because it is right most of the time. */
  index?: string;
  busy?: boolean;
  error?: string;
  onconfirm: (target: Target) => void;
  /** Deleting only: the way out the dialog leads with, since the client will want it back. */
  onhide?: () => void;
  onclose: () => void;
} = $props();

const singular = $derived(collection.replace(/s$/, ''));
const verb = $derived(action === 'delete' ? 'Delete' : 'Hide');

// The overview is the default where the collection has one; without it the honest default is
// nowhere, since there is no page above this one to send anybody to.
// svelte-ignore state_referenced_locally -- the collection's page above is the initial choice
let kind = $state<Target['kind']>(index ? 'index' : 'none');
let picked = $state<PickEntry>();
let url = $state('');

const target = (): Target =>
  kind === 'entry'
    ? { kind: 'entry', value: picked?.path ?? '' }
    : kind === 'url'
      ? { kind: 'url', value: url.trim() }
      : { kind };
const ready = $derived(kind === 'entry' ? Boolean(picked) : kind !== 'url' || url.trim() !== '');
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="scrim">
  <div class="dialog is-wide" role="dialog" aria-labelledby="offsite-h">
    <h2 id="offsite-h">Where should visitors to this page go now?</h2>
    <form onsubmit={(e) => { e.preventDefault(); onconfirm(target()); }}>
      {#if action === 'delete' && onhide}
        <p class="lead">
          <strong>Hide it instead?</strong> Hidden entries come off the site but can be brought
          back.
        </p>
      {/if}
      <p>
        {#if action === 'off'}
          The {language} half of <strong>{what}</strong>{#if served} — <code>{served}</code>{/if} leaves
          the repository in one commit; the entry is no longer offered in {language}, and
          unpublished changes to it go with it.
        {:else}
          <strong>{what}</strong>
          {#if action === 'delete'}
            leaves the repository in one commit, and its unpublished changes go with it.
          {:else}
            {many ? 'come' : 'comes'} off the site the next time you publish.
          {/if}
        {/if}
        Anyone following an old link — a bookmark, an email, a search result — has to land
        somewhere.
      </p>
      <fieldset>
        <legend class="visually-hidden">Where to send them</legend>
        {#if index}
          <label class="choice">
            <input type="radio" name="offsite-to" value="index" bind:group={kind} />
            The {collection} overview <span class="desc">{index}</span>
          </label>
        {/if}
        <label class="choice">
          <input type="radio" name="offsite-to" value="entry" bind:group={kind} />
          Another page…
        </label>
        {#if kind === 'entry'}
          <PagePicker
            id="offsite-pick"
            label="pages and entries"
            labelId="offsite-h"
            chosen={picked?.path}
            onpick={(entry) => (picked = entry)}
            onclose={() => (kind = index ? 'index' : 'none')}
          />
        {/if}
        <label class="choice">
          <input type="radio" name="offsite-to" value="url" bind:group={kind} />
          A web address…
        </label>
        {#if kind === 'url'}
          <div class="field">
            <div class="label-row"><label for="offsite-url">Web address</label></div>
            <input class="input" id="offsite-url" type="url" placeholder="https://example.com" bind:value={url} />
          </div>
        {/if}
        <label class="choice">
          <input type="radio" name="offsite-to" value="none" bind:group={kind} />
          Nowhere — show “page not found” <span class="desc">404</span>
        </label>
      </fieldset>
      <!-- One answer, several rules: the server writes each language's from the address that
           language serves, which is why the dialog asks once however many languages there are. -->
      <p class="hint">
        The rule is written {action === 'hide' ? 'when you publish' : 'in the same commit'}{#if action !== 'off'},
          once per language, from the address each of them serves at{/if}.
      </p>
      {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
      <div class="actions">
        <button class="btn" type="button" onclick={onclose}>Cancel</button>
        {#if action === 'delete' && onhide}
          <button class="btn btn-primary" type="button" onclick={onhide}>Hide instead</button>
        {/if}
        <button
          class="btn {action === 'hide' ? 'btn-primary' : 'btn-danger'}"
          type="submit"
          disabled={busy || !ready}
        >
          {#if busy}
            {action === 'delete' ? 'Deleting…' : action === 'off' ? 'Turning off…' : 'Hiding…'}
          {:else if action === 'off'}
            Turn {language} off
          {:else}
            {verb} {many ? what : `this ${singular}`}
          {/if}
        </button>
      </div>
    </form>
  </div>
</div>
