<script lang="ts">
import type { Field } from '@handover/core';
import type { Snippet } from 'svelte';
import OffsiteDialog, { type Target } from '../content/Offsite.svelte';
import type { UiMessage } from '../errors.js';
import { formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import ConfirmDialog from '../shared/ConfirmDialog.svelte';
import Modal from '../shared/Modal.svelte';
import type { createEntryActions } from './entry-actions.svelte';
import type { EditorEntry } from './entry-payload';
import SourceChange from './SourceChange.svelte';

let {
  entryActions,
  entry,
  title,
  collection,
  locale,
  fields,
  blocks,
  uiLocale = 'en',
  localeUrl,
  localeIndex,
  reload,
  feedback,
}: {
  entryActions: ReturnType<typeof createEntryActions>;
  entry: EditorEntry;
  title: string;
  collection: string;
  locale: string;
  fields: readonly Field[];
  blocks: Record<string, Field[]>;
  uiLocale?: UiLocale;
  localeUrl: (of: string) => string | undefined;
  localeIndex: (of: string) => string | undefined;
  reload: () => void | Promise<void>;
  feedback: Snippet<[UiMessage]>;
} = $props();
const options = $derived(messageOptions(uiLocale));
const language = (of: string) => formatLanguageName(of, uiLocale);
</script>

{#if entryActions.hiding}
  <OffsiteDialog
    action="hide"
    what={title}
    {collection}
    index={localeIndex(locale)}
    busy={entryActions.busy}
    {uiLocale}
    error={entryActions.statusFailed}
    returnTo={entryActions.actionTrigger}
    onconfirm={(target: Target) => entryActions.setStatus(true, target)}
    onclose={() => (entryActions.hiding = false)}
  />
{/if}
{#if entryActions.changingSource}
  <SourceChange
    locales={entry.locales}
    source={entry.sourceLocale}
    files={entryActions.sourceFiles}
    offered={entry.offered}
    stale={entry.stale}
    {fields}
    {blocks}
    {uiLocale}
    sending={entryActions.sendingSource}
    failure={entryActions.sourceFailure}
    returnTo={entryActions.actionTrigger}
    onconfirm={entryActions.changeSourceTo}
    onclose={() => (entryActions.changingSource = false)}
    onreload={() => void reload()}
  />
{/if}
{#if entryActions.renaming}
  <Modal labelledby="rename-h" initialFocus="#rename-to" returnTo={entryActions.actionTrigger} dismissible={!entryActions.busy} onclose={() => (entryActions.renaming = false)}>
      <h2 id="rename-h">{m.entry_list_rename_question({ title }, options)}</h2>
      <form onsubmit={entryActions.rename}>
        <div class="field">
          <div class="label-row"><label for="rename-to">{m.entry_list_file_name({}, options)}</label></div>
          <input class="input filename" id="rename-to" type="text" bind:value={entryActions.newName} aria-describedby="rename-hint" />
          <p class="hint" id="rename-hint">
            {m.entry_list_saved_as({}, options)} <span class="filename">{entryActions.willBe}</span>. {m.entry_list_rename_hint({}, options)}
          </p>
        </div>
        {#if entryActions.actionFailed}<div class="notice notice-danger" role="alert">{@render feedback(entryActions.actionFailed)}</div>{/if}
        <div class="actions">
          <button class="btn" type="button" disabled={entryActions.busy} onclick={() => (entryActions.renaming = false)}>{m.common_cancel({}, options)}</button>
          <button class="btn btn-primary" type="submit" disabled={entryActions.busy}>{entryActions.busy ? m.entry_list_renaming({}, options) : m.editor_rename({}, options)}</button>
        </div>
      </form>
  </Modal>
{/if}
{#if entryActions.deleting}
  <OffsiteDialog
    action="delete"
    what={title}
    {collection}
    index={localeIndex(locale)}
    busy={entryActions.busy}
    {uiLocale}
    error={entryActions.actionFailed}
    returnTo={entryActions.actionTrigger}
    onconfirm={entryActions.remove}
    onhide={() => { entryActions.deleting = false; entryActions.hiding = true; }}
    onclose={() => (entryActions.deleting = false)}
  />
{/if}
{#if entryActions.discarding}
  <ConfirmDialog
    labelledby="discard-h"
    role="dialog"
    returnTo={entryActions.actionTrigger}
    title={m.pending_discard_question({ title }, options)}
    cancel={m.common_cancel({}, options)}
    confirm={entryActions.discardBusy ? m.pending_discarding({}, options) : m.pending_discard_changes({}, options)}
    busy={entryActions.discardBusy}
    onconfirm={entryActions.discardDraft}
    onclose={() => (entryActions.discarding = false)}
  >
    <p>{entry.published.length ? m.pending_discard_explanation({}, options) : m.pending_discard_created({}, options)}</p>
    {#if entryActions.actionFailed}<div class="notice notice-danger" role="alert">{@render feedback(entryActions.actionFailed)}</div>{/if}
  </ConfirmDialog>
{/if}
{#if entryActions.offing}
  {@const going = entryActions.offing}
  <OffsiteDialog
    action="off"
    language={language(going)}
    what={title}
    served={localeUrl(going)}
    {collection}
    index={localeIndex(going)}
    busy={entryActions.busy}
    {uiLocale}
    error={entryActions.actionFailed}
    returnTo={entryActions.actionTrigger}
    onconfirm={(target: Target) => entryActions.turnOff(going, target)}
    onclose={() => (entryActions.offing = undefined)}
  />
{/if}
