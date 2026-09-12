<script lang="ts">
import { previewPath } from '../request.js';

// Toolbar and banners sit outside the frame: a band drawn inside would read as the site's own.
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
  /** The address a new entry will get. */
  url: string;
  locale: string;
  locales: { locale: string; label: string; url: string }[];
  onlocale: (of: string) => void;
  /** Whether this build has a `/_preview` route at all. */
  enabled: boolean;
  published: boolean;
  /** The one thing the rendered page cannot say about itself. */
  hidden?: boolean;
  /** The last save did not land, so the render is behind the form. */
  stale?: boolean;
  /** A page cannot be built around a hole, so these come first. */
  problems: Problem[];
  ongo: (path: string) => void;
  /** The render follows the stored draft, never the keystrokes. */
  savedAt: number;
} = $props();

type Width = 'desktop' | 'tablet' | 'phone';
const WIDTHS: { value: Width; label: string }[] = [
  { value: 'desktop', label: 'Desktop' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'phone', label: 'Phone' },
];
let width = $state<Width>('desktop');
// Refresh must change `src`, or the same address would not be asked for again.
let refreshed = $state(0);
type RenderPhase = 'idle' | 'updating' | 'success' | 'failed' | 'expired' | 'timeout';
let phase = $state<RenderPhase>('updating');
let renderedAt = $state(0);
let now = $state(Date.now());

const requestedUrl = $derived(previewPath(url ?? '/'));
const requestedVersion = $derived(String(Math.max(savedAt, refreshed)));
const src = $derived(`${requestedUrl}?at=${requestedVersion}`);
// No render is in flight while the schema is unhappy: the frame is not on screen.
const working = $derived(phase === 'updating' && problems.length === 0);
// A render takes about a second, so the pane says it is working.
$effect(() => {
  const request = src;
  if (!enabled || problems.length) {
    phase = 'idle';
    return;
  }
  phase = 'updating';
  const timeout = setTimeout(() => {
    if (src === request && phase === 'updating') phase = 'timeout';
  }, 15_000);
  return () => clearTimeout(timeout);
});
// "Updated 2 seconds ago" has to stay true without a render behind it.
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

function refresh() {
  refreshed = Math.max(Date.now(), Number(requestedVersion) + 1);
}

function loaded(event: Event) {
  const frame = event.currentTarget;
  if (!(frame instanceof HTMLIFrameElement)) return;
  let marker: HTMLElement | null = null;
  try {
    marker =
      frame.contentDocument?.querySelector<HTMLElement>('[data-handover-preview-result]') ?? null;
  } catch {
    // The preview route is same-origin; a document that escaped it is not a successful render.
  }
  if (
    marker &&
    (marker.dataset.handoverPreviewUrl !== requestedUrl ||
      marker.dataset.handoverPreviewVersion !== requestedVersion)
  )
    return;
  if (marker?.dataset.handoverPreviewResult === 'success') {
    phase = 'success';
    renderedAt = Date.now();
    now = Date.now();
    return;
  }
  phase = marker?.dataset.handoverPreviewCode === '401' ? 'expired' : 'failed';
}
// While the schema is unhappy the count is the state, not a render that never comes back.
const status = $derived(
  problems.length
    ? `Not updated — ${problems.length} problem${problems.length === 1 ? '' : 's'}`
    : working
      ? 'Updating…'
      : phase === 'expired'
        ? 'Preview stopped — sign in again'
        : phase === 'timeout'
          ? 'Preview took too long'
          : phase === 'failed'
            ? 'Preview could not be updated'
            : stale
              ? `Showing the last saved version — ${ago(renderedAt)}`
              : `Updated ${ago(renderedAt)}`,
);
</script>

<aside class="pane is-preview" aria-label="Preview">
  {#if !enabled}
    <!-- The route is injected at build, so the sentence names the developer's flag. -->
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
        <p class="preview-status" class:is-busy={working} class:is-warn={!working && (stale || problems.length > 0 || phase === 'failed' || phase === 'expired' || phase === 'timeout')} role="status">{status}</p>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" type="button" onclick={refresh}>Refresh</button>
        <a class="btn btn-ghost btn-sm" href={previewPath(url ?? '/')} target="_blank" rel="noreferrer">Open in new tab ↗</a>
      </div>
    </div>
    {#if problems.length}
      <!-- The card stands where the frame would be, rather than a page with a hole in it. -->
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
      {#if phase === 'expired'}
        <div class="preview-error">
          <h3>Your sign-in expired</h3>
          <p>Reload the admin to sign in again. Saved changes will still be in the shared draft.</p>
          <div class="actions">
            <button class="btn" type="button" onclick={() => location.reload()}>Reload admin</button>
          </div>
        </div>
      {:else if phase === 'failed' || phase === 'timeout'}
        <div class="preview-error">
          <h3>{phase === 'timeout' ? 'The preview took too long' : "The preview couldn't be shown"}</h3>
          <p>{phase === 'timeout' ? 'The page did not finish rendering within 15 seconds.' : 'The site refused the page or could not render it.'}</p>
          <div class="actions">
            <button class="btn" type="button" onclick={refresh}>Try again</button>
          </div>
        </div>
      {:else}
        <div class="preview-stage" class:is-updating={working}>
          <div class="preview-frame is-{width}">
            <iframe {src} title="The page as the site would serve it" onload={loaded}></iframe>
          </div>
        </div>
      {/if}
    {/if}
  {/if}
</aside>
