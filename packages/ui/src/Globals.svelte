<script lang="ts">
type Global = {
  key: string;
  label: string;
  description?: string;
  /** The languages this global has a file in; the rest are the dashed chip. */
  locales: string[];
  pending: boolean;
  /** Who has it open right now. */
  editing?: { id: string; name: string | null };
};

let globals = $state<Global[]>([]);
// The languages the site declares, in its own order. One and no chips are drawn at all.
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

<main class="main">
  <h1>Site settings</h1>
  <p class="list-note">
    Your site's own content: the things that are the same on every page. Pages and listings live
    under Content.
  </p>
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
    <div class="global-list">
      {#each globals as global (global.key)}
        <div class="global-card">
          <h2>
            {#if global.pending}
              <span class="pdot" aria-hidden="true"></span>
              <span class="visually-hidden">Unpublished changes.</span>
            {/if}
            <a href="/admin/site/{global.key}">{global.label}</a>
          </h2>
          {#if global.description}<p>{global.description}</p>{/if}
          {#if global.editing}<span class="badge">Being edited by {global.editing.name || 'somebody'}</span>{/if}
          {#if locales.length > 1}
            <div class="meta">
              <span class="chips" aria-label="Languages">
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
            </div>
          {/if}
        </div>
      {/each}
      <!-- In the list rather than in the sidebar: to the client this is a thing the site has,
           the way the menus are, and not a different kind of thing. Every site has one, so it
           is here whether or not the dev declared any globals. -->
      <div class="global-card">
        <h2><a href="/admin/site/redirects">Redirects</a></h2>
        <p>Old addresses that forward to new ones</p>
        <div class="meta"><span class="sub">One list, no languages</span></div>
      </div>
    </div>
  {/if}
</main>
