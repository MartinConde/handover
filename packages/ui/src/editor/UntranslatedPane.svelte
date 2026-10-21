<script lang="ts">
import type { Snippet } from 'svelte';
import { messageText, type UiMessage } from '../errors.js';
import { formatExactTime, formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import type { EditorEntry } from './entry-payload';

let {
  entry,
  locale,
  uiLocale = 'en',
  off,
  putBack,
  blocked,
  missing,
  creatingAll,
  actionFailed,
  createAllFailure,
  localeFailure,
  mobileHidden,
  heading,
  next,
  feedback,
  onfocusout,
  onrestore,
  onoffer,
  oncreate,
  oncreateall,
  onreload,
}: {
  entry: EditorEntry;
  locale: string;
  uiLocale?: UiLocale;
  off: boolean;
  putBack?: { commit_sha: string; at: number };
  blocked: boolean;
  missing: number;
  creatingAll?: string;
  actionFailed?: UiMessage;
  createAllFailure?: UiMessage;
  localeFailure?: UiMessage;
  mobileHidden: boolean;
  heading: Snippet<[string]>;
  next: Snippet;
  feedback: Snippet<[UiMessage]>;
  onfocusout: () => void;
  onrestore: () => void;
  onoffer: (on: boolean) => void;
  oncreate: (fill: boolean) => void;
  oncreateall: (fill: boolean) => void;
  onreload: () => void;
} = $props();
const options = $derived(messageOptions(uiLocale));
const language = (of: string) => formatLanguageName(of, uiLocale);
</script>

<section
  class={['pane is-locale', { 'is-mobile-hidden': mobileHidden }]}
  aria-labelledby="pane-{locale}"
  {onfocusout}
>
  <div class="pane-head"
    >{@render heading(locale)}<span class="spacer"></span>{@render next()}</div
  >
  <div class="empty">
    {#if off}
      <div class="is-wide">
        <p>{m.editor_not_offered({ language: language(locale) }, options)}</p>
        {#if putBack}
          <p>
            {m.editor_turned_off_before({}, options)}
            <time datetime={new Date(putBack.at).toISOString()}
              >{formatExactTime(putBack.at, uiLocale)}</time
            >{m.editor_turned_off_after({ language: language(locale) }, options)}
          </p>
          <button
            class="btn btn-primary"
            type="button"
            disabled={blocked}
            onclick={onrestore}
          >
            {m.editor_restore_words({ language: language(locale) }, options)}
          </button>
          <p>
            {m.editor_or({}, options)}
            <button
              class="btn-link"
              type="button"
              disabled={blocked}
              onclick={() => onoffer(true)}
              >{m.editor_restore_empty({ language: language(locale) }, options)}</button
            >.
          </p>
        {:else}
          <button
            class="btn"
            type="button"
            disabled={blocked}
            onclick={() => onoffer(true)}
          >
            {m.editor_turn_back_on({ language: language(locale) }, options)}
          </button>
        {/if}
      </div>
    {:else}
      <div class="is-wide">
        <p>{m.editor_create_translation_intro({}, options)}</p>
        <button
          class="btn btn-primary btn-create"
          type="button"
          disabled={blocked}
          onclick={() => oncreate(false)}
        >
          {m.editor_create_from({ language: language(entry.sourceLocale) }, options)}
        </button>
        {#if entry.translator}
          <button
            class="btn btn-fill"
            type="button"
            disabled={blocked}
            onclick={() => oncreate(true)}
          >
            {m.editor_create_prefill({}, options)}
          </button>
        {/if}
        {#if missing > 1}
          <p>
            <button
              class="btn btn-create-all"
              type="button"
              disabled={blocked}
              onclick={() => oncreateall(false)}
            >
              {m.editor_create_all({ count: missing }, options)}
            </button>
            {#if entry.translator}
              <button
                class="btn btn-fill-all"
                type="button"
                disabled={blocked}
                onclick={() => oncreateall(true)}
              >
                {m.editor_create_all_prefill({ count: missing }, options)}
              </button>
            {/if}
          </p>
        {/if}
        {#if creatingAll}
          <p role="status"
            >{m.editor_creating_language({ language: language(creatingAll) }, options)}</p
          >
        {/if}
        {#if !entry.singleton}
          <p>
            {m.editor_or({}, options)}
            <button
              class="btn-link"
              type="button"
              disabled={blocked}
              onclick={() => onoffer(false)}
              >{m.editor_do_not_offer({ language: language(locale) }, options)}</button
            >
            {m.editor_no_file_written({}, options)}
          </p>
        {/if}
      </div>
    {/if}
    {#if actionFailed}
      <div class="notice notice-danger" role="alert">{@render feedback(actionFailed)}</div
      >
    {/if}
    {#if createAllFailure}
      <div class="notice notice-danger" role="alert">
        {messageText(createAllFailure, uiLocale)}
        {#if createAllFailure.code === 'CREATE_ALL_RELOAD_FAILED'}
          <button class="btn-link" type="button" onclick={onreload}
            >{m.editor_lock_reload({}, options)}</button
          >
        {/if}
      </div>
    {/if}
    {#if localeFailure}
      <div class="notice notice-danger" role="alert"
        >{@render feedback(localeFailure)}</div
      >
    {/if}
  </div>
</section>
