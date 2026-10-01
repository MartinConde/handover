<script lang="ts">
import type { Snippet } from 'svelte';
import { formatPublishTime, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';

export type Build = {
  commit_sha?: string;
  state: 'building' | 'live' | 'failed';
  started_at?: number;
  live_at?: number;
  /** When the admin made the commit, which is what the counter runs from. */
  committed_at?: number;
};

// One pill for the top bar and the drawer; `children` is the shell's Revert button inside it.
let {
  build,
  uiLocale = 'en',
  children,
}: { build: Build; uiLocale?: UiLocale; children?: Snippet } = $props();
const options = $derived(messageOptions(uiLocale));

// The counter ticks in here rather than in either parent, so neither has to hold a clock for it.
let now = $state(Date.now());
$effect(() => {
  if (build.state !== 'building') return;
  const id = setInterval(() => (now = Date.now()), 1000);
  return () => clearInterval(id);
});

// ⚠️ From the commit, not the build's start: right after a publish there is no build yet.
const from = $derived(build.committed_at ?? build.started_at);
// "0m 45s", the way the mockup reads it.
const elapsed = (from: number) => {
  const total = Math.max(0, Math.round((now - from) / 1000));
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
};
</script>

<span class="pill pill-{build.state}" title={build.state === 'live' && build.live_at ? `${m.build_live_since_label({}, options)} ${formatPublishTime(build.live_at, uiLocale)}` : build.state === 'building' ? m.build_building({}, options) : build.state === 'live' ? m.build_live({}, options) : m.build_failed({}, options)}>
  <span class="dot" aria-hidden="true"></span>
  <span class="build-label">{build.state === 'building' ? m.build_building({}, options) : build.state === 'live' ? (build.live_at ? m.build_live_since_label({}, options) : m.build_live({}, options)) : m.build_failed({}, options)}</span>
  {#if build.state === 'live' && build.live_at}
    <time class="detail" datetime={new Date(build.live_at).toISOString()}>{formatPublishTime(build.live_at, uiLocale)}</time>
  {:else if build.state === 'building' && from}
    <!-- Hidden from the live region: it ticks every second and would re-announce the pill. -->
    <span class="detail" aria-hidden="true">{elapsed(from)}</span>
  {/if}
  {@render children?.()}
</span>
