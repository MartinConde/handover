<script lang="ts">
import type { Snippet } from 'svelte';

export type Build = {
  commit_sha?: string;
  state: 'building' | 'live' | 'failed';
  started_at?: number;
  live_at?: number;
  /** When the admin made the commit, which is what the counter runs from. */
  committed_at?: number;
};

// One pill for the top bar and the drawer; `children` is the shell's Revert button inside it.
let { build, children }: { build: Build; children?: Snippet } = $props();

const LABEL = { building: 'Building…', live: 'Live', failed: 'Build failed' } as const;

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
// "Live since 14:02" — when the site last changed, which is more use than that it is up.
const since = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
</script>

<span class="pill pill-{build.state}">
  <span class="dot" aria-hidden="true"></span>
  {LABEL[build.state]}
  {#if build.state === 'live' && build.live_at}
    <span class="detail">since {since(build.live_at)}</span>
  {:else if build.state === 'building' && from}
    <!-- Hidden from the live region: it ticks every second and would re-announce the pill. -->
    <span class="detail" aria-hidden="true">{elapsed(from)}</span>
  {/if}
  {@render children?.()}
</span>
