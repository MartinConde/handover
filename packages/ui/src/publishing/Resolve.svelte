<script lang="ts">
import type { Change, MergedChange, Question } from '@handover/core';
import { messageText, responseMessage, type UiMessage } from '../errors.js';
import { formatExactTime, messageOptions, type UiLocale } from '../i18n.js';
import { coordinateEntryReplacement } from '../navigate';
import * as m from '../paraglide/messages.js';
import { request as fetch, uncertainResponse } from '../request.js';

let {
  entry,
  title,
  updated,
  uiLocale = 'en',
  onclose,
  onresolved,
}: {
  /** `listings/mill-house` — the entry the repository moved under. */
  entry: string;
  title: string;
  /** When the draft was last typed in, which is the only date the client owns here. */
  updated: number;
  uiLocale?: UiLocale;
  onclose: () => void;
  /** The answers are written: the draft now sits on the file at HEAD and can publish. */
  onresolved: () => void;
} = $props();
const options = $derived(messageOptions(uiLocale));

let questions = $state.raw<Question[]>([]);
let merged = $state.raw<MergedChange[]>([]);
/** The commit the repository is at, which is what "theirs" is of. */
let head = $state('');
let version = $state('');
let answers = $state<Record<string, 'ours' | 'theirs'>>({});
let loading = $state(true);
let busy = $state(false);
let error = $state<UiMessage>();
const errorText = $derived(
  error
    ? [
        messageText(error, uiLocale),
        error.detail ? m.common_technical_detail({ detail: error.detail }, options) : '',
      ]
        .filter(Boolean)
        .join(' ')
    : '',
);
let reportKnown = $state(false);
let reportCurrent = $state(false);

// A question is one field of one language, or one every language shares.
const key = (q: { path: string; locale?: string }) => `${q.locale ?? ''} ${q.path}`;
const answered = $derived(questions.filter((q) => answers[key(q)]).length);
$effect(() => {
  void load();
});

async function load() {
  loading = true;
  error = undefined;
  reportCurrent = false;
  const res = await fetch(`/admin/api/conflict/${entry}`);
  loading = false;
  if (!res.ok) {
    error = await responseMessage(res, 'CONFLICT_LOAD_FAILED');
    return;
  }
  const body = (await res.json()) as {
    questions: Question[];
    merged: MergedChange[];
    head: string;
    version: string;
  };
  answers = {};
  questions = body.questions;
  merged = body.merged;
  head = body.head;
  version = body.version;
  reportKnown = true;
  reportCurrent = true;
}

/** Every question at once, for the client who does not want to read them. */
async function all(side: 'ours' | 'theirs') {
  if (!reportCurrent) return;
  for (const q of questions) answers[key(q)] = side;
  await done();
}

async function done() {
  if (!reportCurrent) return;
  busy = true;
  error = undefined;
  let res: Response | undefined;
  const outcome = await coordinateEntryReplacement(entry, async () => {
    res = await fetch(`/admin/api/conflict/${entry}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version,
        answers: questions.map((q) => ({
          path: q.path,
          ...(q.locale ? { locale: q.locale } : {}),
          side: answers[key(q)],
        })),
      }),
    });
    if (uncertainResponse(res)) throw new TypeError('The conflict response was not confirmed.');
    return res.ok;
  });
  busy = false;
  if (!outcome.ok && outcome.reason === 'save') {
    error = { code: 'CONFLICT_SAVE_FAILED' };
    return;
  }
  if (!outcome.ok && (outcome.reason === 'uncertain' || outcome.reason === 'reload')) {
    reportCurrent = false;
    error = { code: 'CONFLICT_UNCONFIRMED' };
    return;
  }
  if (!outcome.ok) {
    reportCurrent = false;
    if (!res) {
      error = { code: 'CONFLICT_UNCONFIRMED' };
      return;
    }
    error = await responseMessage(res, 'CONFLICT_RESOLVE_FAILED');
    return;
  }
  onresolved();
}

/** What a merged change says it did, in as many words as it has. */
const said = (change: Change): string => {
  if (change.kind === 'row')
    return change.at === 'moved-up'
      ? m.conflict_moved_up({}, options)
      : change.at === 'moved-down'
        ? m.conflict_moved_down({}, options)
        : m.conflict_row_changed({ change: change.at }, options);
  if (change.kind === 'value')
    return change.before === undefined
      ? m.conflict_set_to({ value: String(change.after ?? '') }, options)
      : change.after === undefined
        ? m.conflict_cleared({}, options)
        : m.conflict_value_changed(
            { before: String(change.before), after: String(change.after) },
            options,
          );
  return m.conflict_rewritten({}, options);
};
</script>

<!-- What this side says, with what it added marked. -->
{#snippet value(change: Change)}
  {#if change.kind === 'value'}{change.after ?? m.conflict_empty({}, options)}
  {:else if change.kind === 'words'}{#each change.parts.filter((p) => p.mark !== 'del') as part}{#if part.mark === 'ins'}<ins
        >{part.text}</ins
      >{:else}{part.text}{/if}{/each}
  {:else}{m.conflict_rewritten({}, options)}{/if}
{/snippet}

{#snippet side(q: Question, mine: boolean)}
  {@const change = mine ? q.ours : q.theirs}
  {@const short = change.kind === 'value'}
  <label class="choice">
    <input
      type="radio"
      name="resolve-{key(q)}"
      checked={answers[key(q)] === (mine ? 'ours' : 'theirs')}
      disabled={busy}
      onchange={() => (answers[key(q)] = mine ? 'ours' : 'theirs')}
    >
    <span class="body">
      <!-- Literal spacing keeps Svelte blocks from joining words. -->
      <b>{mine ? m.conflict_yours({}, options) : m.conflict_theirs({}, options)}{#if short}{' — '}{@render value(change)}{/if}</b>
      {#if !short}<span class="quote">{@render value(change)}</span>{/if}
      <small>
        {#if mine}{m.conflict_you_at({ date: formatExactTime(updated, uiLocale) }, options)}
        {:else}{m.conflict_in_repository({}, options)}{#if head}{' · '}{m.conflict_commit({}, options)} <code>{head.slice(0, 7)}</code>{/if}
        {/if}
      </small>
    </span>
  </label>
{/snippet}

<!-- The list it replaced is gone from the drawer, so the panel takes the focus with it. -->
<div class="resolve" aria-labelledby="resolve-h" tabindex="-1" {@attach (node) => node.focus()}>
  <header>
    <h3 id="resolve-h">{m.conflict_title({ title }, options)}</h3>
    <p>
      {#if loading}
        {m.conflict_reading({}, options)}
      {:else if !reportKnown}
        {m.conflict_report_unavailable({}, options)}
      {:else}
        {m.conflict_intro({}, options)}
        {#if merged.length}{m.conflict_merged_count({ count: merged.length }, options)}{/if}
        {#if questions.length}
          {m.conflict_question_count({ count: questions.length }, options)}
        {:else}
          {m.conflict_nothing_to_answer({}, options)}
        {/if}
      {/if}
    </p>
  </header>

  {#if questions.length > 1}
    <div class="resolve-shortcuts">
      <div class="btns">
        <button class="btn btn-sm" type="button" disabled={busy} onclick={() => all('ours')}>
          {m.conflict_keep_all_mine({}, options)}
        </button>
        <button class="btn btn-sm" type="button" disabled={busy} onclick={() => all('theirs')}>
          {m.conflict_take_all_theirs({}, options)}
        </button>
      </div>
      <p class="sub">
        {m.conflict_shortcut_explanation({ count: questions.length }, options)}
      </p>
    </div>
  {/if}

  {#if questions.length}
    <ul class="resolve-list">
      {#each questions as q (key(q))}
        <li class="resolve-field">
          <div class="head">
            <span class="name">{q.labels?.[uiLocale] ?? q.label}</span>
            {#if q.locale}
              <span class="visually-hidden">{m.conflict_language({}, options)}</span><span class="chips"><span class="chip">{q.locale.toUpperCase()}</span></span>
            {:else}
              <span class="badge">{m.conflict_same_every_language({}, options)}</span>
            {/if}
          </div>
          {#if q.base !== undefined}
            <p class="base">{m.conflict_both_started({}, options)} <b>{q.base}</b></p>
          {/if}
          <fieldset class="sides">
            <legend class="visually-hidden">{m.conflict_which_to_keep({ label: q.labels?.[uiLocale] ?? q.label }, options)}</legend>
            {@render side(q, true)}
            {@render side(q, false)}
          </fieldset>
        </li>
      {/each}
    </ul>
  {/if}

  {#if merged.length}
    <details class="group">
      <summary>{m.conflict_merged_for_you({}, options)} <span class="count">{merged.length}</span></summary>
      <ul class="merged-list">
        {#each merged as change (key({ path: change.change.path, locale: change.locale }))}
          <li>
            <span class="name">
              {change.labels?.[uiLocale] ?? change.label}
              {#if change.locale}<span class="chip">{change.locale.toUpperCase()}</span>{/if}
            </span>
            <span class="sub">
              {change.side === 'ours'
                ? m.conflict_only_you_changed({ change: said(change.change) }, options)
                : m.conflict_only_code_changed({ change: said(change.change) }, options)}
            </span>
          </li>
        {/each}
      </ul>
    </details>
  {/if}

  {#if error}<div class="notice notice-danger" role="alert">{errorText}</div><button type="button" class="btn" disabled={busy} onclick={load}>{m.conflict_reload({}, options)}</button>{/if}

  <div class="actions">
    <button class="btn" type="button" disabled={busy} onclick={onclose}>{m.common_cancel({}, options)}</button>
    <button
      class="btn btn-primary"
      type="button"
      disabled={busy || loading || !reportCurrent || answered !== questions.length}
      onclick={() => done()}
    >
      {#if busy}{m.conflict_saving({}, options)}
      {:else if questions.length}{m.conflict_done_progress({ answered, total: questions.length }, options)}
      {:else}{m.conflict_done({}, options)}{/if}
    </button>
    <p class="foot-note">
      {m.conflict_foot_note({ count: questions.length }, options)}
    </p>
  </div>
</div>
