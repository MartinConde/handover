<script lang="ts">
type File = { path: string; updated_at: number };
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
/** The path whose discard is waiting to be confirmed. */
let confirming = $state('');

const collectionOf = (path: string) => path.replace('src/content/', '').split('/')[0] ?? '';
const slugOf = (path: string) => path.replace(/^.*\//, '').replace(/\.yaml$/, '');
const named = (path: string) => path.replace('src/content/', '');
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, what: string) => `${n} ${n === 1 ? what.replace(/s$/, '') : what}`;

// "2 pages · 1 listing" — the collections behind the paths, in the order they first appear.
const summary = $derived(
  [...new Set(files.map((f) => collectionOf(f.path)))]
    .map((c) => plural(files.filter((f) => collectionOf(f.path) === c).length, c))
    .join(' · '),
);

// What a refusal says. A conflict names its files, and those rows carry the rest of it; a
// branch that moved names none, and saying so in the server's words beats guessing.
const refusal = (body: string, paths: string[]) => {
  if (!paths.length) return `Nothing was published. ${body}`;
  const [what, them] = paths.length === 1 ? ['One file', 'it'] : [`${paths.length} files`, 'them'];
  return `Nothing was published. ${what} changed in the repository after you opened ${them}. Discard your changes to ${them} to take what is there now.`;
};

async function publish() {
  busy = true;
  error = '';
  const res = await fetch('/admin/api/publish', { method: 'POST' });
  busy = false;
  if (res.ok) {
    published = ((await res.json()) as { paths: string[] }).paths.length;
    onpublished();
    return;
  }
  if (res.status !== 409) {
    error = `Publish failed (${res.status}). Nothing was changed.`;
    return;
  }
  // A conflict answers with JSON, a ref that moved with a sentence; both are 409.
  const body = await res.text();
  const parsed = JSON.parse(body.startsWith('{') ? body : '{}') as { paths?: string[] };
  conflicts = parsed.paths ?? [];
  error = refusal(body, conflicts);
}

// Take theirs, whole: the row is gone from the drawer and the entry reads the repository
// again. Choosing field by field is the three-way view, which is not built yet.
async function discard() {
  const path = confirming;
  busy = true;
  const res = await fetch(`/admin/api/drafts/${collectionOf(path)}/${slugOf(path)}`, {
    method: 'DELETE',
  });
  busy = false;
  confirming = '';
  if (!res.ok) {
    error = `Those changes were not discarded (${res.status}).`;
    return;
  }
  conflicts = conflicts.filter((p) => p !== path);
  if (!conflicts.length) error = '';
  ondiscarded();
}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (confirming ? (confirming = '') : onclose())} />

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
        <ul class="change-list">
          {#each files as file (file.path)}
            <li>
              <div class="change-row" class:is-blocked={conflicts.includes(file.path)}>
                <span class="lead" aria-hidden="true"><span class="pdot"></span></span>
                <div class="change-title">
                  <span class="name filename">{named(file.path)}</span>
                  <span class="badge">{capitalise(collectionOf(file.path))}</span>
                  {#if conflicts.includes(file.path)}
                    <span class="badge badge-danger">Changed in the repository since you opened it</span>
                  {/if}
                </div>
                <div class="change-sub">Edited {new Date(file.updated_at).toLocaleString()}</div>
                {#if conflicts.includes(file.path)}
                  <div class="change-actions">
                    <button
                      class="btn btn-sm"
                      type="button"
                      disabled={busy}
                      onclick={() => (confirming = file.path)}
                    >Discard<span class="visually-hidden"> your changes to {named(file.path)}</span></button>
                  </div>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
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
        {#if busy}<div class="notice notice-info" role="status">Publishing {plural(files.length, 'files')}…</div>{/if}
        <div class="foot-row">
          <button
            class="btn btn-primary"
            type="button"
            disabled={busy || conflicts.length > 0}
            onclick={publish}
          >
            {busy
              ? 'Publishing…'
              : error && !conflicts.length
                ? 'Try again'
                : `Publish ${plural(files.length, 'files')}`}
          </button>
        </div>
        <p class="foot-note">One commit, then the site rebuilds — live in 1–3 minutes. Nothing is written until the whole set lands.</p>
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
        <button class="btn btn-danger" type="button" disabled={busy} onclick={discard}>
          {busy ? 'Discarding…' : 'Discard changes'}
        </button>
      </div>
    </div>
  </div>
{/if}
