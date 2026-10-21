import { request as fetch, isRecord } from './request.js';
import type { Build } from './shared/BuildPill.svelte';

type PendingEntry = {
  key: string;
  title: string;
  collection: string;
  locales: string[];
  files: string[];
  redirects?: number;
  updated_at: number;
  held_by?: { id: string; name: string | null } | null;
};

const isPendingEnvelope = (
  value: unknown,
): value is { entries?: PendingEntry[]; defaultLocale?: string } =>
  isRecord(value) &&
  (value.entries === undefined || Array.isArray(value.entries)) &&
  (value.defaultLocale === undefined || typeof value.defaultLocale === 'string');

const isBuildEnvelope = (value: unknown): value is Partial<Build> =>
  isRecord(value) &&
  (value.state === undefined ||
    value.state === 'building' ||
    value.state === 'live' ||
    value.state === 'failed');

// The drafts waiting to be published and the site's build, as the sidebar and dashboard show them.
export function createShellStatus() {
  let pending = $state<PendingEntry[]>([]);
  let defaultLocale = $state('');
  let pendingStatus = $state<'loading' | 'ready' | 'error'>('loading');
  let pendingKnown = $state(false);
  /** Entries a publish was refused over, which the drawer offers to resolve when it opens. */
  let conflicted = $state<string[]>([]);
  /** Where the site's newest commit has got to; null on a site with no build status. */
  let build = $state<Build | null>(null);
  let buildStatus = $state<'loading' | 'ready' | 'error'>('loading');
  let pendingRequest = 0;
  let buildRequest = 0;

  async function loadPending() {
    const mine = ++pendingRequest;
    pendingStatus = 'loading';
    const res = await fetch('/admin/api/drafts');
    if (mine !== pendingRequest) return;
    if (!res.ok) {
      pendingStatus = 'error';
      return;
    }
    let body: unknown;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      if (mine === pendingRequest) pendingStatus = 'error';
      return;
    }
    if (mine !== pendingRequest) return;
    if (!isPendingEnvelope(body)) {
      pendingStatus = 'error';
      return;
    }
    pending = body.entries ?? [];
    conflicted = conflicted.filter((key) => pending.some((e) => e.key === key));
    defaultLocale = body.defaultLocale ?? '';
    pendingKnown = true;
    pendingStatus = 'ready';
  }

  async function loadBuild() {
    const mine = ++buildRequest;
    buildStatus = 'loading';
    const res = await fetch('/admin/api/build');
    if (mine !== buildRequest) return;
    if (!res.ok) {
      buildStatus = 'error';
      return;
    }
    let body: unknown;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      if (mine === buildRequest) buildStatus = 'error';
      return;
    }
    if (mine !== buildRequest) return;
    if (!isBuildEnvelope(body)) {
      buildStatus = 'error';
      return;
    }
    // Without `commit_sha` nothing was published yet and the pill reports the worker's own build.
    build = body.state ? { ...body, state: body.state } : null;
    buildStatus = 'ready';
  }

  // A boolean, not the object: an effect reading `build` would be rebuilt by every poll.
  const building = $derived(build?.state === 'building');
  // A finished build does not start on its own, and the next publish loads it.
  // A publish redeploys the Worker, so this tab may be reloaded before the build finishes.
  $effect(() => {
    if (!building) return;
    const poll = setInterval(() => void loadBuild(), 10_000);
    return () => clearInterval(poll);
  });

  return {
    get pending() {
      return pending;
    },
    get defaultLocale() {
      return defaultLocale;
    },
    get pendingStatus() {
      return pendingStatus;
    },
    get pendingKnown() {
      return pendingKnown;
    },
    get conflicted() {
      return conflicted;
    },
    set conflicted(next: string[]) {
      conflicted = next;
    },
    get build() {
      return build;
    },
    get buildStatus() {
      return buildStatus;
    },
    get building() {
      return building;
    },
    loadPending,
    loadBuild,
  };
}
