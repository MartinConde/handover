<script lang="ts">
import type { UiLocale } from '@handover/core';
import { messageText, responseMessage, type UiMessage } from '../errors.js';
import { messageOptions } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch } from '../request.js';
import LanguageControl from '../shared/LanguageControl.svelte';

interface Facts {
  hasPassword: boolean;
  sessions: { id: string; current: boolean; userAgent: string | null; lastUsed: number }[];
}

let {
  user,
  role,
  onname,
  uiLocale = 'en',
  localeBusy = false,
  localeError = false,
  onlocale = () => {},
}: {
  user: { id: string; name: string; email: string; uiLocale: UiLocale | null };
  role: 'owner' | 'editor';
  onname: () => void;
  uiLocale?: UiLocale;
  localeBusy?: boolean;
  localeError?: boolean;
  onlocale?: (locale: UiLocale) => void;
} = $props();

// svelte-ignore state_referenced_locally -- the prop seeds the field; the shell reloads it on save
let name = $state(user.name);
let current = $state('');
let next = $state('');
let confirm = $state('');
let reveal = $state(false);
let passwordError = $state<UiMessage | undefined>();
let notice = $state<UiMessage | undefined>();
let noticeError = $state(false);
let busy = $state(false);
let reload = $state(0);

async function facts(): Promise<Facts> {
  const res = await fetch('/admin/api/account');
  if (!res.ok) throw new Error('ACCOUNT_LOAD_FAILED');
  return res.json();
}

async function post(path: string, body: unknown) {
  busy = true;
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  busy = false;
  return res;
}

async function saveName(event: SubmitEvent) {
  event.preventDefault();
  notice = undefined;
  noticeError = false;
  const res = await post('/admin/api/auth/update-user', { name });
  if (res.ok) {
    notice = { code: 'ACCOUNT_NAME_SAVED' };
    onname();
  } else {
    notice = await responseMessage(res, 'ACCOUNT_NAME_SAVE_FAILED');
    noticeError = true;
  }
}

/** One form, two endpoints: setting a first password is server-only and refuses once one exists. */
async function savePassword(event: SubmitEvent, hasPassword: boolean) {
  event.preventDefault();
  notice = undefined;
  noticeError = false;
  passwordError = undefined;
  if (next.length < 12) {
    passwordError = { code: 'AUTH_PASSWORD_TOO_SHORT' };
    return;
  }
  if (next !== confirm) {
    passwordError = { code: 'AUTH_PASSWORDS_DIFFERENT' };
    return;
  }
  const res = hasPassword
    ? await post('/admin/api/auth/change-password', {
        currentPassword: current,
        newPassword: next,
        // Sessions opened with the old password must go, or "nobody else knows it" is false.
        revokeOtherSessions: true,
      })
    : await post('/admin/api/account/set-password', { newPassword: next });
  if (!res.ok) {
    passwordError = await responseMessage(res, 'ACCOUNT_PASSWORD_FAILED');
    return;
  }
  current = '';
  next = '';
  confirm = '';
  notice = { code: hasPassword ? 'ACCOUNT_PASSWORD_CHANGED' : 'ACCOUNT_PASSWORD_SET' };
  reload += 1;
}

async function signOutEverywhere() {
  notice = undefined;
  noticeError = false;
  const res = await post('/admin/api/auth/revoke-other-sessions', {});
  notice = res.ok
    ? { code: 'ACCOUNT_SESSIONS_ENDED' }
    : await responseMessage(res, 'ACCOUNT_SESSIONS_END_FAILED');
  noticeError = !res.ok;
  reload += 1;
}

/** A guess at the two words a person recognises, not a parser. */
function device(userAgent: string | null, locale: UiLocale): string {
  if (!userAgent) return m.account_unknown_device({}, messageOptions(locale));
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\/|Opera/.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : m.account_browser({}, messageOptions(locale));
  const os = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Windows/.test(userAgent)
            ? 'Windows'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : '';
  return os ? m.account_device_on({ browser, os }, messageOptions(locale)) : browser;
}

/** Coarse on purpose: the question a session list answers is "recently, or ages ago?". */
function when(at: number, locale: UiLocale): string {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 2) return m.account_last_used_now({}, messageOptions(locale));
  if (minutes < 60) return m.account_last_used_minutes({ count: minutes }, messageOptions(locale));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return m.account_last_used_hours({ count: hours }, messageOptions(locale));
  const days = Math.floor(hours / 24);
  return m.account_last_used_days({ count: days }, messageOptions(locale));
}
</script>

<main class="main">
  <h1>{m.account_title({}, messageOptions(uiLocale))}</h1>
  {#key reload}
    {#await facts()}
      <p class="placeholder">{m.account_loading({}, messageOptions(uiLocale))}</p>
    {:then account}
      {#if !account.hasPassword}
        <div class="suggestion">
          <div>
            <strong>{m.account_email_link_used({}, messageOptions(uiLocale))}</strong>
            <p>{m.account_set_password_explanation({}, messageOptions(uiLocale))}</p>
          </div>
          <form class="form" onsubmit={(e) => savePassword(e, false)}>
            <div class="field" class:is-invalid={passwordError}>
              <label for="set-new">{m.auth_new_password({}, messageOptions(uiLocale))}</label>
              <div class="input-row">
                <input
                  class="input"
                  id="set-new"
                  type={reveal ? 'text' : 'password'}
                  autocomplete="new-password"
                  minlength="12"
                  aria-invalid={passwordError ? 'true' : undefined}
                  aria-describedby={passwordError ? 'set-new-error' : 'set-new-hint'}
                  required
                  bind:value={next}
                />
                <button
                  class="btn-link"
                  type="button"
                  aria-pressed={reveal}
                  aria-controls="set-new"
                  onclick={() => (reveal = !reveal)}
                >{reveal ? m.auth_hide_password({}, messageOptions(uiLocale)) : m.auth_show_password({}, messageOptions(uiLocale))}</button>
              </div>
              {#if passwordError}
                <span class="error" id="set-new-error" role="alert">
                  {messageText(passwordError, uiLocale)}
                  {#if passwordError.detail}<span class="technical-detail">{m.common_technical_detail({ detail: passwordError.detail }, messageOptions(uiLocale))}</span>{/if}
                </span>
              {:else}
                <span class="hint" id="set-new-hint">{m.auth_password_hint_no_other_rules({}, messageOptions(uiLocale))}</span>
              {/if}
            </div>
            <div class="field">
              <label for="set-confirm">{m.auth_confirm_password({}, messageOptions(uiLocale))}</label>
              <input
                class="input"
                id="set-confirm"
                type="password"
                autocomplete="new-password"
                minlength="12"
                required
                bind:value={confirm}
              />
            </div>
            <div class="actions">
              <button class="btn btn-primary" type="submit" disabled={busy}>{m.auth_set_password({}, messageOptions(uiLocale))}</button>
            </div>
          </form>
        </div>
      {/if}
      {#if notice}
        <p
          class="notice"
          class:notice-success={!noticeError}
          class:notice-danger={noticeError}
          role={noticeError ? 'alert' : 'status'}
        >
          {messageText(notice, uiLocale)}
          {#if notice.detail}<span class="technical-detail">{m.common_technical_detail({ detail: notice.detail }, messageOptions(uiLocale))}</span>{/if}
        </p>
      {/if}
      <div class="settings">
        <section class="settings-section">
          <header><h2>{m.account_interface_language({}, messageOptions(uiLocale))}</h2></header>
          <LanguageControl locale={uiLocale} disabled={localeBusy} {onlocale} />
          {#if localeError}
            <p class="notice notice-danger" role="alert">{m.account_language_save_failed({}, messageOptions(uiLocale))}</p>
          {/if}
        </section>
        <section class="settings-section">
          <header><h2>{m.account_profile({}, messageOptions(uiLocale))}</h2></header>
          <form class="form" onsubmit={saveName}>
            <div class="field">
              <label for="display-name">{m.account_display_name({}, messageOptions(uiLocale))}</label>
              <input
                class="input"
                id="display-name"
                type="text"
                autocomplete="name"
                aria-describedby="display-name-hint"
                bind:value={name}
              />
              <p class="hint" id="display-name-hint">
                {m.account_display_name_hint({}, messageOptions(uiLocale))}
              </p>
            </div>
            <dl class="facts">
              <div><dt>{m.account_email({}, messageOptions(uiLocale))}</dt><dd>{user.email}</dd></div>
              <div>
                <dt>{m.account_role({}, messageOptions(uiLocale))}</dt>
                <dd>
                  <span class="badge">{role === 'owner' ? m.account_role_owner({}, messageOptions(uiLocale)) : m.account_role_editor({}, messageOptions(uiLocale))}</span>
                  <span class="sub">{m.account_role_hint({}, messageOptions(uiLocale))}</span>
                </dd>
              </div>
            </dl>
            <div class="actions">
              <button class="btn btn-primary" type="submit" disabled={busy}>{m.account_save_name({}, messageOptions(uiLocale))}</button>
            </div>
          </form>
        </section>
        {#if account.hasPassword}
          <section class="settings-section">
            <header>
              <h2>{m.account_password({}, messageOptions(uiLocale))}</h2>
              <p>{m.account_password_change_hint({}, messageOptions(uiLocale))}</p>
            </header>
            <form class="form" onsubmit={(e) => savePassword(e, true)}>
              <div class="field">
                <label for="current-password">{m.auth_current_password({}, messageOptions(uiLocale))}</label>
                <input
                  class="input"
                  id="current-password"
                  type="password"
                  autocomplete="current-password"
                  required
                  bind:value={current}
                />
              </div>
              <div class="field" class:is-invalid={passwordError}>
                <label for="change-new">{m.auth_new_password({}, messageOptions(uiLocale))}</label>
                <div class="input-row">
                  <input
                    class="input"
                    id="change-new"
                    type={reveal ? 'text' : 'password'}
                    autocomplete="new-password"
                    minlength="12"
                    aria-invalid={passwordError ? 'true' : undefined}
                    aria-describedby={passwordError ? 'change-new-error' : 'change-new-hint'}
                    required
                    bind:value={next}
                  />
                  <button
                    class="btn-link"
                    type="button"
                    aria-pressed={reveal}
                    aria-controls="change-new"
                    onclick={() => (reveal = !reveal)}
                  >{reveal ? m.auth_hide_password({}, messageOptions(uiLocale)) : m.auth_show_password({}, messageOptions(uiLocale))}</button>
                </div>
                {#if passwordError}
                  <span class="error" id="change-new-error" role="alert">
                    {messageText(passwordError, uiLocale)}
                    {#if passwordError.detail}<span class="technical-detail">{m.common_technical_detail({ detail: passwordError.detail }, messageOptions(uiLocale))}</span>{/if}
                  </span>
                {:else}
                  <span class="hint" id="change-new-hint">
                    {m.auth_password_hint_no_other_rules({}, messageOptions(uiLocale))}
                  </span>
                {/if}
              </div>
              <div class="field">
                <label for="change-confirm">{m.auth_confirm_new_password({}, messageOptions(uiLocale))}</label>
                <input
                  class="input"
                  id="change-confirm"
                  type="password"
                  autocomplete="new-password"
                  minlength="12"
                  required
                  bind:value={confirm}
                />
              </div>
              <div class="actions">
                <button class="btn btn-primary" type="submit" disabled={busy}>
                  {m.auth_change_password({}, messageOptions(uiLocale))}
                </button>
              </div>
            </form>
          </section>
        {/if}
        <section class="settings-section">
          <header>
            <h2>{m.account_sessions({}, messageOptions(uiLocale))}</h2>
            <p>{m.account_sessions_hint({}, messageOptions(uiLocale))}</p>
          </header>
          <ul class="session-list">
            {#each account.sessions as row (row.id)}
              <li class="session-item">
                <span class="where">
                  {device(row.userAgent, uiLocale)}
                  {#if row.current}<span class="badge badge-accent">{m.account_this_device({}, messageOptions(uiLocale))}</span>{/if}
                </span>
                <span class="sub">{when(row.lastUsed, uiLocale)}</span>
              </li>
            {/each}
          </ul>
          <div class="actions">
            <button
              class="btn"
              type="button"
              disabled={busy || account.sessions.length < 2}
              onclick={signOutEverywhere}
            >{m.account_sign_out_everywhere({}, messageOptions(uiLocale))}</button>
          </div>
        </section>
      </div>
    {:catch error}
      <div class="account-read-error">
        <p class="notice notice-danger" role="alert">{messageText({ code: error.message }, uiLocale)}</p>
        <button class="btn" type="button" onclick={() => (reload += 1)}>{m.common_retry({}, messageOptions(uiLocale))}</button>
      </div>
    {/await}
  {/key}
</main>
