<script lang="ts">
// Phase 0 password gate. Phase 3 replaces this with the real login.
let { onlogin }: { onlogin: () => void } = $props();
let password = $state('');
let error = $state('');
let busy = $state(false);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  error = '';
  const res = await fetch('/admin/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  busy = false;
  if (res.ok) onlogin();
  else error = res.status === 401 ? 'Wrong password' : `Login failed (${res.status})`;
}
</script>

<div class="auth-page">
  <div>
    <main class="auth-card">
      <div class="site">
        <span class="site-logo" aria-hidden="true">H</span>
        <h1>Handover</h1>
      </div>
      <form onsubmit={submit}>
        <div class="field">
          <label for="password">Password</label>
          <input class="input" id="password" type="password" autocomplete="current-password" required bind:value={password} />
          <p class="error" role="alert">{error}</p>
        </div>
        <button class="btn btn-primary btn-block" type="submit" disabled={busy}>Sign in</button>
      </form>
    </main>
  </div>
</div>
