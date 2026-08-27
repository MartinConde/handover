<script lang="ts">
import { untrack } from 'svelte';

interface Config {
  collections: { name: string; route?: string }[];
  locales: string[];
  defaultLocale: string;
  mediaBase?: string;
  mailer: { provider: string; from?: string } | null;
  preview: boolean;
  /** Whether "Simulate conflict" is offered: it commits, so it is a developer's button. */
  dev: boolean;
}

/**
 * One of the client's own keys. Where it is *in force* and what would take over without it are
 * two different answers, and the card needs both: Remove has to say what happens before it is
 * pressed. The key itself is never here — a value that can be read back is a value that leaves
 * in a screenshot.
 */
interface Key {
  key: string;
  source: 'settings' | 'env' | 'code' | 'off';
  fallback: 'env' | 'code' | 'off';
  hint: string | null;
  updatedAt: number | null;
  by: string | null;
}

type State = 'running' | 'ok' | 'off' | 'failed';
interface Result {
  state: State;
  detail: string;
  at?: number;
}

/**
 * One card per connection, each with what it is *for* before what it is doing, because this
 * page is read by somebody who will forward it. `sends` marks the one check with a side effect:
 * it never runs on open, and its button says what pressing it does rather than "Test".
 */
const CHECKS = [
  {
    key: 'github',
    name: "Your website's code (GitHub)",
    what: 'Where published pages are written.',
    stops: 'publishing',
  },
  {
    key: 'storage',
    name: 'Images and files (R2)',
    what: 'Where uploads are stored.',
    stops: 'uploading pictures and files',
  },
  {
    key: 'email',
    name: 'Email',
    what: 'Sign-in links and invitations.',
    stops: 'sending sign-in links and invitations',
    sends: true,
  },
  {
    key: 'translation',
    name: 'Translation',
    what: 'Used by the Translate button.',
    stops: 'machine translation',
  },
  {
    key: 'build',
    name: 'Build status',
    what: 'Lets the admin say whether a publish reached the site.',
    stops: 'the build status in the top bar',
  },
  {
    key: 'database',
    name: 'Database',
    what: 'Where drafts, locks and the activity log live.',
    stops: 'editing anything at all',
  },
];

const BADGE: Record<State, { class: string; label: string }> = {
  running: { class: 'badge-info', label: 'Checking…' },
  ok: { class: 'badge-success', label: 'Working' },
  off: { class: '', label: 'Not in use' },
  failed: { class: 'badge-danger', label: 'Not working' },
};

let results = $state<Record<string, Result>>({});
let conflict = $state('');
let simulating = $state(false);
let keys = $state<Key[]>([]);
let keysError = $state('');
/** Which key is being typed in, if any. Nothing is in the browser until Save. */
let typing = $state<Key>();
let typed = $state('');
let saving = $state(false);
let keyError = $state('');
let keySaid = $state('');
let field = $state<HTMLInputElement>();
let trigger: HTMLElement | null = null;

// Every check but the one that sends something, once, when the screen opens. Untracked because
// `run` both reads and writes `results`, and an effect that did would start itself again for
// ever; Test is what runs one after that.
$effect(() => {
  untrack(() => {
    for (const check of CHECKS) if (!check.sends) void run(check.key);
    void loadKeys();
  });
});
$effect(() => {
  field?.focus();
});

async function load(): Promise<Config> {
  const res = await fetch('/admin/api/diagnostics');
  if (!res.ok) throw new Error(`Could not read this site's settings (${res.status})`);
  return res.json();
}

async function run(key: string) {
  if (results[key]?.state === 'running') return;
  results[key] = { state: 'running', detail: '' };
  const res = await fetch(`/admin/api/checks/${key}`, { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as {
    detail?: string;
    error?: string;
    off?: boolean;
    to?: string;
  };
  const at = Date.now();
  if (!res.ok) {
    results[key] = {
      state: 'failed',
      detail: body.error ?? `The check could not be run (${res.status}).`,
      at,
    };
    return;
  }
  // The test email is the older endpoint and answers with the address it went to rather than a
  // sentence, which is the whole of what there is to say about it.
  const detail = body.detail ?? (body.to ? `Sent to ${body.to}.` : '');
  results[key] = { state: body.off ? 'off' : 'ok', detail, at };
}

async function loadKeys() {
  const res = await fetch('/admin/api/settings');
  if (!res.ok) {
    keysError = `The keys you own could not be read (${res.status}).`;
    return;
  }
  keys = ((await res.json()) as { integrations: Key[] }).integrations;
  keysError = '';
}

function open(row: Key) {
  // The card's own button, so closing puts focus back where it came from, as the members
  // screen's dialogs do.
  trigger = document.activeElement as HTMLElement | null;
  typing = row;
  typed = '';
  keyError = '';
  keySaid = '';
}

function close() {
  typing = undefined;
  typed = '';
  keyError = '';
  trigger?.focus();
}

async function saveKey(event: SubmitEvent) {
  event.preventDefault();
  const row = typing;
  if (!row) return;
  saving = true;
  keyError = '';
  const res = await fetch(`/admin/api/settings/${row.key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: typed }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
  saving = false;
  // The dialog stays open on a refusal with the key still in it: what refused is nearly always
  // a typo in the value that is right there.
  if (!res.ok) {
    keyError = body.error ?? `The key was not saved (${res.status}).`;
    return;
  }
  close();
  keySaid = body.detail ?? `The ${NAMES[row.key] ?? row.key} key is stored.`;
  await loadKeys();
}

async function removeKey(row: Key) {
  const res = await fetch(`/admin/api/settings/${row.key}`, { method: 'DELETE' });
  keySaid = res.ok ? `The ${NAMES[row.key] ?? row.key} key is gone.` : '';
  if (!res.ok) keysError = `The key was not removed (${res.status}).`;
  await loadKeys();
}

async function simulate() {
  simulating = true;
  conflict = '';
  const res = await fetch('/admin/api/checks/conflict', { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as { entry?: string; error?: string };
  simulating = false;
  conflict = res.ok
    ? `Conflict made on ${body.entry}. Open Unpublished changes to resolve it, and delete that entry when you are done.`
    : (body.error ?? `Nothing was made (${res.status}).`);
}

const failing = $derived(CHECKS.filter((check) => results[check.key]?.state === 'failed'));
const consequence = $derived.by(() => {
  const [first = '', ...rest] = failing.map((check) => check.stops);
  const list = rest.length
    ? `${[first, ...rest.slice(0, -1)].join(', ')} and ${rest.at(-1)}`
    : first;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} will not work until ${failing.length === 1 ? 'it is' : 'they are'} fixed.`;
});

/** Coarse on purpose: what a result line answers is "just now, or a while ago?". */
function when(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return 'checked a moment ago';
  if (minutes < 60) return `checked ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  return `checked ${hours} hour${hours === 1 ? '' : 's'} ago`;
}

const NAMES: Record<string, string> = { deepl: 'DeepL', assist: 'Writing help (AI)' };
const KEY_BADGE: Record<Key['source'], { class: string; label: string }> = {
  settings: { class: 'badge-success', label: 'Set here' },
  env: { class: 'badge-info', label: "Coming from the site's settings" },
  code: { class: 'badge-info', label: "Your site's own code" },
  off: { class: '', label: 'Not set' },
};
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * What each card says, in the three sources plus the one where the site's own code is above
 * both of them. A removal names what takes over, because the alternative is finding out after
 * the button is pressed.
 */
function says(row: Key): string {
  if (row.source === 'code')
    return 'Your site translates with its own code, handed in by your developer, so a key here would not be used.';
  if (row.source === 'settings') {
    const who = row.updatedAt
      ? ` · set ${row.by ? `by ${row.by} ` : ''}on ${DAY.format(row.updatedAt)}`
      : '';
    const next =
      row.fallback === 'env'
        ? " Removing it falls back to the key in your site's settings."
        : row.key === 'deepl'
          ? ' Removing it hides the Translate button everywhere.'
          : ' Removing it takes the key back out.';
    return `Ends in …${row.hint}${who}.${next}`;
  }
  if (row.source === 'env')
    return "Set in your site's own settings by your developer. Setting one here would override it.";
  return row.key === 'deepl'
    ? "Nothing set here and nothing in your site's settings, so the Translate button is hidden everywhere."
    : 'Nothing set here — and there is no writing help in this version yet, so a key stored here waits for one.';
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const language = (code: string) =>
  new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
const MAILERS: Record<string, string> = {
  resend: 'Resend',
  smtp: 'SMTP',
  cloudflare: 'Cloudflare Email Sending',
  custom: "Your site's own mailer",
};
</script>

<main class="main">
  <div class="list-toolbar"><h1>Settings</h1></div>
  <p class="list-note">
    Everything on this page is read-only. The settings themselves live in your site's code
    (<code>cms.config.ts</code>) — this page shows what they came out as, and checks that what
    they point at answers.
  </p>
  {#await load()}
    <p class="placeholder">Loading…</p>
  {:then config}
    <!-- The failures can be half a page apart, so they are counted at the top — and the count
         says what stops working, because that is the half the owner can judge. -->
    {#if failing.length}
      <p class="notice notice-danger page-alert" role="status">
        <strong>
          {failing.length} check{failing.length === 1 ? ' is' : 's are'} failing.
        </strong>
        {consequence}
      </p>
    {/if}
    <div class="settings is-wide">
      <section class="settings-section" aria-labelledby="cfg">
        <header>
          <h2 id="cfg">Configuration</h2>
          <p>Changed in <code>cms.config.ts</code> by your developer, then deployed.</p>
        </header>
        <dl class="facts">
          <div>
            <dt>Collections</dt>
            <dd>
              {#each config.collections as collection, i (collection.name)}
                {#if i}<span class="sep" aria-hidden="true">·</span>{/if}
                <span>
                  {capitalise(collection.name)}
                  {#if collection.route}<span class="sub">{collection.route}</span>{/if}
                </span>
              {/each}
            </dd>
          </div>
          <div>
            <dt>Languages</dt>
            <dd>
              {#each config.locales as locale, i (locale)}
                {#if i}<span class="sep" aria-hidden="true">·</span>{/if}
                <span>
                  {language(locale)}
                  {#if locale === config.defaultLocale}<span class="badge">default</span>{/if}
                </span>
              {/each}
            </dd>
          </div>
          <div>
            <dt>Images and files</dt>
            <dd>
              {#if config.mediaBase}
                <code>{config.mediaBase}</code>
              {:else}
                Off <span class="sub">no <code>media.publicBase</code>, so uploads have nowhere to be served from</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>
              {#if config.mailer}
                {MAILERS[config.mailer.provider] ?? config.mailer.provider}
                {#if config.mailer.from}<span class="sub">from {config.mailer.from}</span>{/if}
              {:else}
                Off <span class="sub">no <code>mailer</code> block, so nobody can be emailed a sign-in link</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>Preview</dt>
            <dd>
              {#if config.preview}
                On
              {:else}
                <!-- Named rather than offered: nothing in the admin can turn this on, and a
                     switch that cannot work is worse than a sentence. -->
                Off <span class="sub">your developer switches it on by setting <code>PREVIEW_ENABLED</code> when the site is built</span>
              {/if}
            </dd>
          </div>
        </dl>
      </section>
      <section class="settings-section" aria-labelledby="conn">
        <header>
          <h2 id="conn">Connections</h2>
          <p>Each one is checked when this page opens, and again whenever you press Test.</p>
        </header>
        <ul class="check-list">
          {#each CHECKS as check (check.key)}
            {@const result = results[check.key]}
            <li class="check-card" class:is-busy={result?.state === 'running'}>
              <div class="head">
                <span class="name">{check.name}</span>
                {#if result}
                  <span class="badge {BADGE[result.state].class}">{BADGE[result.state].label}</span>
                  {#if result.at}<span class="sub">{when(result.at)}</span>{/if}
                {:else}
                  <span class="sub">not checked yet</span>
                {/if}
              </div>
              <p class="what">{check.what}</p>
              <div class="actions">
                <!-- aria-disabled and not disabled: a disabled button takes no focus, so the
                     reason it is busy is never heard. Sending twice is what it prevents. -->
                <button
                  class="btn btn-sm"
                  type="button"
                  aria-disabled={result?.state === 'running' ? 'true' : undefined}
                  onclick={() => run(check.key)}
                >
                  {check.sends ? 'Send a test email' : 'Test'}<span class="visually-hidden"> {check.name}</span>
                </button>
              </div>
              {#if result?.state === 'failed'}
                <p class="notice notice-danger result" role="status">{result.detail}</p>
              {:else if result?.detail}
                <p class="result" role="status">{result.detail}</p>
              {:else if result?.state === 'running'}
                <p class="result" role="status">Checking…</p>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
      <section class="settings-section" aria-labelledby="integ">
        <header>
          <h2 id="integ">Integrations</h2>
          <p>
            The only thing on this page you can change. Keys are stored encrypted and are never
            shown again — to check one, replace it.
          </p>
        </header>
        {#if keysError}<p class="notice notice-danger" role="alert">{keysError}</p>{/if}
        {#if keySaid}<p class="notice notice-info" role="status">{keySaid}</p>{/if}
        <ul class="check-list">
          {#each keys as row (row.key)}
            <li class="check-card">
              <div class="head">
                <span class="name">{NAMES[row.key] ?? row.key}</span>
                <span class="badge {KEY_BADGE[row.source].class}">{KEY_BADGE[row.source].label}</span>
              </div>
              <p class="what">{says(row)}</p>
              <div class="actions">
                <!-- Nothing to press where the site's own code is in charge: a control that
                     cannot change what happens is worse than none. -->
                {#if row.source === 'settings'}
                  <button class="btn btn-sm" type="button" onclick={() => open(row)}>
                    Replace<span class="visually-hidden"> the {NAMES[row.key] ?? row.key} key</span>
                  </button>
                  <button class="btn btn-ghost btn-sm" type="button" onclick={() => removeKey(row)}>
                    Remove<span class="visually-hidden"> the {NAMES[row.key] ?? row.key} key</span>
                  </button>
                {:else if row.source !== 'code'}
                  <button class="btn btn-sm" type="button" onclick={() => open(row)}>
                    {row.source === 'env' ? 'Set a key here' : 'Add a key'}<span
                      class="visually-hidden"
                    >
                      for {NAMES[row.key] ?? row.key}</span
                    >
                  </button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      </section>
      {#if config.dev}
        <section class="settings-section" aria-labelledby="dev">
          <header>
            <h2 id="dev">Developer tools</h2>
            <p>Shown because this site is running in development mode.</p>
          </header>
          <div class="actions">
            <button class="btn" type="button" disabled={simulating} onclick={simulate}>
              {simulating ? 'Making one…' : 'Simulate a conflict on a scratch file'}
            </button>
          </div>
          {#if conflict}<p class="notice notice-info" role="status">{conflict}</p>{/if}
        </section>
      {/if}
    </div>
    <!-- Inside the loaded block rather than beside <main>, where every other dialog sits,
         because whether the key is tried before it is stored is the site's language count. -->
    {#if typing}
      {@const name = NAMES[typing.key] ?? typing.key}
      {@const tried = typing.key === 'deepl' && config.locales.length > 1}
      <div class="scrim">
        <div class="dialog" role="dialog" aria-labelledby="key-h">
          <h2 id="key-h">{typing.hint ? `Replace the ${name} key` : `Add the ${name} key`}</h2>
          <form onsubmit={saveKey}>
            <p>
              The key is stored encrypted and is never shown again.
              {#if typing.hint}
                The one ending …{typing.hint} stops working as soon as this is saved.
              {/if}
            </p>
            <div class="field">
              <div class="label-row">
                <label for="key-value">{typing.hint ? `New ${name} key` : `${name} key`}</label>
              </div>
              <input
                class="input"
                id="key-value"
                type="password"
                autocomplete="off"
                bind:value={typed}
                bind:this={field}
                aria-describedby={tried ? 'key-tried' : undefined}
              />
              {#if tried}
                <p class="hint" id="key-tried">We try it against DeepL before saving it.</p>
              {/if}
            </div>
            {#if keyError}<div class="notice notice-danger" role="alert">{keyError}</div>{/if}
            <div class="actions">
              <button class="btn" type="button" onclick={close}>Cancel</button>
              <button class="btn btn-primary" type="submit" disabled={saving}>
                {saving ? 'Saving…' : tried ? 'Save and test' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      </div>
    {/if}
  {:catch error}
    <p class="notice notice-danger" role="alert">{error.message}</p>
  {/await}
</main>
