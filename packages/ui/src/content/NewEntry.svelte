<script lang="ts">
import { addressError, entryName } from '@handover/core';
import { invalidateEntryDirectory } from '../entry-directory.js';
import { messageText, responseMessage, type UiMessage } from '../errors.js';
import { collectionName, messageOptions, type UiLocale } from '../i18n.js';
import { navigate } from '../navigate';
import * as m from '../paraglide/messages.js';
import { request as fetch } from '../request.js';
import Modal from '../shared/Modal.svelte';

let {
  collection,
  uiLocale = 'en',
  onclose,
}: { collection: string; uiLocale?: UiLocale; onclose: () => void } = $props();
const options = $derived(messageOptions(uiLocale));

// Read when the dialog opens, so the dashboard opens it exactly as the list does.
let taken = $state.raw<string[]>([]);
let templates = $state<string[]>([]);
let text = $state('');
let starter = $state('');
let busy = $state(false);
let error = $state<UiMessage>();
let directoryLoading = $state(true);
let directoryCurrent = $state(false);
let directoryError = $state<UiMessage>();
let loadRequest = 0;

$effect(() => {
  load(collection);
});

async function load(name: string) {
  const mine = ++loadRequest;
  directoryLoading = true;
  directoryError = undefined;
  const res = await fetch(`/admin/api/entries/${name}`);
  if (mine !== loadRequest) return;
  directoryLoading = false;
  if (!res.ok) {
    directoryCurrent = false;
    directoryError = await responseMessage(res, 'NEW_ENTRY_DIRECTORY_FAILED');
    return;
  }
  const body = (await res.json().catch(() => undefined)) as unknown;
  if (mine !== loadRequest) return;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    directoryCurrent = false;
    directoryError = { code: 'NEW_ENTRY_DIRECTORY_FAILED' };
    return;
  }
  const directory = body as { entries?: unknown; templates?: unknown };
  if (
    (directory.entries !== undefined && !Array.isArray(directory.entries)) ||
    (directory.templates !== undefined && !Array.isArray(directory.templates)) ||
    (Array.isArray(directory.entries) &&
      !directory.entries.every(
        (entry): entry is { id: string } =>
          typeof entry === 'object' && entry !== null && typeof entry.id === 'string',
      )) ||
    (Array.isArray(directory.templates) &&
      !directory.templates.every((template): template is string => typeof template === 'string'))
  ) {
    directoryCurrent = false;
    directoryError = { code: 'NEW_ENTRY_DIRECTORY_FAILED' };
    return;
  }
  taken = ((directory.entries ?? []) as { id: string }[]).map((entry) => entry.id);
  templates = (directory.templates ?? []) as string[];
  directoryCurrent = true;
}

const headingCollection = $derived(
  uiLocale === 'en'
    ? collectionName(collection, uiLocale, 'singular')
    : collectionName(collection, uiLocale),
);
const directoryText = $derived(
  directoryError?.code === 'CONNECTION_LOST'
    ? messageText(directoryError, uiLocale)
    : m.new_entry_directory_failed({ collection: collectionName(collection, uiLocale) }, options),
);
// The same derivation the server runs, so the dialog can promise the file name.
const preview = $derived(entryName('default', text, taken));
// `flat-by-the-sea` → `Flat by the sea`, which is all a file name has to say to be picked.
const starterLabel = (name: string) => {
  const words = name.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

async function create(event: Event) {
  event.preventDefault();
  if (!directoryCurrent) return;
  busy = true;
  error = undefined;
  const res = await fetch(`/admin/api/entries/${collection}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: text, ...(starter ? { template: starter } : {}) }),
  });
  if (!res.ok) {
    const failure = await responseMessage(res, 'ENTRY_CREATE_FAILED');
    if (failure.code === 'ENTRY_CREATE_FAILED' && !failure.detail) {
      const detail = await res.text().catch(() => '');
      error = { ...failure, ...(detail ? { detail } : {}) };
    } else error = failure;
    busy = false;
    return;
  }
  const body = (await res.json().catch(() => undefined)) as { slug?: unknown } | undefined;
  if (typeof body?.slug !== 'string' || !body.slug || addressError('default', body.slug)) {
    error = { code: 'ENTRY_CREATE_UNCONFIRMED' };
    busy = false;
    return;
  }
  busy = false;
  invalidateEntryDirectory();
  navigate(`/admin/c/${collection}/${body.slug}`);
}
</script>

<Modal labelledby="new-entry-h" initialFocus="#new-title" dismissible={!busy} {onclose}>
    <h2 id="new-entry-h">{m.new_entry_heading({ collection: headingCollection }, options)}</h2>
    <form onsubmit={create}>
      <div class="field">
        <div class="label-row"><label for="new-title">{m.new_entry_title({}, options)}</label></div>
        <input
          class="input"
          id="new-title"
          type="text"
          bind:value={text}
          aria-describedby="new-hint"
        />
        <p class="hint" id="new-hint">
          {#if directoryCurrent}
            {m.new_entry_saved_as_lead({}, options)} <span class="filename">{preview}</span>. {m.new_entry_saved_as_end({}, options)}
          {:else if directoryLoading}
            {m.new_entry_checking_name({}, options)}
          {:else}
            {m.new_entry_name_unavailable({}, options)}
          {/if}
        </p>
      </div>
      {#if directoryError}
        <div class="notice notice-danger entry-read-error" role="alert">
          {directoryText}
          {#if directoryError.detail}<span class="technical-detail">{m.common_technical_detail({ detail: directoryError.detail }, options)}</span>{/if}
          <button class="btn-link" type="button" onclick={() => load(collection)}>{m.common_retry({}, options)}</button>
        </div>
      {/if}
      {#if templates.length}
        <fieldset>
          <legend>{m.new_entry_start_from({}, options)}</legend>
          <label class="choice">
            <input type="radio" name="starter" value="" bind:group={starter} /> {m.new_entry_blank({}, options)}
          </label>
          {#each templates as name (name)}
            <label class="choice">
              <input type="radio" name="starter" value={name} bind:group={starter} />
              {starterLabel(name)} <span class="desc">{m.new_entry_template({}, options)}</span>
            </label>
          {/each}
        </fieldset>
      {/if}
      {#if error}<div class="notice notice-danger" role="alert">{messageText(error, uiLocale)}{#if error.detail}<span class="technical-detail">{m.common_technical_detail({ detail: error.detail }, options)}</span>{/if}</div>{/if}
      <div class="actions">
        <button class="btn" type="button" disabled={busy} onclick={onclose}>{m.common_cancel({}, options)}</button>
        <button class="btn btn-primary" type="submit" disabled={busy || !directoryCurrent}>
          {busy ? m.new_entry_creating({}, options) : m.new_entry_create({}, options)}
        </button>
      </div>
    </form>
</Modal>
