<script lang="ts">
import { messageText, responseMessage, type UiMessage } from '../errors.js';
import { formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, uncertainResponse } from '../request.js';

/** The body of the 409 an entry answers when its files do not settle its source language. */
export interface SourceProblem {
  code: 'ENTRY_SOURCE_CONFLICT' | 'ENTRY_SOURCE_UNDECLARED' | 'ENTRY_SOURCE_MISSING';
  marks: Record<string, string>;
  files: string[];
  offered: string[];
}

let {
  problem,
  collection,
  slug,
  uiLocale = 'en',
  onchosen,
  onreload,
}: {
  problem: SourceProblem;
  collection: string;
  slug: string;
  uiLocale?: UiLocale;
  /** A source was chosen; the entry has to be read again to open. */
  onchosen: (locale: string) => void | Promise<void>;
  onreload: () => void;
} = $props();
const options = $derived(messageOptions(uiLocale));
const named = (locale: string) => formatLanguageName(locale, uiLocale);
// Undeclared and missing name one language in every marked file; that is the one to talk about.
const language = $derived(named(Object.values(problem.marks)[0] ?? ''));
// Only a language with a file that is offered can be the source; `files` holds declared ones only.
const choices = $derived(problem.files.filter((locale) => problem.offered.includes(locale)));
const text = $derived(
  problem.code === 'ENTRY_SOURCE_CONFLICT'
    ? {
        blocked: m.source_recovery_conflict_blocked({}, options),
        title: m.source_recovery_conflict_title({}, options),
        intro: m.source_recovery_conflict_intro({}, options),
      }
    : problem.code === 'ENTRY_SOURCE_UNDECLARED'
      ? {
          blocked: m.source_recovery_undeclared_blocked({}, options),
          title: m.source_recovery_undeclared_title({}, options),
          intro: m.source_recovery_undeclared_intro({ language }, options),
        }
      : {
          blocked: m.source_recovery_missing_blocked({}, options),
          title: m.source_recovery_missing_title({}, options),
          intro: m.source_recovery_missing_intro({ language }, options),
        },
);

// svelte-ignore state_referenced_locally -- the first language that can be chosen starts chosen
let chosen = $state(choices[0]);
let sending = $state(false);
let failure = $state<UiMessage>();

async function choose(event: SubmitEvent) {
  event.preventDefault();
  if (!chosen) return;
  sending = true;
  failure = undefined;
  let tab = '';
  try {
    tab = sessionStorage.getItem('handover-tab') ?? '';
  } catch {
    // Without the token only a lock this person holds elsewhere can refuse, and it says so.
  }
  const res = await fetch(`/admin/api/entries/${collection}/${slug}/source`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locale: chosen, tab }),
  });
  if (res.ok) {
    await onchosen(chosen);
    return;
  }
  sending = false;
  failure = uncertainResponse(res)
    ? { code: 'SOURCE_CHANGE_RESPONSE_LOST' }
    : await responseMessage(res, 'ENTRY_ACTION_FAILED');
}
</script>

<div class="lock-banner is-drift" role="status">{text.blocked}</div>
<div class="entry-body">
  <section class="drift source-recovery" aria-labelledby="source-recovery-h">
    <header>
      <h2 id="source-recovery-h">{text.title}</h2>
      <p>{text.intro}{#if problem.code === 'ENTRY_SOURCE_MISSING' && choices.length}{' '}{m.source_recovery_missing_choose({}, options)}{/if}</p>
    </header>
    <ul class="source-files" aria-label={m.source_recovery_files({}, options)}>
      {#each problem.files as locale (locale)}
        {@const mark = problem.marks[locale]}
        <li>
          <span class={['chip', { 'chip-missing': !mark }]} aria-hidden="true">{locale.toUpperCase()}</span>
          <span>{mark
              ? m.source_recovery_file_says({ file: named(locale), language: named(mark) }, options)
              : m.source_recovery_file_silent({ file: named(locale) }, options)}</span>
        </li>
      {/each}
    </ul>
    {#if choices.length}
      <form onsubmit={choose}>
        <fieldset disabled={sending || failure?.code === 'SOURCE_CHANGE_RESPONSE_LOST'}>
          <legend>{m.source_recovery_legend({}, options)}</legend>
          {#each choices as locale (locale)}
            <label class="choice" for="source-recovery-{locale}">
              <input type="radio" id="source-recovery-{locale}" name="source-recovery-to" value={locale} bind:group={chosen} />
              <span class="chip" aria-hidden="true">{locale.toUpperCase()}</span>
              <span>{named(locale)}</span>
            </label>
          {/each}
        </fieldset>
        <p class="hint">{m.source_recovery_hint_or({}, options)} <code>_source</code> {m.source_recovery_hint_after({}, options)}</p>
        {#if failure}
          <div class="notice notice-danger" role="alert">
            {messageText(failure, uiLocale)}
            {#if failure.code === 'SOURCE_CHANGE_RESPONSE_LOST'}
              <button class="btn-link" type="button" onclick={onreload}>{m.source_change_reload({}, options)}</button>
            {/if}
          </div>
        {/if}
        <div class="actions">
          <span class="left">{m.source_recovery_stale_note({}, options)}</span>
          <button class="btn btn-primary" type="submit" disabled={sending || failure?.code === 'SOURCE_CHANGE_RESPONSE_LOST'}>
            {sending ? m.source_change_sending({}, options) : m.source_change_confirm({ language: named(chosen ?? '') }, options)}
          </button>
        </div>
      </form>
    {:else}
      <p class="hint">{m.source_recovery_hint_before({}, options)} <code>_source</code> {m.source_recovery_hint_after({}, options)}</p>
    {/if}
  </section>
</div>
