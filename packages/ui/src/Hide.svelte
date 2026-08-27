<script lang="ts">
import PagePicker, { type PickEntry } from './PagePicker.svelte';

/** One answer, which the server turns into a rule per language on the way in. */
export type Target =
  | { kind: 'index' }
  | { kind: 'entry'; value: string }
  | { kind: 'url'; value: string }
  | { kind: 'none' };

let {
  what,
  many = false,
  collection,
  index,
  busy = false,
  error = '',
  onhide,
  onclose,
}: {
  /** What is coming off the site: one entry's title, or "4 listings" for a batch. */
  what: string;
  /** Whether `what` is a batch, which is only the difference between two verbs. */
  many?: boolean;
  /** The collection these belong to: the overview is named for it, the button for one of them. */
  collection: string;
  /** The collection's page above it, pre-chosen because it is right most of the time. */
  index?: string;
  busy?: boolean;
  error?: string;
  onhide: (target: Target) => void;
  onclose: () => void;
} = $props();

const singular = $derived(collection.replace(/s$/, ''));

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
  <div class="dialog is-wide" role="dialog" aria-labelledby="hide-h">
    <h2 id="hide-h">Where should visitors to this page go now?</h2>
    <form onsubmit={(e) => { e.preventDefault(); onhide(target()); }}>
      <p>
        <strong>{what}</strong>
        {many ? 'come' : 'comes'} off the site the next time you publish. Anyone following an old link —
        a bookmark, an email, a search result — has to land somewhere.
      </p>
      <fieldset>
        <legend class="visually-hidden">Where to send them</legend>
        {#if index}
          <label class="choice">
            <input type="radio" name="hide-to" value="index" bind:group={kind} />
            The {collection} overview <span class="desc">{index}</span>
          </label>
        {/if}
        <label class="choice">
          <input type="radio" name="hide-to" value="entry" bind:group={kind} />
          Another page…
        </label>
        {#if kind === 'entry'}
          <PagePicker
            id="hide-pick"
            label="pages and entries"
            labelId="hide-h"
            chosen={picked?.path}
            onpick={(entry) => (picked = entry)}
            onclose={() => (kind = index ? 'index' : 'none')}
          />
        {/if}
        <label class="choice">
          <input type="radio" name="hide-to" value="url" bind:group={kind} />
          A web address…
        </label>
        {#if kind === 'url'}
          <div class="field">
            <div class="label-row"><label for="hide-url">Web address</label></div>
            <input class="input" id="hide-url" type="url" placeholder="https://example.com" bind:value={url} />
          </div>
        {/if}
        <label class="choice">
          <input type="radio" name="hide-to" value="none" bind:group={kind} />
          Nowhere — show “page not found” <span class="desc">404</span>
        </label>
      </fieldset>
      <!-- One answer, several rules: the server writes each language's from the address that
           language serves, which is why the dialog asks once however many languages there are. -->
      <p class="hint">
        The rule is written when you publish, once per language, from the address each of them
        serves at.
      </p>
      {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
      <div class="actions">
        <button class="btn" type="button" onclick={onclose}>Cancel</button>
        <button class="btn btn-primary" type="submit" disabled={busy || !ready}>
          {busy ? 'Hiding…' : many ? `Hide ${what}` : `Hide this ${singular}`}
        </button>
      </div>
    </form>
  </div>
</div>
