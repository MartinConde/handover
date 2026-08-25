<script lang="ts">
type File = {
  path: string;
  updated_at: number;
  /** Somebody marked this file's entry "Not ready yet"; null where nobody has. */
  held_by?: { id: string; name: string | null } | null;
};
let {
  files,
  onclose,
  onpublished,
  ondiscarded,
}: {
  files: File[];
  onclose: () => void;
  onpublished: () => void;
  /** A draft was thrown away: the entry behind it has to be read from the repository again. */
  ondiscarded: () => void;
} = $props();

// The shell behind the drawer goes inert, so focus has to come with it or be lost — and the
// confirmation takes it in turn, giving it back when it closes.
let panel = $state<HTMLElement>();
let confirmPanel = $state<HTMLElement>();
$effect(() => (confirmPanel ?? panel)?.focus());

let busy = $state(false);
let error = $state('');
let published = $state(0);
/** Paths the last publish was refused over; each one is offered the way out. */
let conflicts = $state<string[]>([]);
/** Paths whose stored file is not everything their schema needs; the entry is where they get fixed. */
let unready = $state<string[]>([]);
/** Paths whose entry's languages disagree about its structure; nothing here can settle that. */
let drifted = $state<string[]>([]);
/** The path whose discard is waiting to be confirmed, and whether it is being thrown away. */
let confirming = $state('');
let discarding = $state(false);

const collectionOf = (path: string) => path.replace('src/content/', '').split('/')[0] ?? '';
const slugOf = (path: string) => path.replace(/^.*\//, '').replace(/\.yaml$/, '');
const named = (path: string) => path.replace('src/content/', '');
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, what: string) => `${n} ${n === 1 ? what.replace(/s$/, '') : what}`;

// What this publish would commit, and what it would leave behind. A held entry is somebody
// else's promise not to ship half a page, so it is listed rather than quietly missing.
const ready = $derived(files.filter((f) => !f.held_by));
const held = $derived(files.filter((f) => f.held_by));

// "2 pages · 1 listing · 1 on hold" — the collections behind the paths, in the order they
// first appear.
const summary = $derived(
  [
    ...[...new Set(files.map((f) => collectionOf(f.path)))].map((c) =>
      plural(files.filter((f) => collectionOf(f.path) === c).length, c),
    ),
    ...(held.length ? [`${held.length} on hold`] : []),
  ].join(' · '),
);

// What a refusal says. A conflict names its files, and those rows carry the rest of it; a
// branch that moved names none, and saying so in the server's words beats guessing.
const refusal = (body: string, paths: string[]) => {
  if (!paths.length) return `Nothing was published. ${body}`;
  const [what, them] = paths.length === 1 ? ['One file', 'it'] : [`${paths.length} files`, 'them'];
  return `Nothing was published. ${what} changed in the repository after you opened ${them}. Discard your changes to ${them} to take what is there now.`;
};

// The other refusal: nothing was taken from anyone, the file simply is not finished. Unlike a
// conflict, coming back and pressing again can work — so the button stays live, and the way out
// for a field with no editor yet is named, because filling it in is not one.
const incomplete = (paths: string[]) =>
  paths.length === 1
    ? 'Nothing was published. One file is not finished — open it to see what is missing. Delete the entry if it cannot be filled in yet.'
    : `Nothing was published. ${paths.length} files are not finished — open them to see what is missing. Delete the entries that cannot be filled in yet.`;

// And the third: the entry's own files disagree about which blocks it has. Nothing was taken
// from anyone and no draft is stale, so Discard is not the way out — the files themselves are.
const adrift = (paths: string[]) =>
  paths.length === 1
    ? 'Nothing was published. One file belongs to an entry whose languages disagree about which blocks it has — the files have to agree before it can go out.'
    : `Nothing was published. ${paths.length} files belong to entries whose languages disagree about which blocks they have — the files have to agree before they can go out.`;

async function publish() {
  busy = true;
  error = '';
  unready = [];
  drifted = [];
  const res = await fetch('/admin/api/publish', { method: 'POST' });
  busy = false;
  if (res.ok) {
    published = ((await res.json()) as { paths: string[] }).paths.length;
    onpublished();
    return;
  }
  if (res.status === 422) {
    unready = ((await res.json()) as { paths: string[] }).paths;
    error = incomplete(unready);
    return;
  }
  // A repository the App cannot reach is the server's own sentence; nothing else adds to it.
  if (res.status === 503) {
    error = await res.text();
    return;
  }
  if (res.status !== 409) {
    error = `Publish failed (${res.status}). Nothing was changed.`;
    return;
  }
  // A conflict answers with JSON, drift with JSON that says which one it is, a ref that moved
  // with a sentence; all three are 409.
  const body = await res.text();
  const parsed = JSON.parse(body.startsWith('{') ? body : '{}') as {
    paths?: string[];
    reason?: string;
  };
  if (parsed.reason === 'drift') {
    drifted = parsed.paths ?? [];
    error = adrift(drifted);
    return;
  }
  conflicts = parsed.paths ?? [];
  error = refusal(body, conflicts);
}

// Take theirs, whole: the row is gone from the drawer and the entry reads the repository
// again. Choosing field by field is the three-way view, which is not built yet.
async function discard() {
  const path = confirming;
  discarding = true;
  const res = await fetch(`/admin/api/drafts/${collectionOf(path)}/${slugOf(path)}`, {
    method: 'DELETE',
  });
  discarding = false;
  confirming = '';
  if (!res.ok) {
    error = `Those changes were not discarded (${res.status}).`;
    return;
  }
  conflicts = conflicts.filter((p) => p !== path);
  // The refusal is about the files still in it, so it is written again rather than kept.
  error = conflicts.length ? refusal('', conflicts) : '';
  ondiscarded();
}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (confirming ? (confirming = '') : onclose())} />

{#snippet change(file: File)}
  <li>
    <div class="change-row" class:is-held={file.held_by} class:is-blocked={conflicts.includes(file.path) || unready.includes(file.path) || drifted.includes(file.path)}>
      <span class="lead" aria-hidden="true"><span class="pdot"></span></span>
      <div class="change-title">
        <span class="name filename">{named(file.path)}</span>
        <span class="badge">{capitalise(collectionOf(file.path))}</span>
        {#if file.held_by}
          <span class="badge badge-warn">On hold · {file.held_by.name || 'somebody'}</span>
        {:else if conflicts.includes(file.path)}
          <span class="badge badge-danger">Changed in the repository since you opened it</span>
        {:else if unready.includes(file.path)}
          <span class="badge badge-danger">Not ready to publish</span>
        {:else if drifted.includes(file.path)}
          <span class="badge badge-danger">Languages disagree</span>
        {/if}
      </div>
      <div class="change-sub">Edited {new Date(file.updated_at).toLocaleString()}</div>
      {#if conflicts.includes(file.path)}
        <div class="change-actions">
          <button
            class="btn btn-sm"
            type="button"
            disabled={busy || discarding}
            onclick={() => (confirming = file.path)}
          >Discard<span class="visually-hidden"> your changes to {named(file.path)}</span></button>
        </div>
      {/if}
    </div>
  </li>
{/snippet}

<div class="scrim is-right">
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <aside
    class="drawer"
    role="dialog"
    aria-modal="true"
    aria-labelledby="pending-h"
    tabindex="-1"
    bind:this={panel}
  >
    <header class="drawer-head">
      <div class="head-row">
        <h2 id="pending-h">Unpublished changes</h2>
        <button class="btn btn-ghost btn-icon" type="button" aria-label="Close" onclick={onclose}>✕</button>
      </div>
      {#if files.length}
        <p class="drawer-meta"><span class="count">{plural(files.length, 'files')}</span></p>
        <p class="drawer-meta is-summary">{summary}</p>
      {:else}
        <p class="drawer-meta">Nothing to publish</p>
      {/if}
    </header>
    <div class="drawer-body">
      {#if files.length}
        <!-- A publish that left a hold behind does not empty the drawer, so the empty state below
             is not where the commit gets named. Neutral, not green: the commit landed, the site
             has not. -->
        {#if published}
          <div class="publish-result">
            <h3>Published {plural(published, 'files')}</h3>
            <p>One commit is on its way; the site rebuilds in a minute or two.</p>
          </div>
        {/if}
        <ul class="change-list">
          {#each ready as file (file.path)}{@render change(file)}{/each}
        </ul>
        {#if held.length}
          <div class="change-group">
            <h3 class="group-title">{published ? 'Still on hold' : 'On hold'}</h3>
            <ul class="change-list">
              {#each held as file (file.path)}{@render change(file)}{/each}
            </ul>
            <p class="foot-note">
              Whoever is editing these says they are not ready. Publishing goes ahead without them;
              they go out once the hold comes off in the entry.
            </p>
          </div>
        {/if}
      {:else}
        <div class="empty">
          <div>
            <h2>{published ? `Published ${plural(published, 'files')}` : 'Everything is published'}</h2>
            <p>
              {published
                ? 'One commit is on its way; the site rebuilds in a minute or two.'
                : 'Every edit is in the repository.'}
            </p>
          </div>
        </div>
      {/if}
    </div>
    {#if files.length}
      <footer class="drawer-foot">
        {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
        {#if busy}<div class="notice notice-info" role="status">Publishing {plural(ready.length, 'files')}…</div>{/if}
        <div class="foot-row">
          <button
            class="btn btn-primary"
            type="button"
            disabled={busy || discarding || conflicts.length > 0 || !ready.length}
            onclick={publish}
          >
            {busy
              ? 'Publishing…'
              : !ready.length
                ? 'Publish'
                : error && !conflicts.length
                  ? 'Try again'
                  : `Publish ${plural(ready.length, 'files')}`}
          </button>
        </div>
        <p class="foot-note">
          {#if !ready.length}
            Everything still here is on hold. It goes out once whoever is editing it says it is
            ready.
          {:else}
            One commit, then the site rebuilds — live in 1–3 minutes. Nothing is written until the
            whole set lands.
          {/if}
        </p>
      </footer>
    {/if}
  </aside>
</div>

<!-- Not aria-modal: the drawer under it is not inert, and claiming a trap that is not there
     is worse than not claiming it. -->
{#if confirming}
  <div class="scrim">
    <div class="dialog" role="dialog" aria-labelledby="discard-h" tabindex="-1" bind:this={confirmPanel}>
      <h2 id="discard-h">Discard your changes to {named(confirming)}?</h2>
      <p>
        Your unpublished changes to this file are thrown away and it is read from the repository
        again, with whatever was changed there. The published page is not affected.
      </p>
      <div class="actions">
        <button class="btn" type="button" onclick={() => (confirming = '')}>Cancel</button>
        <button class="btn btn-danger" type="button" disabled={discarding} onclick={discard}>
          {discarding ? 'Discarding…' : 'Discard changes'}
        </button>
      </div>
    </div>
  </div>
{/if}
