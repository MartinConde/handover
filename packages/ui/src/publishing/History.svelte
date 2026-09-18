<script lang="ts">
import type { DiffGroup } from '@handover/core';
import type {
  HistoricalRestoreResponse,
  HistoricalRestoreResult,
} from '../editor/entry-session.svelte';
import { messageText, responseMessage, type UiMessage } from '../errors.js';
import {
  formatExactTime,
  formatLanguageList,
  formatLanguageName,
  formatRelativeTime,
  messageOptions,
  type UiLocale,
} from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, sitePath, uncertainResponse } from '../request.js';
import Modal from '../shared/Modal.svelte';
import Diff from './Diff.svelte';

/** One version as `/admin/api/history/:collection/:slug` answers it. */
interface Version {
  sha: string;
  /** ISO 8601, as git wrote it. */
  date: string;
  summary: string;
  /** The languages of the entry this commit touched. */
  locales: string[];
  /** Nobody, where the commit is the App's and the log no longer has the row. */
  author?: string;
  /** The name the entry's files had at this commit, where a rename has moved them since. */
  name?: string;
}

let {
  collection,
  slug,
  locales = [],
  drafted = false,
  mediaBase = '',
  uiLocale = 'en',
  onrestored,
  onrestore,
}: {
  collection: string;
  slug: string;
  /** Where a stored media key is served from, for a replaced picture's thumbnails. */
  mediaBase?: string;
  uiLocale?: UiLocale;
  /** The languages the site declares; with one there is nothing to filter by. */
  locales?: string[];
  /** Whether the entry has unpublished changes a restore would write over. */
  drafted?: boolean;
  /** The version is in the drafts now: the editor reloads and the Content tab takes over. */
  onrestored: (date: string, outcome: 'restored' | 'uncertain') => void | Promise<void>;
  /** The entry session reserves autosave and owns the restore through authoritative reload. */
  onrestore: (
    request: () => Promise<HistoricalRestoreResponse>,
    reload: (outcome: 'restored' | 'uncertain') => void | Promise<void>,
  ) => Promise<HistoricalRestoreResult>;
} = $props();

let versions = $state<Version[]>([]);
let loading = $state(true);
const options = $derived(messageOptions(uiLocale));
let error = $state<UiMessage>();
let more = $state(false);
let page = $state(1);
/** Which language's commits are shown; empty is all of them. */
let only = $state('');
/** The version being read, and the pair being compared — one or the other, never both. */
let selected = $state<Version>();
let chosen = $state<Version[]>([]);
let groups = $state<DiffGroup[]>([]);
let reading = $state(false);
let diffError = $state<UiMessage>();
let diffEpoch = 0;
let diffIdentity = '';
/** The version the confirmation is about, and Cancel, which is where the answer is no. */
let confirming = $state<Version>();
let restoreButton = $state<HTMLElement>();
let restoring = $state(false);
let restoreError = $state<UiMessage>();

$effect(() => {
  resetDiffSelection();
  load(1, collection, slug);
});

async function load(want: number, entryCollection = collection, entrySlug = slug) {
  loading = true;
  const res = await fetch(`/admin/api/history/${entryCollection}/${entrySlug}?page=${want}`);
  loading = false;
  if (!res.ok) {
    // A 503 is the server's own sentence; anything else is GitHub refusing for a few minutes.
    error = await responseMessage(res, 'HISTORY_LOAD_FAILED');
    return;
  }
  error = undefined;
  page = want;
  const body = (await res.json()) as { versions?: Version[]; more?: boolean };
  versions = body.versions ?? [];
  more = body.more === true;
}

function cancelDiff() {
  diffEpoch += 1;
  diffIdentity = '';
  groups = [];
  reading = false;
  diffError = undefined;
}

function resetDiffSelection() {
  selected = undefined;
  chosen = [];
  confirming = undefined;
  restoreError = undefined;
  cancelDiff();
}

/** With one version the other side is what is live now; with two it is the older of them. */
async function readDiff(to: Version, from?: Version) {
  const entryCollection = collection;
  const entrySlug = slug;
  const epoch = ++diffEpoch;
  const identity = `${entryCollection}/${entrySlug}/${from?.sha ?? 'live'}..${to.sha}`;
  diffIdentity = identity;
  groups = [];
  reading = true;
  diffError = undefined;
  // A version from before a rename has its files under the name the entry had then.
  const query = new URLSearchParams({
    to: to.sha,
    ...(to.name ? { name: to.name } : {}),
    ...(from ? { from: from.sha } : {}),
    ...(from?.name ? { fromName: from.name } : {}),
  });
  const current = () =>
    epoch === diffEpoch &&
    identity === diffIdentity &&
    entryCollection === collection &&
    entrySlug === slug;
  const res = await fetch(`/admin/api/history/${entryCollection}/${entrySlug}/diff?${query}`);
  if (!current()) return;
  if (!res.ok) {
    reading = false;
    groups = [];
    diffError = await responseMessage(res, 'HISTORY_DIFF_FAILED');
    return;
  }
  const body = (await res.json()) as { groups?: DiffGroup[] };
  if (!current()) return;
  groups = body.groups ?? [];
  reading = false;
}

function closeConfirm() {
  confirming = undefined;
  restoreError = undefined;
}

/** Into the drafts, never a rewrite of git: publishing it is the ordinary forward commit. */
async function restore() {
  if (!confirming) return;
  restoring = true;
  const version = confirming;
  const result = await onrestore(
    async () => {
      const res = await fetch(`/admin/api/history/${collection}/${slug}/restore`, {
        method: 'POST',
        body: JSON.stringify({
          commit_sha: version.sha,
          ...(version.name ? { name: version.name } : {}),
        }),
      });
      if (uncertainResponse(res)) throw new TypeError('The restore response was not confirmed.');
      if (res.ok) return { ok: true };
      return { ok: false, error: await responseMessage(res, 'HISTORY_RESTORE_FAILED') };
    },
    (outcome) => onrestored(version.date, outcome),
  );
  restoring = false;
  if (!result.ok) {
    restoreError =
      result.error ??
      ({
        code:
          result.reason === 'save'
            ? 'HISTORY_RESTORE_SAVE_FAILED'
            : result.reason === 'uncertain'
              ? 'HISTORY_RESTORE_UNCONFIRMED'
              : result.reason === 'reload'
                ? 'HISTORY_RESTORE_RELOAD_FAILED'
                : 'HISTORY_RESTORE_FAILED',
      } satisfies UiMessage);
    return;
  }
  confirming = undefined;
  restoreError = undefined;
}

function open(version: Version) {
  confirming = undefined;
  restoreError = undefined;
  selected = version;
  chosen = [];
  readDiff(version);
}

function compare(version: Version, on: boolean) {
  confirming = undefined;
  restoreError = undefined;
  chosen = on ? [...chosen, version] : chosen.filter((v) => v.sha !== version.sha);
  selected = undefined;
  if (chosen.length !== 2) {
    cancelDiff();
    return;
  }
  const [older, newer] = [...chosen].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (older && newer) readDiff(newer, older);
}

const shown = $derived(only ? versions.filter((v) => v.locales.includes(only)) : versions);

const language = (of: string) => formatLanguageName(of, uiLocale);
const when = (iso: string) =>
  Date.parse(iso) ? formatRelativeTime(Date.parse(iso), uiLocale) : '';

/** Which languages a version writes, where the entry has more than the one. */
const spoken = (of: string[]) =>
  of.length > 1
    ? m.history_languages_spoken({ languages: formatLanguageList(of, uiLocale) }, options)
    : '';

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
</script>

<div class="history">
  <div class="history-list">
    <div class="history-list-head">
      <div>
        <h2>{m.history_title({}, options)}</h2>
        <p>
          {#if loading && versions.length === 0}
            {m.history_fetching({}, options)}
          {:else}
            {m.history_version_count({ count: shown.length }, options)}
          {/if}
        </p>
      </div>
      <span class={['compare-guide', { 'is-active': chosen.length > 0 }]}>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M6.5 4.5h-2v11h2M13.5 4.5h2v11h-2M8.5 7.5h3M8.5 12.5h3" />
        </svg>
        {chosen.length
          ? m.history_selected_count({ count: chosen.length }, options)
          : m.history_select_to_compare({}, options)}
      </span>
    </div>
    {#if locales.length > 1 || loading || chosen.length}
      <div class="version-tools">
        {#if locales.length > 1}
          <div class="seg" role="group" aria-label={m.common_language({}, options)}>
            <button type="button" aria-pressed={only === ''} onclick={() => (only = '')}>{m.common_all({}, options)}</button>
            {#each locales as of (of)}
              <button type="button" aria-pressed={only === of} onclick={() => (only = of)}>
                {of.toUpperCase()}<span class="visually-hidden"> — {language(of)}</span>
              </button>
            {/each}
          </div>
        {/if}
        <span class="spacer"></span>
        {#if loading}
          <span role="status">{m.history_loading({}, options)}</span>
        {:else if chosen.length}
          <span class="visually-hidden" role="status">{m.history_chosen_count({ count: chosen.length }, options)}</span>
        {/if}
      </div>
    {/if}
    {#if error}
      <div class="notice notice-danger" role="alert">
        <b>{m.history_load_title({}, options)}</b> — {messageText(error, uiLocale)}
        <button class="btn btn-sm" type="button" onclick={() => load(page)}>{m.common_try_again({}, options)}</button>
      </div>
    {:else if loading && versions.length === 0}
      <ul class="version-list">
        {#each [0, 1, 2, 3, 4, 5] as row (row)}
          <li>
            <div class="version-row is-skeleton" aria-hidden="true">
              <span class="skeleton is-box"></span>
              <span class="version-main">
                <span class="skeleton is-round"></span>
                <span class="version-copy">
                  <span class="skeleton w-80"></span>
                  <span class="skeleton w-60"></span>
                </span>
              </span>
            </div>
          </li>
        {/each}
      </ul>
    {:else if versions.length === 0}
      <!-- Not an error: the tab is reachable so the client learns where history will be. -->
      <div class="empty">
        <div>
          <h2>{m.history_empty_title({}, options)}</h2>
          <p>{m.history_empty_intro({}, options)}</p>
          <a class="btn" href={sitePath(`/admin/c/${collection}/${slug}`)}>{m.history_back_to_content({}, options)}</a>
        </div>
      </div>
    {:else if shown.length === 0}
      <div class="history-filter-empty">
        <strong>{m.history_filter_empty({ language: language(only) }, options)}</strong>
        <span>{m.history_filter_empty_hint({}, options)}</span>
        <button class="btn btn-sm" type="button" onclick={() => (only = '')}>{m.history_show_all({}, options)}</button>
      </div>
    {:else}
      <ul class="version-list">
        {#each shown as version (version.sha)}
          <li>
            <div class={['version-row', { 'is-current': selected?.sha === version.sha }]}>
              <input
                type="checkbox"
                checked={chosen.some((v) => v.sha === version.sha)}
                disabled={chosen.length === 2 && !chosen.some((v) => v.sha === version.sha)}
                aria-label={m.history_compare_version(
                  { when: when(version.date), summary: version.summary },
                  options,
                )}
                onchange={(e) => compare(version, e.currentTarget.checked)}
              />
              <div class="version-main">
                {#if version.author}
                  <span class="avatar avatar-sm" aria-hidden="true">{initials(version.author)}</span>
                {:else}
                  <span class="version-mark" aria-hidden="true">
                    <svg viewBox="0 0 20 20"><path d="M10 5.5v4.8l3.2 1.9M17 10a7 7 0 1 1-2.1-5" /><path d="M14.5 2.5v3h3" /></svg>
                  </span>
                {/if}
                <span class="version-copy">
                  <!-- A sha is a tooltip at most: a client has no use for it. -->
                  <button
                    class="summary"
                    type="button"
                    title={m.history_commit({ sha: version.sha.slice(0, 7) }, options)}
                    aria-current={selected?.sha === version.sha ? 'true' : undefined}
                    onclick={() => open(version)}
                  >{version.summary}</button>
                  <span class="sub">
                    <span>{when(version.date)}{version.author ? ` · ${version.author}` : ''}{version.name ? ` · ${m.history_as_name({ name: version.name }, options)}` : ''}</span>
                    <!-- A bare span may not carry an aria-label, so the word is in the sentence. -->
                    <span class="visually-hidden">{m.history_languages({}, options)}</span>
                    <span class="chips">
                      {#each version.locales as of (of)}
                        <span class="chip">{of.toUpperCase()}</span>
                      {/each}
                    </span>
                  </span>
                </span>
              </div>
              <svg class="version-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5" /></svg>
            </div>
          </li>
        {/each}
      </ul>
      {#if more}
        <div class="load-more">
          <button class="btn btn-sm" type="button" disabled={loading} onclick={() => load(page + 1)}>
            {loading ? m.common_loading({}, options) : m.history_show_older({}, options)}
          </button>
        </div>
      {/if}
    {/if}
  </div>
  <div class={['version-view', { 'has-version': selected || chosen.length === 2 }]}>
    {#if diffError}
      <p class="notice notice-danger" role="alert">{messageText(diffError, uiLocale)}</p>
    {:else if reading}
      <p class="placeholder" role="status">{m.history_reading({}, options)}</p>
    {:else if selected}
      <div class="version-head">
        <div class="version-title">
          <span class="version-kicker">{m.history_published_version({}, options)}</span>
          <h2>{m.history_version_from({ when: when(selected.date) }, options)}</h2>
        </div>
        <div class="actions">
          <button
            class="btn btn-primary"
            type="button"
            bind:this={restoreButton}
            onclick={() => (confirming = selected)}
          >{m.history_restore_this({}, options)}</button>
        </div>
        <p class="by">
          {selected.author ? m.history_published_by({ author: selected.author }, options) : ''}{formatExactTime(
            Date.parse(selected.date), uiLocale,
          )} · <em>{selected.summary}</em> · {m.history_compared_live({}, options)}
        </p>
      </div>
      <Diff {groups} {mediaBase} {uiLocale} />
    <!-- No Restore for a pair: it restores the version being looked at, which a pair is not. -->
    {:else if chosen.length === 2}
      {@const pair = [...chosen].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))}
      <div class="version-head">
        <div class="version-title">
          <span class="version-kicker">{m.history_comparison({}, options)}</span>
          <h2>{m.history_two_compared({}, options)}</h2>
        </div>
        <!-- Named by what each says: two versions of one afternoon both read "6 days ago". -->
        <p class="by">
          {m.history_from({}, options)} <em>{pair[0]?.summary}</em>, {when(pair[0]?.date ?? '')},
          {m.history_to({}, options)} <em>{pair[1]?.summary}</em>, {when(pair[1]?.date ?? '')}
        </p>
      </div>
      <Diff {groups} {mediaBase} {uiLocale} />
    {:else if versions.length}
      <div class="form-placeholder">
        <span class="history-placeholder-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 7v5l3 2M20 12a8 8 0 1 1-2.3-5.7" /><path d="M17 3v4h4" /></svg>
        </span>
        <span>
          <strong>{m.history_choose_version({}, options)}</strong>
          {m.history_choose_version_hint({}, options)}
        </span>
      </div>
    {/if}
  </div>
</div>

{#if confirming}
  <Modal
    labelledby="rs-h"
    describedby="rs-d"
    panelClass="dialog is-slim"
    returnTo={restoreButton}
    dismissible={!restoring}
    onclose={closeConfirm}
  >
      <h2 id="rs-h">{m.history_restore_question({ when: when(confirming.date) }, options)}</h2>
      <div id="rs-d">
        <p>
          {drafted
            ? m.history_restore_replaces({}, options)
            : m.history_restore_puts({}, options)}
          {m.history_restore_what(
            {
              author: confirming.author ?? m.history_somebody({}, options),
              date: formatExactTime(Date.parse(confirming.date), uiLocale),
              languages: spoken(confirming.locales),
            },
            options,
          )}
        </p>
        <p>{m.history_restore_forward({}, options)}</p>
      </div>
      {#if restoreError}<p class="notice notice-danger" role="alert">{messageText(restoreError, uiLocale)}</p>{/if}
      <div class="actions">
        <button class="btn" type="button" disabled={restoring} onclick={closeConfirm}>{m.common_cancel({}, options)}</button>
        <button class="btn btn-primary" type="button" disabled={restoring} onclick={restore}>
          {restoring ? m.history_restoring({}, options) : m.history_restore_as_draft({}, options)}
        </button>
      </div>
  </Modal>
{/if}
