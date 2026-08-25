<script lang="ts">
// Email and password only. The magic link, "Continue with GitHub" and "Forgot password?" the
// login mockup also draws all need a mailer or GitHub credentials, and land with them.
let { onlogin }: { onlogin: () => void } = $props();
let email = $state('');
let password = $state('');
let reveal = $state(false);
let error = $state('');
let limited = $state(false);
let busy = $state(false);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  error = '';
  limited = false;
  const res = await fetch('/admin/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  busy = false;
  if (res.ok) {
    onlogin();
    return;
  }
  // Retrying too fast is the one failure worth naming: the user did nothing wrong. Everything
  // else is one message for both causes, so the form never confirms which emails exist.
  if (res.status === 429) limited = true;
  else error = "We couldn't sign you in. Check your email and password.";
}
</script>

<div class="auth-page">
  <div>
    <main class="auth-card">
      <div class="site">
        <span class="site-logo" aria-hidden="true">H</span>
        <h1>Handover</h1>
      </div>
      <form onsubmit={submit} aria-describedby={error || limited ? 'sign-in-message' : undefined}>
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
        </div>
        {#if error}
          <div class="notice notice-danger" id="sign-in-message" role="alert">{error}</div>
        {:else if limited}
          <div class="notice notice-warn" id="sign-in-message" role="status">
            Too many attempts. Try again in a minute.
          </div>
        {/if}
        <div class="button-row">
          <button class="btn btn-primary btn-block" type="submit" disabled={busy || limited}>
            Sign in
          </button>
        </div>
      </form>
    </main>
  </div>
</div>
