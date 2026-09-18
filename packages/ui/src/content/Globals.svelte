<script lang="ts">
import type { Labels } from '@handover/core';
import { formatExactTime, formatRelativeTime, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, sitePath } from '../request.js';

let { uiLocale = 'en' }: { uiLocale?: UiLocale } = $props();
const options = $derived(messageOptions(uiLocale));
const named = (global: Global) => global.labels?.[uiLocale] ?? global.label;

type Global = {
  key: string;
  label: string;
  labels?: Labels;
  description?: string;
  /** The languages this global has a file in; the rest are the dashed chip. */
  locales: string[];
  pending: boolean;
  /** Who has it open right now. */
  editing?: { id: string; name: string | null };
  /** Who last touched it, and whether that edit is out on the site yet. */
  edited?: { at: number; by: string | null; kind: 'edit' | 'publish' } | null;
};

let globals = $state.raw<Global[]>([]);
// The site's languages in its own order; with one, no chips are drawn at all.
let locales = $state<string[]>([]);
let loading = $state(true);
let errorStatus = $state<number>();

$effect(() => {
  load();
});

async function load() {
  const res = await fetch('/admin/api/globals');
  if (res.ok) {
    const body = (await res.json()) as { globals: Global[]; locales: string[] };
    globals = body.globals;
    locales = body.locales;
    errorStatus = undefined;
  } else errorStatus = res.status;
  loading = false;
}
</script>

<main class="main site-settings-page">
  <div class="page-heading"><h1>{m.globals_title({}, options)}</h1>
  <p class="list-note">
    {m.globals_intro({}, options)}
  </p></div>

  {#if errorStatus}<p class="notice notice-danger" role="alert">{m.globals_load_failed({ status: errorStatus }, options)}</p>{/if}
  {#if loading}
    <p class="placeholder">{m.common_loading({}, options)}</p>
  {:else}
    {#if !globals.length}
      <p class="list-note">
        {m.globals_empty_before({}, options)} <code>src/content/globals/</code>,
        {m.globals_empty_after({}, options)} <code>globals</code> {m.globals_empty_in({}, options)} <code>cms.config.ts</code>.
      </p>
    {/if}
    <section class="settings-panel" aria-labelledby="website-content-heading">
      <header class="settings-panel-heading">
        <h2 id="website-content-heading">{m.globals_website_content({}, options)}</h2>
      </header>
    <div class="settings-list">
      {#each globals as global (global.key)}
        <div class="global-card">
          <span class="global-symbol" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              {#if global.key === 'site'}
                <circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/>
              {:else if global.key === 'navigation'}
                <path d="M9 6h11M9 12h11M9 18h7"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>
              {:else if global.key === 'newsletter'}
                <rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>
              {:else}
                <rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h4"/>
              {/if}
            </svg>
          </span>
          <h2>
            {#if global.pending}
              <span class="pdot" aria-hidden="true"></span>
              <span class="visually-hidden">{m.shell_unpublished_changes({}, options)}.</span>
            {/if}
            <a href={sitePath(`/admin/site/${global.key}`)}>{named(global)}</a>
          </h2>
          {#if global.description}<p>{global.description}</p>{/if}
          <div class="meta">
            {#if global.editing || locales.length > 1}
              <span class="meta-row">
                {#if global.editing}<span class="badge">{m.globals_being_edited_by({ name: global.editing.name || m.globals_somebody({}, options) }, options)}</span>{/if}
                {#if locales.length > 1}
                  <span class="visually-hidden">{m.globals_languages({}, options)}:</span>
                  <span class="chips">
                    {#each locales as locale (locale)}
                      <span
                        class={['chip', { 'chip-missing': !global.locales.includes(locale) }]}
                        title="{locale}: {global.locales.includes(locale)
                          ? m.globals_written({}, options)
                          : m.globals_not_written({}, options)}"
                      >{locale.toUpperCase()}</span>
                    {/each}
                  </span>
                {/if}
              </span>
            {/if}
            {#if global.edited}
              <span class="sub">
                {global.edited.kind === 'edit'
                  ? global.edited.by
                    ? m.globals_edited_by({ name: global.edited.by }, options)
                    : m.globals_edited({}, options)
                  : global.edited.by
                    ? m.globals_published_by({ name: global.edited.by }, options)
                    : m.globals_published({}, options)}{' '}<time
                  datetime={new Date(global.edited.at).toISOString()}
                  title={formatExactTime(global.edited.at, uiLocale)}>{formatRelativeTime(global.edited.at, uiLocale)}</time
                >
              </span>
            {/if}
          </div>
          <svg class="arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
        </div>
      {/each}
      <!-- Listed, not in the sidebar: to the client this is a thing the site has. -->
      <div class="global-card">
        <span class="global-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 17h5a5 5 0 0 0 5-5V6m-4 4 4-4 4 4"/></svg></span>
        <h2><a href={sitePath(`/admin/site/redirects`)}>{m.globals_redirects({}, options)}</a></h2>
        <p>{m.globals_redirects_intro({}, options)}</p>
        <div class="meta"><span class="sub">{m.globals_redirects_meta({}, options)}</span></div>
        <svg class="arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
      </div>
    </div>
    </section>
  {/if}
</main>
