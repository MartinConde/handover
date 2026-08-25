<script lang="ts">
interface Facts {
  hasPassword: boolean;
  sessions: { id: string; current: boolean; userAgent: string | null; lastUsed: number }[];
}

let {
  user,
  role,
  onname,
}: {
  user: { id: string; name: string; email: string };
  role: 'owner' | 'editor';
  onname: () => void;
} = $props();

// svelte-ignore state_referenced_locally -- the prop is what the field starts at; after that
// the field is the person's own edit and the shell reloads the session when it is saved
let name = $state(user.name);
let current = $state('');
let next = $state('');
let confirm = $state('');
let reveal = $state(false);
let passwordError = $state('');
let notice = $state('');
let busy = $state(false);
let reload = $state(0);

async function facts(): Promise<Facts> {
  const res = await fetch('/admin/api/account');
  if (!res.ok) throw new Error(`Could not load your account (${res.status})`);
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
  notice = '';
  const res = await post('/admin/api/auth/update-user', { name });
  if (res.ok) {
    notice = 'Your name is saved.';
    onname();
  } else notice = `Your name could not be saved (${res.status}).`;
}

/**
 * One form for both, because they are one thing to the person filling it in — but two
 * endpoints: Better Auth's `/change-password` asks for the old one, and setting a first
 * password is server-only and refuses outright once one exists.
 */
async function savePassword(event: SubmitEvent, hasPassword: boolean) {
  event.preventDefault();
  notice = '';
  passwordError = '';
  if (next.length < 12) {
    passwordError = 'Must be at least 12 characters';
    return;
  }
  if (next !== confirm) {
    passwordError = 'The two passwords are different';
    return;
  }
  const res = hasPassword
    ? await post('/admin/api/auth/change-password', {
        currentPassword: current,
        newPassword: next,
        // The section says so out loud: a password nobody else knows is only true if the
        // sessions opened with the old one are gone.
        revokeOtherSessions: true,
      })
    : await post('/admin/api/account/set-password', { newPassword: next });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    passwordError =
      body.error ??
      body.message ??
      (res.status === 400
        ? 'That current password is not right'
        : `Something went wrong (${res.status})`);
    return;
  }
  current = '';
  next = '';
  confirm = '';
  notice = hasPassword ? 'Your password is changed.' : 'Your password is set.';
  reload += 1;
}

async function signOutEverywhere() {
  notice = '';
  const res = await post('/admin/api/auth/revoke-other-sessions', {});
  notice = res.ok ? 'Your other devices are signed out.' : 'Those sessions could not be ended.';
  reload += 1;
}

/**
 * What the session row calls a device. Better Auth keeps the raw user-agent and nothing else,
 * so this is a guess at the two words a person recognises rather than a parser.
 */
function device(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
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
            : 'A browser';
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
  return os ? `${browser} on ${os}` : browser;
}

/** Coarse on purpose: the question a session list answers is "recently, or ages ago?". */
function when(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 2) return 'Last used just now';
  if (minutes < 60) return `Last used ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last used ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `Last used ${days} day${days === 1 ? '' : 's'} ago`;
}
</script>

<main class="main">
  <h1>Account</h1>
  {#key reload}
    {#await facts()}
      <p class="placeholder">Loading…</p>
    {:then account}
      {#if !account.hasPassword}
        <div class="suggestion">
          <div>
            <strong>You signed in with an email link.</strong>
            <p>Set a password to sign in without one. The email link keeps working either way.</p>
          </div>
          <form class="form" onsubmit={(e) => savePassword(e, false)}>
            <div class="field" class:is-invalid={passwordError}>
              <label for="set-new">New password</label>
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
                >{reveal ? 'Hide' : 'Show'}</button>
              </div>
              {#if passwordError}
                <span class="error" id="set-new-error" role="alert">{passwordError}</span>
              {:else}
                <span class="hint" id="set-new-hint">At least 12 characters. No other rules.</span>
              {/if}
            </div>
            <div class="field">
              <label for="set-confirm">Confirm password</label>
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
              <button class="btn btn-primary" type="submit" disabled={busy}>Set password</button>
            </div>
          </form>
        </div>
      {/if}
      {#if notice}
        <p class="notice notice-success" role="status">{notice}</p>
      {/if}
      <div class="settings">
        <section class="settings-section">
          <header><h2>Profile</h2></header>
          <form class="form" onsubmit={saveName}>
            <div class="field">
              <label for="display-name">Display name</label>
              <input
                class="input"
                id="display-name"
                type="text"
                autocomplete="name"
                aria-describedby="display-name-hint"
                bind:value={name}
              />
              <p class="hint" id="display-name-hint">
                Shown in the activity log, in lock banners, and against every change you publish.
              </p>
            </div>
            <dl class="facts">
              <div><dt>Email</dt><dd>{user.email}</dd></div>
              <div>
                <dt>Role</dt>
                <dd>
                  <span class="badge">{role === 'owner' ? 'Owner' : 'Editor'}</span>
                  <span class="sub">An owner changes this on the Members screen.</span>
                </dd>
              </div>
            </dl>
            <div class="actions">
              <button class="btn btn-primary" type="submit" disabled={busy}>Save name</button>
            </div>
          </form>
        </section>
        {#if account.hasPassword}
          <section class="settings-section">
            <header>
              <h2>Password</h2>
              <p>Changing it signs out your other devices.</p>
            </header>
            <form class="form" onsubmit={(e) => savePassword(e, true)}>
              <div class="field">
                <label for="current-password">Current password</label>
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
                <label for="change-new">New password</label>
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
                  >{reveal ? 'Hide' : 'Show'}</button>
                </div>
                {#if passwordError}
                  <span class="error" id="change-new-error" role="alert">{passwordError}</span>
                {:else}
                  <span class="hint" id="change-new-hint">
                    At least 12 characters. No other rules.
                  </span>
                {/if}
              </div>
              <div class="field">
                <label for="change-confirm">Confirm new password</label>
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
                  Change password
                </button>
              </div>
            </form>
          </section>
        {/if}
        <section class="settings-section">
          <header>
            <h2>Sessions</h2>
            <p>Where you are signed in. Signing out everywhere keeps this device.</p>
          </header>
          <ul class="session-list">
            {#each account.sessions as row (row.id)}
              <li class="session-item">
                <span class="where">
                  {device(row.userAgent)}
                  {#if row.current}<span class="badge badge-accent">This device</span>{/if}
                </span>
                <span class="sub">{when(row.lastUsed)}</span>
              </li>
            {/each}
          </ul>
          <div class="actions">
            <button
              class="btn"
              type="button"
              disabled={busy || account.sessions.length < 2}
              onclick={signOutEverywhere}
            >Sign out everywhere</button>
          </div>
        </section>
      </div>
    {:catch error}
      <p class="notice notice-danger" role="alert">{error.message}</p>
    {/await}
  {/key}
</main>
