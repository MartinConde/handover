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

<main class="login">
  <form onsubmit={submit}>
    <h1>Handover</h1>
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password" required bind:value={password} />
    <p role="alert">{error}</p>
    <button type="submit" disabled={busy}>Log in</button>
  </form>
</main>

<style>
  .login { min-height: 100vh; display: grid; place-items: center; }
  form { display: grid; gap: 0.5rem; width: min(20rem, 90vw); }
</style>
