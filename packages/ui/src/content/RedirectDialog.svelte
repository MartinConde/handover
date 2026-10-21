<script lang="ts">
import { untrack } from 'svelte';
import type { Pickable } from '../entry-directory.js';
import { messageDetail, messageText, type UiMessage } from '../errors.js';
import { messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { postJson } from '../request.js';
import Modal from '../shared/Modal.svelte';
import PagePicker from './PagePicker.svelte';
import type { Rule } from './Redirects.svelte';

let {
  rule,
  rules,
  known,
  knownCurrent,
  knownError,
  uiLocale = 'en',
  returnTo,
  onretry,
  onsaved,
  onclose,
}: {
  /** The rule being edited; nothing when adding. */
  rule?: Rule;
  rules: Rule[];
  known: Pickable;
  knownCurrent: boolean;
  knownError: boolean;
  uiLocale?: UiLocale;
  returnTo?: HTMLElement;
  onretry: () => void;
  onsaved: () => void | Promise<void>;
  onclose: () => void;
} = $props();
const options = $derived(messageOptions(uiLocale));

let writing = $state<{
  id?: string;
  from: string;
  to: string;
  status: 301 | 302;
  kind: 'page' | 'url';
}>(
  untrack(() =>
    rule
      ? {
          id: rule._id,
          from: rule.from,
          to: rule.to,
          status: rule.status,
          kind: rule.to.startsWith('/') ? 'page' : 'url',
        }
      : { from: '', to: '', status: 301, kind: 'page' },
  ),
);
let bad = $state<{ field: 'from' | 'to'; message: UiMessage }>();
let saving = $state(false);

// The destination is picked in the old address's language, since that is the reader sent on.
const toLocale = $derived(
  (known.locales ?? []).find(
    (l) => writing.from === `/${l}` || writing.from.startsWith(`/${l}/`),
  ) ??
    known.defaultLocale ??
    known.locales[0] ??
    '',
);
// A rule already pointing at the claimed address will be re-pointed, which the client should hear.
const chained = $derived(rules.find((r) => r.to === writing.from && r._id !== writing.id));

async function save() {
  saving = true;
  const res = await postJson(
    writing.id ? `/admin/api/redirects/${writing.id}` : '/admin/api/redirects',
    { from: writing.from, to: writing.to, status: writing.status },
    writing.id ? 'PUT' : 'POST',
  );
  saving = false;
  if (res.ok) {
    await onsaved();
    return;
  }
  const body = (await res.json().catch(() => ({}))) as {
    field?: string;
    message?: string;
    error?: string;
    code?: string;
    descriptor?: UiMessage;
  };
  bad =
    body.field === 'to' || body.field === 'from'
      ? {
          field: body.field,
          message: body.descriptor ?? {
            code: 'REDIRECT_SAVE_FAILED',
            status: res.status,
            ...(body.message ? { detail: body.message } : {}),
          },
        }
      : {
          field: 'from',
          message: {
            code: body.code ?? 'REDIRECT_SAVE_FAILED',
            status: res.status,
            ...(!body.code && body.error ? { detail: body.error } : {}),
          },
        };
}
</script>

<Modal
  labelledby="rd-h"
  panelClass="dialog is-wide"
  initialFocus="#rd-from"
  {returnTo}
  dismissible={!saving}
  {onclose}
>
  <h2 id="rd-h">
    {writing.id ? m.redirect_edit_title({}, options) : m.redirect_add_title({}, options)}
  </h2>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      save();
    }}
  >
    {#if knownError && writing.kind === 'page'}
      <div class="notice notice-danger redirect-directory-error" role="alert">
        {m.redirect_directory_failed({}, options)}
        <button class="btn-link" type="button" onclick={onretry}
          >{m.common_retry({}, options)}</button
        >
      </div>
    {/if}
    <div class={['field', { 'is-invalid': bad?.field === 'from' }]}>
      <div class="label-row">
        <label for="rd-from">{m.redirect_old_address({}, options)}</label>
      </div>
      <input
        class="input"
        id="rd-from"
        type="text"
        bind:value={writing.from}
        aria-invalid={bad?.field === 'from' ? 'true' : undefined}
        aria-describedby={bad?.field === 'from' ? 'rd-from-e' : 'rd-from-hint'}
      />
      {#if bad?.field === 'from'}
        <p class="error" id="rd-from-e">
          {messageText(bad.message, uiLocale)}{#if bad.message.detail}<span class="technical-detail"
              >{messageDetail(bad.message, uiLocale)}</span
            >{/if}
        </p>
      {:else}
        <p class="hint" id="rd-from-hint">
          {m.redirect_old_address_hint({}, options)}
        </p>
      {/if}
    </div>
    <fieldset>
      <legend>{m.redirect_send_to({}, options)}</legend>
      <label class="choice">
        <input type="radio" name="rd-kind" value="page" bind:group={writing.kind} />
        {m.redirect_page_destination({}, options)}
      </label>
      {#if writing.kind === 'page'}
        <PagePicker
          id="rd-pick"
          label="pages and entries"
          labelKind="pages-and-entries"
          labelId="rd-h"
          {uiLocale}
          locale={toLocale}
          chosen={known.entries.find((e) => e.urls[toLocale] === writing.to)?.path}
          onpick={(entry) => {
            writing.to = entry.urls[toLocale] ?? '';
          }}
        />
      {/if}
      <label class="choice">
        <input type="radio" name="rd-kind" value="url" bind:group={writing.kind} />
        {m.redirect_web_destination({}, options)}
      </label>
      {#if writing.kind === 'url'}
        <div class="field">
          <div class="label-row">
            <label for="rd-url">{m.redirect_web_address({}, options)}</label>
          </div>
          <input
            class="input"
            id="rd-url"
            type="text"
            placeholder="https://example.com/brochure.pdf"
            bind:value={writing.to}
            aria-invalid={bad?.field === 'to' ? 'true' : undefined}
            aria-describedby={bad?.field === 'to' ? 'rd-to-e' : undefined}
          />
        </div>
      {/if}
      <!-- A picked page is an address like any other, so the rule is shown as it will read. -->
      <p class="hint">
        {m.redirect_visitors_go_to({ destination: writing.to || '…' }, options)}
      </p>
      {#if bad?.field === 'to'}<p class="error" id="rd-to-e">
          {messageText(bad.message, uiLocale)}{#if bad.message.detail}<span class="technical-detail"
              >{messageDetail(bad.message, uiLocale)}</span
            >{/if}
        </p>{/if}
    </fieldset>
    <!-- A fieldset: a <label> naming no control is a label a screen reader drops. -->
    <fieldset>
      <legend>{m.redirect_permanence({}, options)}</legend>
      <label class="choice">
        <input type="radio" name="rd-code" value={301} bind:group={writing.status} />
        {m.redirect_permanent({}, options)} <span class="desc">301</span>
      </label>
      <label class="choice">
        <input type="radio" name="rd-code" value={302} bind:group={writing.status} />
        {m.redirect_temporary_choice({}, options)} <span class="desc">302</span>
      </label>
    </fieldset>
    {#if chained}
      <div class="notice notice-info">
        <b>{m.redirect_already_covered({}, options)}</b>
        {m.redirect_chain_explanation({ address: chained.from }, options)}
      </div>
    {/if}
    <div class="actions">
      <button class="btn" type="button" disabled={saving} onclick={onclose}
        >{m.common_cancel({}, options)}</button
      >
      <button
        class="btn btn-primary"
        type="submit"
        disabled={saving || (writing.kind === 'page' && !knownCurrent)}
      >
        {saving
          ? m.redirect_saving({}, options)
          : writing.id
            ? m.redirect_save({}, options)
            : m.redirect_add({}, options)}
      </button>
    </div>
  </form>
</Modal>
