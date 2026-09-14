<script lang="ts">
import { formatElapsedTime, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
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
  uiLocale = 'en',
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
  uiLocale?: UiLocale;
  /** A page cannot be built around a hole, so these come first. */
  problems: Problem[];
  ongo: (path: string) => void;
  /** The render follows the stored draft, never the keystrokes. */
  savedAt: number;
} = $props();
const options = $derived(messageOptions(uiLocale));

type Width = 'desktop' | 'tablet' | 'phone';
const widths = $derived([
  { value: 'desktop' as const, label: m.preview_desktop({}, options) },
  { value: 'tablet' as const, label: m.preview_tablet({}, options) },
  { value: 'phone' as const, label: m.preview_phone({}, options) },
]);
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

const ago = (since: number) => formatElapsedTime(since, now, uiLocale);

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
    ? m.preview_not_updated({ count: problems.length }, options)
    : working
      ? m.preview_updating({}, options)
      : phase === 'expired'
        ? m.preview_stopped({}, options)
        : phase === 'timeout'
          ? m.preview_timeout_status({}, options)
          : phase === 'failed'
            ? m.preview_failed_status({}, options)
            : stale
              ? m.preview_showing_saved({ ago: ago(renderedAt) }, options)
              : m.preview_updated({ ago: ago(renderedAt) }, options),
);
</script>

<aside class="pane is-preview" aria-label={m.preview_title({}, options)}>
  {#if !enabled}
    <!-- The route is injected at build, so the sentence names the developer's flag. -->
    <div class="preview-error is-quiet">
      <h3>{m.preview_disabled_title({}, options)}</h3>
      <p>{m.preview_disabled_before({}, options)} <code>PREVIEW_ENABLED</code> {m.preview_disabled_after({}, options)}</p>
    </div>
  {:else}
    <div class="preview-tools">
      <div class="seg" role="group" aria-label={m.preview_screen_width({}, options)}>
        {#each widths as of (of.value)}
          <button type="button" aria-pressed={width === of.value} onclick={() => (width = of.value)}>
            {of.label}
          </button>
        {/each}
      </div>
      {#if locales.length > 1}
        <div class="seg" role="group" aria-label={m.common_language({}, options)}>
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
        <button class="btn btn-ghost btn-sm" type="button" onclick={refresh}>{m.preview_refresh({}, options)}</button>
        <a class="btn btn-ghost btn-sm" href={previewPath(url ?? '/')} target="_blank" rel="noreferrer">{m.preview_open_new_tab({}, options)} ↗</a>
      </div>
    </div>
    {#if problems.length}
      <!-- The card stands where the frame would be, rather than a page with a hole in it. -->
      <div class="preview-error">
        <h3>{m.preview_problems_title({}, options)}</h3>
        {#each problems as problem (problem.path)}
          <p><strong>{problem.label}</strong> — {problem.message}</p>
        {/each}
        <div class="actions">
          {#each problems as problem (problem.path)}
            <button class="btn" type="button" onclick={() => ongo(problem.path)}>{m.preview_go_to({ label: problem.label }, options)}</button>
          {/each}
        </div>
      </div>
    {:else}
      {#if hidden}
        <p class="preview-banner is-hidden">{m.preview_hidden({}, options)}</p>
      {/if}
      {#if !published}
        <p class="preview-banner">{m.preview_unpublished_before({}, options)} <code>{url}</code>{m.preview_unpublished_after({}, options)}</p>
      {/if}
      {#if stale}
        <p class="preview-banner is-stale">{m.preview_stale({}, options)}</p>
      {/if}
      {#if phase === 'expired'}
        <div class="preview-error">
          <h3>{m.preview_expired_title({}, options)}</h3>
          <p>{m.preview_expired_intro({}, options)}</p>
          <div class="actions">
            <button class="btn" type="button" onclick={() => location.reload()}>{m.preview_reload_admin({}, options)}</button>
          </div>
        </div>
      {:else if phase === 'failed' || phase === 'timeout'}
        <div class="preview-error">
          <h3>{phase === 'timeout' ? m.preview_timeout_title({}, options) : m.preview_failed_title({}, options)}</h3>
          <p>{phase === 'timeout' ? m.preview_timeout_intro({}, options) : m.preview_failed_intro({}, options)}</p>
          <div class="actions">
            <button class="btn" type="button" onclick={refresh}>{m.common_try_again({}, options)}</button>
          </div>
        </div>
      {:else}
        <div class="preview-stage" class:is-updating={working}>
          <div class="preview-frame is-{width}">
            <iframe {src} title={m.preview_frame_title({}, options)} onload={loaded}></iframe>
          </div>
        </div>
      {/if}
    {/if}
  {/if}
</aside>
