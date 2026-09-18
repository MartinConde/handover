<script lang="ts">
import { onDestroy } from 'svelte';
import { messageText, responseMessage, type UiMessage } from '../errors.js';
import type { UiLocale } from '../i18n.js';
import { messageOptions } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, sitePath } from '../request.js';
import LanguageControl from '../shared/LanguageControl.svelte';

export interface LoginMethods {
  /** The site has a base URL and a mailer, so both "email me a link" and "forgot password" work. */
  emailLink: boolean;
  github: boolean;
}

let {
  methods,
  path = '/admin',
  query = '',
  onlogin,
  uiLocale = 'en',
  onlocale = () => {},
}: {
  methods: LoginMethods;
  path?: string;
  query?: string;
  onlogin: () => void;
  uiLocale?: UiLocale;
  onlocale?: (locale: UiLocale) => void;
} = $props();

// svelte-ignore state_referenced_locally -- initialized once from the page URL
const params = new URLSearchParams(query);
// svelte-ignore state_referenced_locally -- same page load
const resetToken = path === '/admin/reset' ? (params.get('token') ?? '') : '';
// With no emailed link the expired-link wording would be a lie, so it gets the plain message.
const refused = Boolean(params.get('error'));

const DEFAULT_RETRY_DELAY = 60_000;
const MAX_TIMER_DELAY = 2_147_483_647;

type View = 'sign-in' | 'link-sent' | 'reset-sent' | 'link-dead' | 'reset';
// svelte-ignore state_referenced_locally -- the login view is chosen once per page load
let view = $state<View>(
  resetToken ? 'reset' : refused && methods.emailLink ? 'link-dead' : 'sign-in',
);
let email = $state('');
let password = $state('');
let next = $state('');
let confirm = $state('');
// svelte-ignore state_referenced_locally -- a site does not gain a mailer while the page is up
let usePassword = $state(!methods.emailLink);
let reveal = $state(false);
// svelte-ignore state_referenced_locally -- the initial error is chosen once per page load
let error = $state<UiMessage | undefined>(
  refused && !methods.emailLink ? { code: 'AUTH_SIGN_IN_FAILED' } : undefined,
);
let fieldError = $state<UiMessage | undefined>();
let notice = $state(false);
let limited = $state(false);
let busy = $state(false);
let limitTimer: ReturnType<typeof setTimeout> | undefined;

function retryDelay(response: Response): number {
  const value = response.headers.get('retry-after');
  if (!value) return DEFAULT_RETRY_DELAY;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0
    ? Math.min(delay, MAX_TIMER_DELAY)
    : DEFAULT_RETRY_DELAY;
}

function clearLimit() {
  if (limitTimer !== undefined) clearTimeout(limitTimer);
  limitTimer = undefined;
  limited = false;
}

onDestroy(() => {
  if (limitTimer !== undefined) clearTimeout(limitTimer);
});

async function post(path: string, body: unknown) {
  busy = true;
  error = undefined;
  fieldError = undefined;
  clearLimit();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  busy = false;
  // Retrying too fast is the one failure worth naming: the user did nothing wrong.
  if (res.status === 429) {
    limited = true;
    limitTimer = setTimeout(clearLimit, retryDelay(res));
  }
  return res;
}

async function signIn(event: SubmitEvent) {
  event.preventDefault();
  // The email-only form's primary button is the link; the password half is revealed beside it.
  if (!usePassword) return sendLink();
  const res = await post('/admin/api/auth/sign-in/email', { email, password });
  if (res.ok) onlogin();
  else if (!limited) error = await responseMessage(res, 'AUTH_SIGN_IN_FAILED');
}

async function sendLink() {
  // The same answer whether the address has an account or not: that is not the login's to say.
  const res = await post('/admin/api/auth/sign-in/magic-link', {
    email,
    callbackURL: sitePath('/admin'),
    errorCallbackURL: sitePath('/admin'),
  });
  if (!limited) view = res.ok ? 'link-sent' : 'sign-in';
  if (!limited && !res.ok) error = await responseMessage(res, 'AUTH_SIGN_IN_FAILED');
}

async function forgot() {
  const res = await post('/admin/api/auth/request-password-reset', {
    email,
    redirectTo: sitePath('/admin/reset'),
  });
  if (!limited) {
    view = res.ok ? 'reset-sent' : 'sign-in';
    if (!res.ok) error = await responseMessage(res, 'AUTH_RESET_REQUEST_FAILED');
  }
}

async function withGitHub() {
  const res = await post('/admin/api/auth/sign-in/social', {
    provider: 'github',
    callbackURL: sitePath('/admin'),
    errorCallbackURL: sitePath('/admin'),
  });
  const { url } = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { url?: string };
  if (url) location.href = url;
  else error = await responseMessage(res, 'AUTH_GITHUB_FAILED');
}

async function saveNewPassword(event: SubmitEvent) {
  event.preventDefault();
  if (next.length < 12) {
    fieldError = { code: 'AUTH_PASSWORD_TOO_SHORT' };
    return;
  }
  if (next !== confirm) {
    fieldError = { code: 'AUTH_PASSWORDS_DIFFERENT' };
    return;
  }
  const res = await post('/admin/api/auth/reset-password', {
    token: resetToken,
    newPassword: next,
  });
  if (res.ok) {
    // Better Auth mints no session on a reset, so this ends at the form, not inside the admin.
    history.replaceState(null, '', sitePath('/admin'));
    view = 'sign-in';
    usePassword = true;
    notice = true;
  } else {
    fieldError = await responseMessage(res, 'AUTH_RESET_FAILED');
  }
}

function backToPassword() {
  view = 'sign-in';
  usePassword = true;
  notice = false;
}
</script>

<div class="auth-page">
  <div>
    <LanguageControl locale={uiLocale} {onlocale} />
    <main class="auth-card">
      {#if view === 'link-sent' || view === 'reset-sent'}
        <div class="site">
          <span class="site-logo" aria-hidden="true">H</span>
          <h1>{m.auth_check_inbox({}, messageOptions(uiLocale))}</h1>
        </div>
        <p class="lede" role="status">
          {#if view === 'link-sent'}
            {m.auth_link_sent({ email }, messageOptions(uiLocale))}
          {:else}
            {m.auth_reset_sent({ email }, messageOptions(uiLocale))}
          {/if}
        </p>
        <p class="secondary">
          {#if view === 'link-sent'}
            <button class="btn-link" type="button" disabled={busy} onclick={sendLink}>{m.auth_resend({}, messageOptions(uiLocale))}</button>
            ·
          {/if}
          <button class="btn-link" type="button" onclick={backToPassword}>
            {m.auth_use_password_instead({}, messageOptions(uiLocale))}
          </button>
        </p>
      {:else if view === 'reset'}
        <div class="site">
          <span class="site-logo" aria-hidden="true">H</span>
          <h1>{m.auth_set_new_password({}, messageOptions(uiLocale))}</h1>
        </div>
        <form onsubmit={saveNewPassword}>
          <div class={['field', { 'is-invalid': fieldError }]}>
            <label for="new-password">{m.auth_new_password({}, messageOptions(uiLocale))}</label>
            <div class="input-row">
              <input
                class="input"
                id="new-password"
                type={reveal ? 'text' : 'password'}
                autocomplete="new-password"
                minlength="12"
                aria-invalid={fieldError ? 'true' : undefined}
                aria-describedby={fieldError ? 'new-password-error' : 'new-password-hint'}
                required
                bind:value={next}
              />
              <button
                class="btn-link"
                type="button"
                aria-pressed={reveal}
                aria-controls="new-password"
                onclick={() => (reveal = !reveal)}
              >{reveal ? m.auth_hide_password({}, messageOptions(uiLocale)) : m.auth_show_password({}, messageOptions(uiLocale))}</button>
            </div>
            {#if fieldError}
              <span class="error" id="new-password-error" role="alert">{messageText(fieldError, uiLocale)}</span>
            {:else}
              <span class="hint" id="new-password-hint">{m.auth_password_hint({}, messageOptions(uiLocale))}</span>
            {/if}
          </div>
          <div class="field">
            <label for="confirm-password">{m.auth_confirm_password({}, messageOptions(uiLocale))}</label>
            <input
              class="input"
              id="confirm-password"
              type="password"
              autocomplete="new-password"
              minlength="12"
              required
              bind:value={confirm}
            />
          </div>
          <div class="button-row">
            <button class="btn btn-primary btn-block" type="submit" disabled={busy}>
              {m.auth_save_password({}, messageOptions(uiLocale))}
            </button>
          </div>
        </form>
      {:else}
        <div class="site">
          <span class="site-logo" aria-hidden="true">H</span>
          <h1>{view === 'link-dead' ? m.auth_link_expired({}, messageOptions(uiLocale)) : 'Handover'}</h1>
        </div>
        {#if view === 'link-dead'}
          <p class="lede" role="status">
            {m.auth_link_expired_hint({}, messageOptions(uiLocale))}
          </p>
        {/if}
        <form
          onsubmit={signIn}
          aria-describedby={error || limited || notice ? 'sign-in-message' : undefined}
        >
          <div class="field">
            <label for="email">{m.auth_email({}, messageOptions(uiLocale))}</label>
            <input
              class="input"
              id="email"
              type="email"
              autocomplete="username"
              inputmode="email"
              spellcheck="false"
              required
              bind:value={email}
            />
          </div>
          {#if usePassword}
            <div class="field">
              <label for="password">{m.auth_password({}, messageOptions(uiLocale))}</label>
              <div class="input-row">
                <input
                  class="input"
                  id="password"
                  type={reveal ? 'text' : 'password'}
                  autocomplete="current-password"
                  required
                  bind:value={password}
                />
                <button
                  class="btn-link"
                  type="button"
                  aria-pressed={reveal}
                  aria-controls="password"
                  onclick={() => (reveal = !reveal)}
                >{reveal ? m.auth_hide_password({}, messageOptions(uiLocale)) : m.auth_show_password({}, messageOptions(uiLocale))}</button>
              </div>
              {#if methods.emailLink}
                <span class="hint">
                  <button class="btn-link" type="button" disabled={busy || !email} onclick={forgot}>
                    {m.auth_forgot_password({}, messageOptions(uiLocale))}
                  </button>
                </span>
              {/if}
            </div>
          {/if}
          {#if error}
            <div class="notice notice-danger" id="sign-in-message" role="alert">{messageText(error, uiLocale)}</div>
          {:else if limited}
            <div class="notice notice-warn" id="sign-in-message" role="status">
              {m.auth_too_many_attempts({}, messageOptions(uiLocale))}
            </div>
          {:else if notice}
            <div class="notice notice-success" id="sign-in-message" role="status">{m.auth_password_saved({}, messageOptions(uiLocale))}</div>
          {/if}
          <div class="button-row">
            <button class="btn btn-primary btn-block" type="submit" disabled={busy || limited}>
              {#if usePassword}{m.auth_sign_in({}, messageOptions(uiLocale))}{:else if view === 'link-dead'}{m.auth_send_new_link({}, messageOptions(uiLocale))}{:else if methods.emailLink}{m.auth_email_link({}, messageOptions(uiLocale))}{:else}{m.auth_use_password({}, messageOptions(uiLocale))}{/if}
            </button>
            {#if methods.emailLink && !usePassword}
              <button
                class="btn btn-block"
                type="button"
                onclick={() => {
                  usePassword = true;
                  notice = false;
                }}
              >{m.auth_use_password({}, messageOptions(uiLocale))}</button>
            {/if}
          </div>
        </form>
        {#if methods.emailLink || methods.github}
          <p class="secondary">
            {#if methods.emailLink && usePassword}
              <button class="btn-link" type="button" disabled={busy || !email} onclick={sendLink}>
                {m.auth_email_link_instead({}, messageOptions(uiLocale))}
              </button>
              {#if methods.github}·{/if}
            {/if}
            {#if methods.github}
              <button class="btn-link" type="button" disabled={busy} onclick={withGitHub}>
                {m.auth_continue_github({}, messageOptions(uiLocale))}
              </button>
            {/if}
          </p>
        {/if}
      {/if}
    </main>
  </div>
</div>
