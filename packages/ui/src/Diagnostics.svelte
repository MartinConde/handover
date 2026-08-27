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

// Every check but the one that sends something, once, when the screen opens. Untracked because
// `run` both reads and writes `results`, and an effect that did would start itself again for
// ever; Test is what runs one after that.
$effect(() => {
  untrack(() => {
    for (const check of CHECKS) if (!check.sends) void run(check.key);
  });
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
  {:catch error}
    <p class="notice notice-danger" role="alert">{error.message}</p>
  {/await}
</main>
