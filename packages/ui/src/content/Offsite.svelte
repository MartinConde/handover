<script lang="ts">
import type { PickEntry } from '../entry-directory.js';
import { messageText, type UiMessage } from '../errors.js';
import { collectionName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import Modal from '../shared/Modal.svelte';
import PagePicker from './PagePicker.svelte';

/** The server turns one answer into a rule per language. */
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
  uiLocale = 'en',
  returnTo,
  onconfirm,
  onhide,
  onclose,
}: {
  /** Hiding waits for a publish; deleting and turning off commit now. */
  action: 'hide' | 'delete' | 'off';
  /** One entry's title, or "4 listings" for a batch. */
  what: string;
  /** Turning off only. */
  language?: string;
  served?: string;
  many?: boolean;
  collection: string;
  /** Pre-chosen because it is right most of the time. */
  index?: string;
  busy?: boolean;
  error?: string | UiMessage;
  uiLocale?: UiLocale;
  returnTo?: HTMLElement | null;
  onconfirm: (target: Target) => void;
  /** Deleting only: led with, since the client will want it back. */
  onhide?: () => void;
  onclose: () => void;
} = $props();
const options = $derived(messageOptions(uiLocale));
const errorText = $derived(
  typeof error === 'string'
    ? error
    : error
      ? [
          messageText(error, uiLocale),
          error.detail ? m.common_technical_detail({ detail: error.detail }, options) : '',
        ]
          .filter(Boolean)
          .join(' ')
      : '',
);

const singular = $derived(collectionName(collection, uiLocale, 'singular'));

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

<Modal
  labelledby="offsite-h"
  panelClass="dialog is-wide"
  {returnTo}
  dismissible={!busy}
  {onclose}
>
    <h2 id="offsite-h">{m.offsite_title({}, options)}</h2>
    <form onsubmit={(e) => { e.preventDefault(); onconfirm(target()); }}>
      {#if action === 'delete' && onhide}
        <p class="lead">
          <strong>{m.offsite_hide_instead_question({}, options)}</strong>
          {m.offsite_hide_instead_explanation({}, options)}
        </p>
      {/if}
      <p>
        {#if action === 'off'}
          {m.offsite_turn_off_before({ language }, options)} <strong>{what}</strong>{#if served} — <code>{served}</code>{/if}
          {m.offsite_turn_off_after({ language }, options)}
        {:else}
          <strong>{what}</strong>
          {#if action === 'delete'}
            {m.offsite_delete_explanation({}, options)}
          {:else}
            {m.offsite_hide_explanation({ count: many ? 2 : 1 }, options)}
          {/if}
        {/if}
        {m.offsite_old_links({}, options)}
      </p>
      <fieldset>
        <legend class="visually-hidden">{m.offsite_send_to({}, options)}</legend>
        {#if index}
          <label class="choice">
            <input type="radio" name="offsite-to" value="index" bind:group={kind} />
            {m.offsite_collection_overview({ collection: collectionName(collection, uiLocale) }, options)} <span class="desc">{index}</span>
          </label>
        {/if}
        <label class="choice">
          <input type="radio" name="offsite-to" value="entry" bind:group={kind} />
          {m.offsite_another_page({}, options)}
        </label>
        {#if kind === 'entry'}
          <PagePicker
            id="offsite-pick"
            label="pages and entries"
            labelKind="pages-and-entries"
            labelId="offsite-h"
            {uiLocale}
            chosen={picked?.path}
            onpick={(entry) => (picked = entry)}
            onclose={() => (kind = index ? 'index' : 'none')}
          />
        {/if}
        <label class="choice">
          <input type="radio" name="offsite-to" value="url" bind:group={kind} />
          {m.offsite_web_address_choice({}, options)}
        </label>
        {#if kind === 'url'}
          <div class="field">
            <div class="label-row"><label for="offsite-url">{m.redirect_web_address({}, options)}</label></div>
            <input class="input" id="offsite-url" type="url" placeholder="https://example.com" bind:value={url} />
          </div>
        {/if}
        <label class="choice">
          <input type="radio" name="offsite-to" value="none" bind:group={kind} />
          {m.offsite_nowhere({}, options)} <span class="desc">404</span>
        </label>
      </fieldset>
      <!-- The server writes a rule per language, so the dialog asks once. -->
      <p class="hint">
        {action === 'hide'
          ? m.offsite_rule_on_publish({}, options)
          : m.offsite_rule_same_commit({}, options)}{#if action !== 'off'}{m.offsite_rule_each_language({}, options)}{/if}
      </p>
      {#if errorText}<div class="notice notice-danger" role="alert">{errorText}</div>{/if}
      <div class="actions">
        <button class="btn" type="button" disabled={busy} onclick={onclose}>{m.common_cancel({}, options)}</button>
        {#if action === 'delete' && onhide}
          <button class="btn btn-primary" type="button" disabled={busy} onclick={onhide}>{m.offsite_hide_instead({}, options)}</button>
        {/if}
        <button
          class="btn {action === 'hide' ? 'btn-primary' : 'btn-danger'}"
          type="submit"
          disabled={busy || !ready}
        >
          {#if busy}
            {action === 'delete'
              ? m.offsite_deleting({}, options)
              : action === 'off'
                ? m.offsite_turning_off({}, options)
                : m.offsite_hiding({}, options)}
          {:else if action === 'off'}
            {m.offsite_turn_off({ language }, options)}
          {:else if action === 'delete' && many}
            {m.offsite_delete_many({ what }, options)}
          {:else if action === 'delete'}
            {m.offsite_delete_one({ kind: singular }, options)}
          {:else if many}
            {m.offsite_hide_many({ what }, options)}
          {:else}
            {m.offsite_hide_one({ kind: singular }, options)}
          {/if}
        </button>
      </div>
    </form>
</Modal>
