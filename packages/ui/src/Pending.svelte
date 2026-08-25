<script lang="ts">
type Entry = {
  /** `listings/mill-house` — what a publish is of, since the languages go out together. */
  key: string;
  title: string;
  collection: string;
  /** The languages of it that are waiting, in the order the site declares them. */
  locales: string[];
  files: string[];
  /** Address changes it owes; redirects.yaml is assembled at publish and is never a row. */
  redirects?: number;
  updated_at: number;
  /** Somebody marked it "Not ready yet"; null where nobody has. */
  held_by?: { id: string; name: string | null } | null;
};
let {
  entries,
  onclose,
  onpublished,
  ondiscarded,
}: {
  entries: Entry[];
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
/** Entries the last publish was refused over; each one is offered the way out. */
let conflicts = $state<string[]>([]);
/** Entries whose stored file is not everything their schema needs; fixed where they are edited. */
let unready = $state<string[]>([]);
/** Entries whose languages disagree about their structure; nothing here can settle that. */
let drifted = $state<string[]>([]);
/** The entry whose discard is waiting to be confirmed, and whether it is being thrown away. */
let confirming = $state<Entry>();
let discarding = $state(false);
// What the client changed their mind about, not what is checked: the default is every entry
// except the ones on hold, and a row this publish was refused over is off whatever they said.
// Storing the selection itself would either be recomputed on every reload — losing the refusal
// — or unable to take a refused row back out.
let toggled = $state<string[]>([]);

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, what: string) => `${n} ${n === 1 ? what.replace(/s$/, '') : what}`;
const named = (entry: Entry) => entry.title;

const blocked = $derived([...conflicts, ...unready, ...drifted]);
const checked = (entry: Entry) =>
  !blocked.includes(entry.key) && !entry.held_by !== toggled.includes(entry.key);

// What this publish would commit, and what it would leave behind. A held entry is somebody
// else's promise not to ship half a page, so it is listed rather than quietly missing.
const ready = $derived(entries.filter((e) => !e.held_by));
const held = $derived(entries.filter((e) => e.held_by));
const selected = $derived(entries.filter(checked));

// "3 pages · 2 listings · +1 redirect" — the collections behind the entries, in the order they
// first appear, and what their address changes owe.
const rules = $derived(entries.reduce((n, e) => n + (e.redirects ?? 0), 0));
const summary = $derived(
  [
    ...[...new Set(entries.map((e) => e.collection))].map((c) =>
      plural(entries.filter((e) => e.collection === c).length, c),
    ),
    ...(rules ? [`+${plural(rules, 'redirects')}`] : []),
  ].join(' · '),
);

// What a refusal says. A conflict names its entries, and those rows carry the rest of it; a
// branch that moved names none, and saying so in the server's words beats guessing.
const refusal = (body: string, keys: string[]) => {
  if (!keys.length) return `Nothing was published. ${body}`;
  const [what, them] = keys.length === 1 ? ['One entry', 'it'] : [`${keys.length} entries`, 'them'];
  return `Nothing was published. ${what} changed in the repository after you opened ${them}. Discard your changes to ${them} to take what is there now.`;
};

// The other refusal: nothing was taken from anyone, the entry simply is not finished. Unlike a
// conflict, coming back and pressing again can work — so the way out for a field with no editor
// yet is named, because filling it in is not one.
const incomplete = (keys: string[]) =>
  keys.length === 1
    ? 'Nothing was published. One entry is not finished — open it to see what is missing. Delete it if it cannot be filled in yet.'
    : `Nothing was published. ${keys.length} entries are not finished — open them to see what is missing. Delete the ones that cannot be filled in yet.`;

// And the third: the entry's own files disagree about which blocks it has. Nothing was taken
// from anyone and no draft is stale, so Discard is not the way out — the files themselves are.
const adrift = (keys: string[]) =>
  keys.length === 1
    ? "Nothing was published. One entry's languages disagree about which blocks it has — the files have to agree before it can go out."
    : `Nothing was published. ${keys.length} entries have languages that disagree about which blocks they have — the files have to agree before they can go out.`;

/** The entries a refusal's paths belong to: it answers with files, and this list is of entries. */
const entriesOf = (paths: string[]) =>
  entries.filter((e) => e.files.some((f) => paths.includes(f))).map((e) => e.key);

async function publish() {
  const going = selected;
  busy = true;
  error = '';
  unready = [];
  drifted = [];
  const res = await fetch('/admin/api/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: going.map((e) => e.key) }),
  });
  busy = false;
  if (res.ok) {
    const { paths } = (await res.json()) as { paths: string[] };
    // Counted here rather than after the reload: the list is about to be read again without
    // what just went out.
    published = going.filter((e) => e.files.some((f) => paths.includes(f))).length;
    // Selection is per publish: what is left behind starts from the defaults again, the same
    // as it would if the drawer had been closed and reopened.
    toggled = [];
    onpublished();
    return;
  }
  if (res.status === 422) {
    unready = entriesOf(((await res.json()) as { paths: string[] }).paths);
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
    drifted = entriesOf(parsed.paths ?? []);
    error = adrift(drifted);
    return;
  }
  conflicts = entriesOf(parsed.paths ?? []);
  error = refusal(body, conflicts);
}

// Take theirs, whole: the row is gone from the drawer and the entry reads the repository
// again. Choosing field by field is the three-way view, which is not built yet.
async function discard() {
  const entry = confirming;
  if (!entry) return;
  discarding = true;
  const res = await fetch(`/admin/api/drafts/${entry.key}`, { method: 'DELETE' });
  discarding = false;
  confirming = undefined;
  if (!res.ok) {
    error = `Those changes were not discarded (${res.status}).`;
    return;
  }
  conflicts = conflicts.filter((k) => k !== entry.key);
  // The refusal is about the entries still in it, so it is written again rather than kept.
  error = conflicts.length ? refusal('', conflicts) : '';
  ondiscarded();
}

function toggle(entry: Entry) {
  toggled = toggled.includes(entry.key)
    ? toggled.filter((k) => k !== entry.key)
    : [...toggled, entry.key];
}
// Select all and none are absolute, and the store is what the client changed their mind about:
// all of it means every hold turned on, none of it means every ready entry turned off.
const selectAll = () => (toggled = held.map((e) => e.key));
const selectNone = () => (toggled = ready.map((e) => e.key));
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (confirming ? (confirming = undefined) : onclose())} />

{#snippet change(entry: Entry)}
  <li>
    <div class="change-row" class:is-held={entry.held_by} class:is-blocked={blocked.includes(entry.key)}>
      <label class="lead" for="pending-{entry.key}">
        <span class="visually-hidden">Include {named(entry)}</span>
        <input
          type="checkbox"
          id="pending-{entry.key}"
          checked={checked(entry)}
          disabled={blocked.includes(entry.key)}
          onchange={() => toggle(entry)}
        >
      </label>
      <div class="change-title">
        <span class="name">{named(entry)}</span>
        <span class="badge">{capitalise(entry.collection)}</span>
        {#if entry.locales.length}
          <span class="chips" aria-label="Languages">
            {#each entry.locales as of (of)}<span class="chip">{of.toUpperCase()}</span>{/each}
          </span>
        {/if}
        {#if entry.redirects}
          <span class="badge badge-accent">+{plural(entry.redirects, 'redirects')}</span>
        {/if}
        {#if entry.held_by}
          <span class="badge badge-warn">On hold · {entry.held_by.name || 'somebody'}</span>
        {/if}
        {#if conflicts.includes(entry.key)}
          <span class="badge badge-danger">Changed in the repository since you opened it</span>
        {:else if unready.includes(entry.key)}
          <span class="badge badge-danger">Not ready to publish</span>
        {:else if drifted.includes(entry.key)}
          <span class="badge badge-danger">Languages disagree</span>
        {/if}
      </div>
      <div class="change-sub">
        {plural(entry.files.length, 'files')}
        <span class="sep" aria-hidden="true">·</span>
        edited {new Date(entry.updated_at).toLocaleString()}
      </div>
      {#if conflicts.includes(entry.key)}
        <div class="change-actions">
          <button
            class="btn btn-sm"
            type="button"
            disabled={busy || discarding}
            aria-label="Discard your changes to {named(entry)}"
            onclick={() => (confirming = entry)}
          >Discard</button>
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
      {#if entries.length}
        <p class="drawer-meta">
          <span class="count">{plural(entries.length, 'changes')}</span>
          <span class="sep" aria-hidden="true">·</span> {selected.length} selected
          {#if conflicts.length}
            <span class="sep" aria-hidden="true">·</span> {plural(conflicts.length, 'conflicts')}
          {/if}
          {#if held.length}
            <span class="sep" aria-hidden="true">·</span>
            {held.filter((e) => !checked(e)).length} on hold
          {/if}
        </p>
        <p class="drawer-meta is-summary">{summary}</p>
        <div class="drawer-tools">
          <span>Select</span>
          <button class="btn-link" type="button" aria-label="Select all the changes" onclick={selectAll}>all</button>
          <span class="sep" aria-hidden="true">·</span>
          <button class="btn-link" type="button" aria-label="Select none of the changes" onclick={selectNone}>none</button>
        </div>
      {:else}
        <p class="drawer-meta">Nothing to publish</p>
      {/if}
    </header>
    <div class="drawer-body">
      {#if entries.length}
        <!-- A publish that left a hold behind does not empty the drawer, so the empty state below
             is not where the commit gets named. Neutral, not green: the commit landed, the site
             has not. -->
        {#if published}
          <div class="publish-result">
            <h3>Published {plural(published, 'changes')}</h3>
            <p>One commit is on its way; the site rebuilds in a minute or two.</p>
          </div>
        {/if}
        <ul class="change-list">
          {#each ready as entry (entry.key)}{@render change(entry)}{/each}
        </ul>
        {#if held.length}
          <div class="change-group">
            <h3 class="group-title">{published ? 'Still on hold' : 'On hold'}</h3>
            <ul class="change-list">
              {#each held as entry (entry.key)}{@render change(entry)}{/each}
            </ul>
            {#if held.some(checked)}
              <div class="notice notice-warn">
                Publishing this releases the hold. It is logged, and whoever set it sees it in
                the activity log.
              </div>
            {:else}
              <p class="foot-note">
                Whoever is editing these says they are not ready, so they are left out. Checking
                one includes it and releases the hold — the activity log records who did.
              </p>
            {/if}
          </div>
        {/if}
      {:else}
        <div class="empty">
          <div>
            <h2>{published ? `Published ${plural(published, 'changes')}` : 'Everything is published'}</h2>
            <p>
              {published
                ? 'One commit is on its way; the site rebuilds in a minute or two.'
                : 'Every edit is in the repository.'}
            </p>
          </div>
        </div>
      {/if}
    </div>
    {#if entries.length}
      <footer class="drawer-foot">
        {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
        {#if busy}<div class="notice notice-info" role="status">Publishing {plural(selected.length, 'changes')}…</div>{/if}
        <div class="foot-row">
          <button
            class="btn btn-primary"
            type="button"
            disabled={busy || discarding || !selected.length}
            onclick={publish}
          >
            {busy ? 'Publishing…' : selected.length ? `Publish ${plural(selected.length, 'changes')}` : 'Publish'}
          </button>
        </div>
        <p class="foot-note">
          {#if !ready.length}
            Everything still here is on hold. Check one to include it — that releases the hold.
          {:else if !selected.length && ready.every((e) => blocked.includes(e.key))}
            Nothing can go out: every entry here is held back by what is marked on its row.
          {:else if !selected.length}
            Nothing is selected. Check what you want to publish.
          {:else if blocked.length}
            The entries marked above are held back on their own; the rest still publish.
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
        Your unpublished changes to this entry are thrown away and it is read from the repository
        again, with whatever was changed there. The published page is not affected.
      </p>
      <div class="actions">
        <button class="btn" type="button" onclick={() => (confirming = undefined)}>Cancel</button>
        <button class="btn btn-danger" type="button" disabled={discarding} onclick={discard}>
          {discarding ? 'Discarding…' : 'Discard changes'}
        </button>
      </div>
    </div>
  </div>
{/if}
