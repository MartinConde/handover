<script lang="ts">
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
}: {
  methods: LoginMethods;
  path?: string;
  query?: string;
  onlogin: () => void;
} = $props();

// svelte-ignore state_referenced_locally -- the location is read once: reaching /admin/reset
// or coming back from a dead link is a page load, not a prop changing under the component
const params = new URLSearchParams(query);
// The token from a reset email, which /admin/reset was redirected to carrying it. Anything else
// in `error` — an expired link, a GitHub account nobody invited — is one message, below.
// svelte-ignore state_referenced_locally -- same page load
const resetToken = path === '/admin/reset' ? (params.get('token') ?? '') : '';
// Better Auth sends every refusal back here the same way — a dead link, and a GitHub account
// nobody invited — and they read the same, so the form never says which addresses exist. On a
// site with no emailed link the expired-link wording would be a lie, so it gets the plain one.
const refused = Boolean(params.get('error'));

// One message for both causes, so the form never confirms which addresses have an account.
const REFUSED = "We couldn't sign you in. Check your email and password.";

type View = 'sign-in' | 'link-sent' | 'reset-sent' | 'link-dead' | 'reset';
let view = $state<View>(
  resetToken ? 'reset' : refused && methods.emailLink ? 'link-dead' : 'sign-in',
);
let email = $state('');
let password = $state('');
let next = $state('');
let confirm = $state('');
// The mockup's email-only first state exists because "Email me a link" is the primary button.
// A site that has no link has nothing to reveal, so it opens on the password form instead.
// svelte-ignore state_referenced_locally -- a site does not gain a mailer while the page is up
let usePassword = $state(!methods.emailLink);
let reveal = $state(false);
let error = $state(refused && !methods.emailLink ? REFUSED : '');
let fieldError = $state('');
let notice = $state('');
let limited = $state(false);
let busy = $state(false);

async function post(path: string, body: unknown) {
  busy = true;
  error = '';
  fieldError = '';
  limited = false;
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  busy = false;
  // Retrying too fast is the one failure worth naming: the user did nothing wrong.
  if (res.status === 429) limited = true;
  return res;
}

async function signIn(event: SubmitEvent) {
  event.preventDefault();
  // The email-only form's one primary button is the link; the password half is revealed by
  // the secondary button beside it, or is already open on a site with no link at all.
  if (!usePassword) return sendLink();
  const res = await post('/admin/api/auth/sign-in/email', { email, password });
  if (res.ok) onlogin();
  else if (!limited) error = REFUSED;
}

async function sendLink() {
  // The answer is the same for an address that has an account and one that does not, and so is
  // what is shown: whether an email exists is not the login's to say.
  const res = await post('/admin/api/auth/sign-in/magic-link', {
    email,
    callbackURL: '/admin',
    errorCallbackURL: '/admin',
  });
  if (!limited) view = res.ok ? 'link-sent' : 'sign-in';
  if (!limited && !res.ok) error = REFUSED;
}

async function forgot() {
  const res = await post('/admin/api/auth/request-password-reset', {
    email,
    redirectTo: '/admin/reset',
  });
  if (!limited) view = res.ok ? 'reset-sent' : 'sign-in';
}

async function withGitHub() {
  const res = await post('/admin/api/auth/sign-in/social', {
    provider: 'github',
    callbackURL: '/admin',
    errorCallbackURL: '/admin',
  });
  const { url } = (await res.json().catch(() => ({}))) as { url?: string };
  if (url) location.href = url;
  else error = "We couldn't reach GitHub. Try again, or sign in with your password.";
}

async function saveNewPassword(event: SubmitEvent) {
  event.preventDefault();
  if (next.length < 12) {
    fieldError = 'Must be at least 12 characters';
    return;
  }
  if (next !== confirm) {
    fieldError = 'The two passwords are different';
    return;
  }
  const res = await post('/admin/api/auth/reset-password', {
    token: resetToken,
    newPassword: next,
  });
  if (res.ok) {
    // Better Auth mints no session on a reset — and every old one has just been revoked — so
    // this ends at the form rather than inside the admin.
    history.replaceState(null, '', '/admin');
    view = 'sign-in';
    usePassword = true;
    notice = 'Your password is saved. Sign in with it.';
  } else {
    fieldError = ((await res.json().catch(() => ({}))) as { message?: string }).message ?? REFUSED;
  }
}

function backToPassword() {
  view = 'sign-in';
  usePassword = true;
  notice = '';
}
</script>

<div class="auth-page">
  <div>
    <main class="auth-card">
      {#if view === 'link-sent' || view === 'reset-sent'}
        <div class="site">
          <span class="site-logo" aria-hidden="true">H</span>
          <h1>Check your inbox</h1>
        </div>
        <p class="lede" role="status">
          {#if view === 'link-sent'}
            We sent a sign-in link to <strong>{email}</strong>. It works once and expires in 15
            minutes.
          {:else}
            If <strong>{email}</strong> has an account, we sent it a link for setting a new
            password. It expires in an hour.
          {/if}
        </p>
        <p class="secondary">
          {#if view === 'link-sent'}
            <button class="btn-link" type="button" disabled={busy} onclick={sendLink}>Resend</button>
            ·
          {/if}
          <button class="btn-link" type="button" onclick={backToPassword}>
            Use password instead
          </button>
        </p>
      {:else if view === 'reset'}
        <div class="site">
          <span class="site-logo" aria-hidden="true">H</span>
          <h1>Set a new password</h1>
        </div>
        <form onsubmit={saveNewPassword}>
          <div class="field" class:is-invalid={fieldError}>
            <label for="new-password">New password</label>
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
              >{reveal ? 'Hide' : 'Show'}</button>
            </div>
            {#if fieldError}
              <span class="error" id="new-password-error" role="alert">{fieldError}</span>
            {:else}
              <span class="hint" id="new-password-hint">At least 12 characters</span>
            {/if}
          </div>
          <div class="field">
            <label for="confirm-password">Confirm password</label>
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
              Save password
            </button>
          </div>
        </form>
      {:else}
        <div class="site">
          <span class="site-logo" aria-hidden="true">H</span>
          <h1>{view === 'link-dead' ? 'That sign-in link has expired' : 'Handover'}</h1>
        </div>
        {#if view === 'link-dead'}
          <p class="lede" role="status">
            Links work once and last 15 minutes. Enter your email and we'll send a new one.
          </p>
        {/if}
        <form
          onsubmit={signIn}
          aria-describedby={error || limited || notice ? 'sign-in-message' : undefined}
        >
          <div class="field">
            <label for="email">Email</label>
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
              <label for="password">Password</label>
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
                >{reveal ? 'Hide' : 'Show'}</button>
              </div>
              {#if methods.emailLink}
                <span class="hint">
                  <button class="btn-link" type="button" disabled={busy || !email} onclick={forgot}>
                    Forgot password?
                  </button>
                </span>
              {/if}
            </div>
          {/if}
          {#if error}
            <div class="notice notice-danger" id="sign-in-message" role="alert">{error}</div>
          {:else if limited}
            <div class="notice notice-warn" id="sign-in-message" role="status">
              Too many attempts. Try again in a minute.
            </div>
          {:else if notice}
            <div class="notice notice-success" id="sign-in-message" role="status">{notice}</div>
          {/if}
          <div class="button-row">
            <button class="btn btn-primary btn-block" type="submit" disabled={busy || limited}>
              {#if usePassword}Sign in{:else if view === 'link-dead'}Send a new link{:else if methods.emailLink}Email me a link{:else}Use password{/if}
            </button>
            {#if methods.emailLink && !usePassword}
              <button
                class="btn btn-block"
                type="button"
                onclick={() => {
                  usePassword = true;
                  notice = '';
                }}
              >Use password</button>
            {/if}
          </div>
        </form>
        {#if methods.emailLink || methods.github}
          <p class="secondary">
            {#if methods.emailLink && usePassword}
              <button class="btn-link" type="button" disabled={busy || !email} onclick={sendLink}>
                Email me a link instead
              </button>
              {#if methods.github}·{/if}
            {/if}
            {#if methods.github}
              <button class="btn-link" type="button" disabled={busy} onclick={withGitHub}>
                Continue with GitHub
              </button>
            {/if}
          </p>
        {/if}
      {/if}
    </main>
  </div>
</div>
