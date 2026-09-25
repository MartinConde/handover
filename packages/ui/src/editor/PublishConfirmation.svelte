<script lang="ts">
import type { UiMessage } from '../errors.js';
import { messageText } from '../errors.js';
import { formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import CheckLines, { type CheckLine, verdict } from '../publishing/CheckLines.svelte';
import Modal from '../shared/Modal.svelte';
import type { PublishChoice } from './publish-choice.svelte';

let {
  title,
  many,
  choice,
  lines,
  checksFailed,
  sending,
  failed,
  uiLocale,
  returnTo,
  panel = $bindable(),
  onclose,
  onchoose,
  onretry,
  onpublish,
  pending,
}: {
  title: string;
  many: boolean;
  choice: PublishChoice;
  lines: CheckLine[];
  checksFailed: boolean;
  sending: boolean;
  failed?: UiMessage;
  uiLocale: UiLocale;
  returnTo?: HTMLButtonElement;
  panel?: HTMLElement;
  onclose: () => void;
  onchoose: (locale: string) => void;
  onretry: () => void;
  onpublish: () => void;
  pending: () => boolean;
} = $props();
const options = $derived(messageOptions(uiLocale));
const language = (locale: string) => formatLanguageName(locale, uiLocale);
const feedbackText = (message: UiMessage) => messageText(message, uiLocale);
const feedbackDetail = (message: UiMessage) =>
  message.detail ? m.common_technical_detail({ detail: message.detail }, options) : '';
const readiness = $derived(choice.readiness);
const later = $derived(choice.later);
const going = $derived(choice.going);
const notReady = $derived(choice.notReady);
const waitable = $derived(choice.waitable);
const leftOut = $derived(choice.leftOut);
const kept = $derived(choice.kept);
const unready = $derived(choice.unready);
const errors = $derived(lines.filter((c) => c.severity === 'error'));
const warnings = $derived(lines.filter((c) => c.severity === 'warn'));
</script>

<Modal
  labelledby="publish-h"
  {returnTo}
  dismissible={!sending}
  bind:panel
  onclose={onclose}
>
  <h2 id="publish-h">{m.pending_publish_entry_question({ title }, options)}</h2>
  <p>
    {m.pending_publish_entry_intro({}, options)}
  </p>
  {#if many && going.length}
    <ul class="publish-set">
      <li>
        <span class="visually-hidden">{m.check_languages({}, options)}</span>
        <span class="chips">
          {#each kept as of (of)}<span class="chip">{of.toUpperCase()}</span>{/each}
        </span>
        {kept.length === 1
          ? m.pending_language_file({ language: language(kept[0] ?? '') }, options)
          : leftOut.length
            ? m.pending_language_files_some({ count: kept.length }, options)
            : m.pending_language_files({ count: kept.length }, options)}
      </li>
      {#if leftOut.length}
        <li>
          <span class="visually-hidden">{m.check_languages({}, options)}</span>
          <span class="chips">
            {#each leftOut as of (of)}<span class="chip">{of.toUpperCase()}</span>{/each}
          </span>
          {m.pending_languages_later({ count: leftOut.length }, options)}
        </li>
      {/if}
    </ul>
  {/if}
  {#if many && notReady.length}
    <fieldset class="publish-later">
      <legend class="group-title">{m.pending_not_ready({}, options)}</legend>
      {#each notReady as of (of)}
        <div class="later-row">
          {#if waitable.includes(of)}
            <label>
              <input type="checkbox" checked={later.includes(of)} disabled={sending} onchange={() => onchoose(of)}>
              {m.pending_publish_later({ language: language(of) }, options)}
            </label>
            <span class="hint">{m.pending_language_unfinished({ count: readiness?.[of]?.problems.length ?? 0 }, options)}</span>
          {:else}
            <span>{language(of)}</span>
            <span class="hint">{readiness?.[of]?.reason === 'source'
              ? m.pending_language_kept_source({}, options)
              : readiness?.[of]?.reason === 'published'
                ? m.pending_language_kept_published({}, options)
                : m.pending_language_kept_alone({}, options)}</span>
          {/if}
        </div>
      {/each}
    </fieldset>
  {/if}
  {#if checksFailed || lines.length}
    <section class="checks" aria-labelledby="publish-checks-h">
      <h3 class="group-title" id="publish-checks-h">{m.pending_checks({}, options)}</h3>
      {#if checksFailed}
        <p class="checks-sum" role="status">
          {m.pending_entry_checks_failed({}, options)}
        </p>
        <button class="btn btn-ghost" type="button" disabled={sending} onclick={onretry}>{m.pending_checks_retry({}, options)}</button>
      {:else}
        <p class="checks-sum">{verdict(lines, uiLocale)}</p>
        <CheckLines {lines} chips={many} {uiLocale} />
      {/if}
    </section>
  {/if}
  <p class="rebuild-note">
    {m.pending_entry_publish_explanation({}, options)}
  </p>
  {#if failed}<div class="notice notice-danger" role="alert">{feedbackText(failed)}{#if feedbackDetail(failed)} {feedbackDetail(failed)}{/if}</div>{/if}
  <div class="actions">
    <button class="btn" type="button" disabled={sending} onclick={onclose}>{m.common_cancel({}, options)}</button>
    <button
      class="btn btn-primary"
      type="button"
      disabled={sending || errors.length > 0 || unready.length > 0 || pending()}
      onclick={onpublish}
    >
      {#if sending}{m.pending_publishing({}, options)}
      {:else if errors.length}{m.pending_fix_errors({ count: errors.length }, options)}
      {:else if unready.length}{unready.every((of) => waitable.includes(of))
        ? m.pending_finish_or_leave_out({ count: unready.length }, options)
        : m.pending_finish_languages({ count: unready.length }, options)}
      {:else if warnings.length}{m.pending_publish_anyway({ count: warnings.length }, options)}
      {:else}{m.pending_publish_this_entry({}, options)}{/if}
    </button>
  </div>
</Modal>
