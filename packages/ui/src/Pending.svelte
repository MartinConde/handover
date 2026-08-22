<script lang="ts">
type File = { path: string; updated_at: number };
let {
  files,
  onclose,
  onpublished,
}: { files: File[]; onclose: () => void; onpublished: () => void } = $props();

// The shell behind the drawer goes inert, so focus has to come with it or be lost.
let panel = $state<HTMLElement>();
$effect(() => panel?.focus());

let busy = $state(false);
let error = $state('');
let published = $state(0);

const collectionOf = (path: string) => path.replace('src/content/', '').split('/')[0] ?? '';
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, what: string) => `${n} ${n === 1 ? what.replace(/s$/, '') : what}`;

// "2 pages · 1 listing" — the collections behind the paths, in the order they first appear.
const summary = $derived(
  [...new Set(files.map((f) => collectionOf(f.path)))]
    .map((c) => plural(files.filter((f) => collectionOf(f.path) === c).length, c))
    .join(' · '),
);

async function publish() {
  busy = true;
  error = '';
  const res = await fetch('/admin/api/publish', { method: 'POST' });
  busy = false;
  if (res.ok) {
    published = ((await res.json()) as { paths: string[] }).paths.length;
    onpublished();
  } else if (res.status === 409) {
    error = `Nothing was published: ${(await res.text()).replace('Changed in', 'changed in')}`;
  } else {
    error = `Publish failed (${res.status}). Nothing was changed.`;
  }
}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

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
              <div class="change-row">
                <span class="lead" aria-hidden="true"><span class="pdot"></span></span>
                <div class="change-title">
                  <span class="name filename">{file.path.replace('src/content/', '')}</span>
                  <span class="badge">{capitalise(collectionOf(file.path))}</span>
                </div>
                <div class="change-sub">Edited {new Date(file.updated_at).toLocaleString()}</div>
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
          <button class="btn btn-primary" type="button" disabled={busy} onclick={publish}>
            {busy ? 'Publishing…' : error ? 'Try again' : `Publish ${plural(files.length, 'files')}`}
          </button>
        </div>
        <p class="foot-note">One commit, then the site rebuilds — live in 1–3 minutes. Nothing is written until the whole set lands.</p>
      </footer>
    {/if}
  </aside>
</div>
