<script lang="ts">
import type { Snippet } from 'svelte';
import type { UiMessage } from '../errors.js';
import { formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { when } from '../shared/activity-line';
import type { CreatedAll } from './Editor.svelte';
import type { createEntryLock } from './entry-lock.svelte';
import type { EditorEntry } from './entry-payload';

let {
  entry,
  entryLock,
  uiLocale = 'en',
  drifted,
  restored,
  sourceChanged,
  createdAll,
  reportedHere,
  hasSnapshot,
  takeTrigger = $bindable(),
  reload,
  oncreatedall,
  feedback,
}: {
  entry: EditorEntry;
  entryLock: ReturnType<typeof createEntryLock>;
  uiLocale?: UiLocale;
  drifted: boolean;
  restored?: string;
  sourceChanged?: string;
  createdAll?: CreatedAll;
  /** False for a report made before the reload: the files now answer it. */
  reportedHere: boolean;
  hasSnapshot: (locale: string) => boolean;
  takeTrigger?: HTMLButtonElement;
  reload: () => unknown;
  oncreatedall?: (report: CreatedAll | undefined) => void;
  feedback: Snippet<[UiMessage]>;
} = $props();
const options = $derived(messageOptions(uiLocale));
const language = (of: string) => formatLanguageName(of, uiLocale);
const LOCK_IDLE_MS = 60000;

function createdLine(of: string, report: CreatedAll) {
  const named = { language: language(of) };
  const failed = report.failed?.locale === of ? report.failed : undefined;
  if (failed?.step === 'fill')
    return failed.unconfirmed
      ? m.editor_created_all_fill_unconfirmed(named, options)
      : m.editor_created_all_not_filled(named, options);
  if (failed?.unconfirmed && reportedHere) return m.editor_created_all_unconfirmed(named, options);
  if (failed?.unconfirmed && hasSnapshot(of)) return m.editor_created_all_created(named, options);
  if (failed) return m.editor_created_all_not_created(named, options);
  if (report.done[of] === 'filled') return m.editor_created_all_filled(named, options);
  if (report.done[of]) return m.editor_created_all_created(named, options);
  return m.editor_created_all_not_attempted(named, options);
}
</script>

{#each entry.offerProblems ?? [] as problem (problem)}
  <div class="lock-banner is-offer">{m.editor_offer_problem({ problem }, options)}</div>
{/each}
{#if entryLock.lost}
  <!-- Leads with where the work went: the draft is in D1. -->
  <div class="lock-banner is-lost">
    {#if entryLock.otherTab}
      {m.editor_lock_lost_other_tab({}, options)}
    {:else if entryLock.holderName}
      {m.editor_lock_lost_taken({ holder: entryLock.holderName }, options)}
    {:else}
      {m.editor_lock_lost_taken_anonymous({}, options)}
    {/if}
    <button class="btn-link" type="button" onclick={() => void reload()}>{m.editor_lock_reload({}, options)}</button>
  </div>
{:else if entryLock.locked}
  <div class="lock-banner">
    {#if entryLock.otherTab}
      {m.editor_lock_other_tab({}, options)}
      <button class="btn-link" type="button" bind:this={takeTrigger} onclick={entryLock.openTake}>{m.editor_lock_edit_here({}, options)}</button>
    {:else if entryLock.lock?.held_by}
      {#if entryLock.holderName}
        {m.editor_lock_held_by({ holder: entryLock.holderName }, options)}
      {:else}
        {m.editor_lock_held_anonymous({}, options)}
      {/if}
      <span class="when">
        {entryLock.idle >= LOCK_IDLE_MS
          ? m.editor_lock_idle({}, options)
          : m.editor_lock_active({}, options)}
      </span>
      <button class="btn-link" type="button" bind:this={takeTrigger} onclick={entryLock.openTake}>{m.editor_lock_take_over({}, options)}</button>
    {:else}
      {m.editor_lock_nobody({}, options)}
      <button class="btn-link" type="button" onclick={() => void reload()}>{m.editor_lock_reload({}, options)}</button>
    {/if}
  </div>
{/if}
{#if restored && entry.pending.length}
  <!-- The restore is over by the time this draws, so this is what says what just happened. -->
  <div class={['lock-banner', { 'is-drift': drifted }]} role="status">
    <span>
      <b>{m.editor_restored_version({ date: when(Date.parse(restored)).toLowerCase() }, options)}</b>
      {#if drifted}
        {m.editor_restored_drift({}, options)}
      {:else}
        {m.editor_restored_unpublished({}, options)}
      {/if}
    </span>
  </div>
{:else if drifted}
  <div class="lock-banner is-drift">{m.editor_drift_blocked({}, options)}</div>
{:else if sourceChanged === entry.sourceLocale && entry.pending.length}
  <div class="lock-banner" role="status">{m.editor_source_changed({ language: language(entry.sourceLocale) }, options)}</div>
{/if}
{#if createdAll}
  <div class={['lock-banner created-all', { 'is-offer': createdAll.failed }]} role="status">
    <ul>
      {#each createdAll.targets as of (of)}
        <li>{createdLine(of, createdAll)}</li>
      {/each}
    </ul>
    {#if createdAll.failed && !(createdAll.failed.unconfirmed && !reportedHere)}
      <p>{@render feedback(createdAll.failed.message)}</p>
    {/if}
    <button class="btn-link" type="button" onclick={() => oncreatedall?.(undefined)}>{m.editor_created_all_dismiss({}, options)}</button>
  </div>
{/if}
