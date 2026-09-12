<script lang="ts">
import { request as fetch, sitePath } from '../request.js';
import { EXACT, when } from '../shared/activity-line';

type Global = {
  key: string;
  label: string;
  description?: string;
  /** The languages this global has a file in; the rest are the dashed chip. */
  locales: string[];
  pending: boolean;
  /** Who has it open right now. */
  editing?: { id: string; name: string | null };
  /** Who last touched it, and whether that edit is out on the site yet. */
  edited?: { at: number; by: string | null; kind: 'edit' | 'publish' } | null;
};

let globals = $state<Global[]>([]);
// The site's languages in its own order; with one, no chips are drawn at all.
let locales = $state<string[]>([]);
let loading = $state(true);
let error = $state('');

$effect(() => {
  load();
});

async function load() {
  const res = await fetch('/admin/api/globals');
  if (res.ok) {
    const body = (await res.json()) as { globals: Global[]; locales: string[] };
    globals = body.globals;
    locales = body.locales;
  } else error = `Could not load the list (${res.status})`;
  loading = false;
}
</script>

<main class="main site-settings-page">
  <div class="page-heading"><h1>Site settings</h1>
  <p class="list-note">
    Manage the details, navigation, and content shared across your website.
  </p></div>
  <div class="section-label">Website content</div>
  {#if error}<p class="notice notice-danger" role="alert">{error}</p>{/if}
  {#if loading}
    <p class="placeholder">Loading…</p>
  {:else}
    {#if !globals.length}
      <p class="list-note">
        No site-wide content yet. Each one is a file under <code>src/content/globals/</code>,
        declared as <code>globals</code> in <code>cms.config.ts</code>.
      </p>
    {/if}
    <div class="settings-list">
      {#each globals as global (global.key)}
        <div class="global-card">
          <span class="global-symbol" aria-hidden="true">{global.label.slice(0, 1).toUpperCase()}</span>
          <h2>
            {#if global.pending}
              <span class="pdot" aria-hidden="true"></span>
              <span class="visually-hidden">Unpublished changes.</span>
            {/if}
            <a href={sitePath(`/admin/site/${global.key}`)}>{global.label}</a>
          </h2>
          {#if global.description}<p>{global.description}</p>{/if}
          <div class="meta">
            {#if global.editing || locales.length > 1}
              <span class="meta-row">
                {#if global.editing}<span class="badge">Being edited by {global.editing.name || 'somebody'}</span>{/if}
                {#if locales.length > 1}
                  <span class="visually-hidden">Languages:</span>
                  <span class="chips">
                    {#each locales as locale (locale)}
                      <span
                        class="chip"
                        class:chip-missing={!global.locales.includes(locale)}
                        title="{locale}: {global.locales.includes(locale)
                          ? 'written'
                          : 'not written yet'}"
                      >{locale.toUpperCase()}</span>
                    {/each}
                  </span>
                {/if}
              </span>
            {/if}
            {#if global.edited}
              <span class="sub">
                {global.edited.kind === 'edit'
                  ? 'Edited'
                  : 'Published'}{#if global.edited.by}{` by ${global.edited.by}`}{/if}{' '}<time
                  datetime={new Date(global.edited.at).toISOString()}
                  title={EXACT.format(global.edited.at)}>{when(global.edited.at).toLowerCase()}</time
                >
              </span>
            {/if}
          </div>
          <svg class="arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
        </div>
      {/each}
      <!-- Listed, not in the sidebar: to the client this is a thing the site has. -->
      <div class="global-card">
        <span class="global-symbol" aria-hidden="true">↗</span>
        <h2><a href={sitePath(`/admin/site/redirects`)}>Redirects</a></h2>
        <p>Old addresses that forward to new ones</p>
        <div class="meta"><span class="sub">One list, no languages</span></div>
        <svg class="arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
      </div>
    </div>
  {/if}
</main>
