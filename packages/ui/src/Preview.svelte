<script lang="ts">
/**
 * The page the client is editing, rendered by their own site from the draft rows, beside the
 * form. Everything inside the frame's border belongs to the site: the toolbar sits outside it
 * and the banners above it, because a band drawn inside would read as the site's own.
 *
 * The frame is an `<iframe>` on `/_preview<address>` rather than markup this pane builds, so
 * what is on screen is the page and not a drawing of it. A render is a request, so it happens
 * when the draft changes and not while somebody types.
 */
interface Problem {
  path: string;
  label: string;
  message: string;
}
let {
  url,
  locale,
  locales,
  onlocale,
  enabled,
  published,
  hidden = false,
  stale = false,
  problems,
  ongo,
  savedAt,
}: {
  /** Where the site serves this page in the language shown — the address it will get if it is new. */
  url: string;
  locale: string;
  /** The languages it can be read in and where each serves it. */
  locales: { locale: string; label: string; url: string }[];
  onlocale: (of: string) => void;
  /** This build has a `/_preview` route at all: without one there is nothing to frame. */
  enabled: boolean;
  /** The live site already serves this page; a new entry is only ever here. */
  published: boolean;
  /** Off the live site, which is the one thing the rendered page cannot say about itself. */
  hidden?: boolean;
  /** The last save did not land, so what is rendered is behind the form. */
  stale?: boolean;
  /** What the schema still wants. A page cannot be built around a hole, so these come first. */
  problems: Problem[];
  ongo: (path: string) => void;
  /** When the draft last settled. The render follows the stored draft, never the keystrokes. */
  savedAt: number;
} = $props();

type Width = 'desktop' | 'tablet' | 'phone';
const WIDTHS: { value: Width; label: string }[] = [
  { value: 'desktop', label: 'Desktop' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'phone', label: 'Phone' },
];
let width = $state<Width>('desktop');
// Pressing Refresh asks for the same address again, which an unchanged `src` would not do.
let refreshed = $state(0);
let busy = $state(true);
let renderedAt = $state(0);
let now = $state(Date.now());

const src = $derived(`/_preview${url}?at=${Math.max(savedAt, refreshed)}`);
// A render in flight — which there is none of while the schema is unhappy, since the frame is
// not on screen to load anything.
const working = $derived(busy && problems.length === 0);
// The render is a request whose answer takes about a second, so the pane says it is working:
// the ground behind the page changes and the page itself keeps its colours.
$effect(() => {
  void src;
  busy = true;
});
// "Updated 2 seconds ago" has to keep being true without a render behind it.
$effect(() => {
  const tick = setInterval(() => (now = Date.now()), 15000);
  return () => clearInterval(tick);
});

function ago(since: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}
// Nothing is being rendered while the schema is unhappy, so the count is the state and not a
// render that never comes back.
const status = $derived(
  problems.length
    ? `Not updated — ${problems.length} problem${problems.length === 1 ? '' : 's'}`
    : working
      ? 'Updating…'
      : stale
        ? `Showing the last saved version — ${ago(renderedAt)}`
        : `Updated ${ago(renderedAt)}`,
);
</script>

<aside class="pane is-preview" aria-label="Preview">
  {#if !enabled}
    <!-- The route is injected at build or not at all, so this is the developer's to change and
         the sentence names the flag they set. -->
    <div class="preview-error is-quiet">
      <h3>Preview isn't switched on for this site</h3>
      <p>
        Your developer turns it on by setting <code>PREVIEW_ENABLED</code> when the site is built.
        Until then you can still edit and publish — you just won't see the page beforehand.
      </p>
    </div>
  {:else}
    <div class="preview-tools">
      <div class="seg" role="group" aria-label="Screen width">
        {#each WIDTHS as of (of.value)}
          <button type="button" aria-pressed={width === of.value} onclick={() => (width = of.value)}>
            {of.label}
          </button>
        {/each}
      </div>
      {#if locales.length > 1}
        <div class="seg" role="group" aria-label="Language">
          {#each locales as of (of.locale)}
            <button type="button" aria-pressed={locale === of.locale} onclick={() => onlocale(of.locale)}>
              {of.locale.toUpperCase()}<span class="visually-hidden"> — {of.label}</span>
            </button>
          {/each}
        </div>
      {/if}
      <div class="preview-acts">
        <p class="preview-status" class:is-busy={working} class:is-warn={!working && (stale || problems.length > 0)} role="status">{status}</p>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" type="button" onclick={() => (refreshed = Date.now())}>Refresh</button>
        <a class="btn btn-ghost btn-sm" href="/_preview{url}" target="_blank" rel="noreferrer">Open in new tab ↗</a>
      </div>
    </div>
    {#if problems.length}
      <!-- A draft the schema refuses cannot be rendered, so the card stands where the frame
           would be rather than the page arriving with a hole in it. -->
      <div class="preview-error">
        <h3>Can't show a preview yet</h3>
        {#each problems as problem (problem.path)}
          <p><strong>{problem.label}</strong> — {problem.message}</p>
        {/each}
        <div class="actions">
          {#each problems as problem (problem.path)}
            <button class="btn" type="button" onclick={() => ongo(problem.path)}>Go to {problem.label}</button>
          {/each}
        </div>
      </div>
    {:else}
      {#if hidden}
        <p class="preview-banner is-hidden">Hidden — not on the live site.</p>
      {/if}
      {#if !published}
        <p class="preview-banner">Not published yet — previewing at <code>{url}</code>.</p>
      {/if}
      {#if stale}
        <p class="preview-banner is-stale">Not everything you have typed is saved, so this is the last version that was.</p>
      {/if}
      <div class="preview-stage" class:is-updating={working}>
        <div class="preview-frame is-{width}">
          <iframe {src} title="The page as the site would serve it" onload={() => { busy = false; renderedAt = Date.now(); now = Date.now(); }}></iframe>
        </div>
      </div>
    {/if}
  {/if}
</aside>
