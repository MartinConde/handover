<script lang="ts">
import type { UiLocale } from '@handover/core';
import { messageText, responseMessage, type UiMessage } from '../errors.js';
import { messageOptions } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, sitePath } from '../request.js';
import LanguageControl from '../shared/LanguageControl.svelte';

interface Facts {
  hasPassword: boolean;
  canChangeEmail?: boolean;
  sessions: { id: string; current: boolean; userAgent: string | null; lastUsed: number }[];
}

let {
  user,
  role,
  onname,
  query = '',
  uiLocale = 'en',
  localeBusy = false,
  localeError = false,
  onlocale = () => {},
}: {
  user: { id: string; name: string; email: string; uiLocale: UiLocale | null };
  role: 'owner' | 'editor';
  onname: () => void;
  query?: string;
  uiLocale?: UiLocale;
  localeBusy?: boolean;
  localeError?: boolean;
  onlocale?: (locale: UiLocale) => void;
} = $props();

// svelte-ignore state_referenced_locally -- the prop seeds the field; the shell reloads it on save
let name = $state(user.name);
// svelte-ignore state_referenced_locally
let email = $state(user.email);
let current = $state('');
let next = $state('');
let confirm = $state('');
let reveal = $state(false);
let passwordError = $state<UiMessage | undefined>();
// An email link that failed redirects here with Better Auth's code in `?error=`.
// svelte-ignore state_referenced_locally
const linkFailed = new URLSearchParams(query).has('error');
let notice = $state<UiMessage | undefined>(
  linkFailed ? { code: 'ACCOUNT_EMAIL_LINK_FAILED' } : undefined,
);
let noticeError = $state(linkFailed);
// Feedback sits in the card whose button caused it.
let noticeAt = $state<'name' | 'email' | 'password' | 'sessions'>(linkFailed ? 'email' : 'name');
let busy = $state(false);
let reload = $state(0);

async function facts(): Promise<Facts> {
  const res = await fetch('/admin/api/account');
  if (!res.ok) throw await responseMessage(res, 'ACCOUNT_LOAD_FAILED');
  const body = (await res.json().catch(() => undefined)) as Facts | undefined;
  if (!body || typeof body.hasPassword !== 'boolean' || !Array.isArray(body.sessions))
    throw { code: 'ACCOUNT_LOAD_FAILED' } satisfies UiMessage;
  return body;
}

function accountReadFailure(error: unknown): UiMessage {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? (error as UiMessage)
    : { code: 'ACCOUNT_LOAD_FAILED' };
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
  noticeAt = 'name';
  const res = await post('/admin/api/auth/update-user', { name });
  if (res.ok) {
    notice = { code: 'ACCOUNT_NAME_SAVED' };
    onname();
  } else {
    notice = await responseMessage(res, 'ACCOUNT_NAME_SAVE_FAILED');
    noticeError = true;
  }
}

/** Better Auth mails the current address first, or the new one when the current was never proved. */
async function changeEmail(event: SubmitEvent) {
  event.preventDefault();
  notice = undefined;
  noticeError = false;
  noticeAt = 'email';
  const res = await post('/admin/api/auth/change-email', {
    newEmail: email,
    callbackURL: sitePath('/admin/account'),
  });
  if (res.ok) notice = { code: 'ACCOUNT_EMAIL_CHANGE_SENT' };
  else {
    notice = await responseMessage(res, 'ACCOUNT_EMAIL_CHANGE_FAILED');
    noticeError = true;
  }
}

/** One form, two endpoints: setting a first password is server-only and refuses once one exists. */
async function savePassword(event: SubmitEvent, hasPassword: boolean) {
  event.preventDefault();
  notice = undefined;
  noticeError = false;
  noticeAt = 'password';
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
  noticeAt = 'sessions';
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


{#snippet feedback(at: typeof noticeAt)}
  {#if notice && noticeAt === at}
    <p
      class={['notice', { 'notice-success': !noticeError, 'notice-danger': noticeError }]}
      role={noticeError ? 'alert' : 'status'}
    >
      {messageText(notice, uiLocale)}
      {#if notice.detail}<span class="technical-detail">{m.common_technical_detail({ detail: notice.detail }, messageOptions(uiLocale))}</span>{/if}
    </p>
  {/if}
{/snippet}

<main class="main">
  <h1>{m.account_title({}, messageOptions(uiLocale))}</h1>
  {#key reload}
    {#await facts()}
      <p class="placeholder">{m.account_loading({}, messageOptions(uiLocale))}</p>
    {:then account}
      <div class="settings is-account">
        <form class="settings-card" onsubmit={saveName}>
          <div class="settings-card-body">
            <header>
              <h2>{m.account_profile({}, messageOptions(uiLocale))}</h2>
            </header>
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
              <div>
                <dt>{m.account_role({}, messageOptions(uiLocale))}</dt>
                <dd>
                  <span class="badge">{role === 'owner' ? m.account_role_owner({}, messageOptions(uiLocale)) : m.account_role_editor({}, messageOptions(uiLocale))}</span>
                  <span class="sub">{m.account_role_hint({}, messageOptions(uiLocale))}</span>
                </dd>
              </div>
            </dl>
          </div>
          <footer class="settings-card-foot">
            {@render feedback('name')}
            <button class="btn btn-primary btn-sm" type="submit" disabled={busy}>{m.account_save_name({}, messageOptions(uiLocale))}</button>
          </footer>
        </form>

        {#if account.canChangeEmail}
          <form class="settings-card" onsubmit={changeEmail}>
            <div class="settings-card-body">
              <header>
                <h2><label for="new-email">{m.account_email({}, messageOptions(uiLocale))}</label></h2>
                <p id="new-email-hint">{m.account_email_hint({}, messageOptions(uiLocale))}</p>
              </header>
              <div class="field">
                <input
                  class="input"
                  id="new-email"
                  type="email"
                  autocomplete="email"
                  aria-describedby="new-email-hint"
                  required
                  bind:value={email}
                />
              </div>
            </div>
            <footer class="settings-card-foot">
              {#if notice && noticeAt === 'email'}
                {@render feedback('email')}
              {:else}
                <p class="sub">{m.account_email_change_hint({}, messageOptions(uiLocale))}</p>
              {/if}
              <button
                class="btn btn-primary btn-sm"
                type="submit"
                disabled={busy || email.trim().toLowerCase() === user.email.toLowerCase()}
              >{m.account_change_email({}, messageOptions(uiLocale))}</button>
            </footer>
          </form>
        {:else}
          <section class="settings-card">
            <div class="settings-card-body">
              <header>
                <h2>{m.account_email({}, messageOptions(uiLocale))}</h2>
                <p>{m.account_email_hint({}, messageOptions(uiLocale))}</p>
              </header>
              <p>{user.email}</p>
            </div>
            <footer class="settings-card-foot">
              {#if notice && noticeAt === 'email'}
                {@render feedback('email')}
              {:else}
                <p class="sub">{m.account_email_unavailable({}, messageOptions(uiLocale))}</p>
              {/if}
            </footer>
          </section>
        {/if}

        <section class="settings-card">
          <div class="settings-card-body">
            <header>
              <h2>{m.account_interface_language({}, messageOptions(uiLocale))}</h2>
            </header>
            <LanguageControl locale={uiLocale} disabled={localeBusy} {onlocale} />
            {#if localeError}
              <p class="notice notice-danger" role="alert">{m.account_language_save_failed({}, messageOptions(uiLocale))}</p>
            {/if}
          </div>
        </section>

        {#if account.hasPassword}
          <form class="settings-card" onsubmit={(e) => savePassword(e, true)}>
            <div class="settings-card-body">
              <header>
                <h2>{m.account_password({}, messageOptions(uiLocale))}</h2>
              </header>
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
              <div class={['field', { 'is-invalid': passwordError }]}>
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
                    {m.auth_password_hint_length({}, messageOptions(uiLocale))}
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
            </div>
            <footer class="settings-card-foot">
              {#if notice && noticeAt === 'password'}
                {@render feedback('password')}
              {:else}
                <p class="sub">{m.account_password_change_hint({}, messageOptions(uiLocale))}</p>
              {/if}
              <button class="btn btn-primary btn-sm" type="submit" disabled={busy}>
                {m.auth_change_password({}, messageOptions(uiLocale))}
              </button>
            </footer>
          </form>
        {:else}
          <!-- Two password forms on one screen is how the wrong one gets set, so this replaces the other. -->
          <form class="settings-card is-suggested" onsubmit={(e) => savePassword(e, false)}>
            <div class="settings-card-body">
              <header>
                <h2>{m.account_email_link_used({}, messageOptions(uiLocale))}</h2>
                <p>{m.account_set_password_explanation({}, messageOptions(uiLocale))}</p>
              </header>
              <div class={['field', { 'is-invalid': passwordError }]}>
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
                  <span class="hint" id="set-new-hint">{m.auth_password_hint_length({}, messageOptions(uiLocale))}</span>
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
            </div>
            <footer class="settings-card-foot">
              {@render feedback('password')}
              <button class="btn btn-primary btn-sm" type="submit" disabled={busy}>{m.auth_set_password({}, messageOptions(uiLocale))}</button>
            </footer>
          </form>
        {/if}

        <section class="settings-card">
          <div class="settings-card-body">
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
          </div>
          <footer class="settings-card-foot">
            {@render feedback('sessions')}
            <button
              class="btn btn-sm"
              type="button"
              disabled={busy || account.sessions.length < 2}
              onclick={signOutEverywhere}
            >{m.account_sign_out_everywhere({}, messageOptions(uiLocale))}</button>
          </footer>
        </section>
      </div>
    {:catch error}
      <div class="account-read-error">
        <p class="notice notice-danger" role="alert">
          {messageText(accountReadFailure(error), uiLocale)}
          {#if accountReadFailure(error).detail}<span class="technical-detail">{m.common_technical_detail({ detail: accountReadFailure(error).detail ?? '' }, messageOptions(uiLocale))}</span>{/if}
        </p>
        <button class="btn" type="button" onclick={() => (reload += 1)}>{m.common_retry({}, messageOptions(uiLocale))}</button>
      </div>
    {/await}
  {/key}
</main>
