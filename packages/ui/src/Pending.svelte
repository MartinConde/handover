<script lang="ts">
import type { DiffGroup } from '@handover/core';
import { age } from './activity-line';
import BuildPill, { type Build } from './BuildPill.svelte';
import CheckLines, {
  type CheckItem,
  type CheckLine,
  merged,
  plural,
  SEVERITY,
  TINT,
  verdict,
  WORST,
} from './CheckLines.svelte';
import Diff from './Diff.svelte';
import Modal from './Modal.svelte';
import { coordinateEntryPublish, coordinateEntryReplacement } from './navigate';
import Resolve from './Resolve.svelte';
import { request as fetch, uncertainResponse } from './request.js';

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
  held_by?: { id: string; name: string | null; since?: number | null } | null;
};
let {
  entries,
  defaultLocale = '',
  mediaBase = '',
  build,
  onclose,
  onpublished,
  onrevert,
  ondiscarded,
}: {
  entries: Entry[];
  /** The language a check found in several files opens. */
  defaultLocale?: string;
  /** Where a stored media key is served from, for a replaced picture's thumbnails. */
  mediaBase?: string;
  /** The shell's build status, repeated here beside the commit it is of. */
  build?: Build | null;
  onclose: () => void;
  onpublished: (count: number) => void | Promise<void>;
  /** Undo the commit this drawer just made; the shell owns the confirmation. */
  onrevert: (commitSha: string) => void;
  /** A draft was discarded or overwritten, so the entry must be reread wherever it is open. */
  ondiscarded: () => void;
} = $props();

let panel = $state<HTMLElement>();

let busy = $state(false);
let error = $state('');
let published = $state(0);
/** The commit this drawer made, which is what Revert is of. */
let committed = $state('');
/** Entries the last publish was refused over; each one is offered the way out. */
let conflicts = $state<string[]>([]);
/** What the pre-publish checks found over the selected set, newest answer wins. */
let checks = $state<CheckItem[]>([]);
/** The pass could not be run at all — which holds nothing back: it is a lint, not a gate. */
let checksFailed = $state(false);
// Plain, not state: it only decides which answer to keep and nothing draws it.
let asked = 0;
/** Entries whose stored file is not everything their schema needs; fixed where they are edited. */
let unready = $state<string[]>([]);
/** Entries whose languages disagree about their structure; nothing here can settle that. */
let drifted = $state<string[]>([]);
/** The entry whose discard is waiting to be confirmed, and whether it is being thrown away. */
let confirming = $state<Entry>();
let confirmTrigger = $state<HTMLElement>();
let discarding = $state(false);
/** The entry whose three-way view is open, which takes the place of the list while it is. */
let resolving = $state<Entry>();
/** The entry whose changes are being read, and what came back per entry. */
let opened = $state('');
let changes = $state<
  Record<string, { groups: DiffGroup[]; redirects: { from: string; to: string }[] }>
>({});
let reading = $state('');
// Only the changes of mind are stored: a stored selection could not drop a refused row.
let toggled = $state<string[]>([]);

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// Only this drawer's commit gets the pill, or a publish elsewhere would show its build here.
const ours = $derived(build && committed && build.commit_sha === committed ? build : undefined);
const named = (entry: Entry) => entry.title;

const blocked = $derived([...conflicts, ...unready, ...drifted]);
const checked = (entry: Entry) =>
  !blocked.includes(entry.key) && !entry.held_by !== toggled.includes(entry.key);

// A held entry is a promise not to ship half a page, so it is listed rather than missing.
const ready = $derived(entries.filter((e) => !e.held_by));
const held = $derived(entries.filter((e) => e.held_by));
const selected = $derived(entries.filter(checked));

// Filtered here too, so unchecking an entry drops its checks before the next answer arrives.
const found = $derived(checks.filter((c) => selected.some((e) => e.key === c.entry)));

// Grouped by entry, worst first: "no alt text" means nothing without which page it is about.
const groups = $derived(
  entries
    .filter((entry) => found.some((c) => c.entry === entry.key))
    .map((entry) => ({ entry, items: merged(found.filter((c) => c.entry === entry.key)) }))
    .sort((a, b) => WORST[a.items[0]?.severity ?? 'info'] - WORST[b.items[0]?.severity ?? 'info']),
);
// A check on a page outside the set has no row to sit under, so it is listed apart, uncounted.
const elsewhere = $derived(merged(checks.filter((c) => !entries.some((e) => e.key === c.entry))));
// Counted as the client reads them: one line is one problem, however many files it is in.
const lines = $derived(groups.flatMap((g) => g.items));
const errors = $derived(lines.filter((c) => c.severity === 'error'));
const warnings = $derived(lines.filter((c) => c.severity === 'warn'));

// Addressed the way the check names the field, so it still lands after its block has moved.
const goTo = (item: CheckLine) => {
  const [collection = '', slug = ''] = item.entry.split('/');
  // The default language is the one the fix is written in, not whichever file was listed first.
  const locale = item.locales.find((l) => l === defaultLocale) ?? item.locales[0];
  const query = new URLSearchParams({ field: item.fieldPath, ...(locale ? { locale } : {}) });
  if (collection === 'globals') return `/admin/site/${slug}?${query}`;
  return `/admin/c/${collection}/${slug}${item.fieldPath.startsWith('seo') ? '/seo' : ''}?${query}`;
};

// "3 pages · 2 listings · +1 redirect", collections in the order they first appear.
const rules = $derived(entries.reduce((n, e) => n + (e.redirects ?? 0), 0));
const summary = $derived(
  [
    ...[...new Set(entries.map((e) => e.collection))].map((c) =>
      plural(entries.filter((e) => e.collection === c).length, c),
    ),
    ...(rules ? [`+${plural(rules, 'redirects')}`] : []),
  ].join(' · '),
);

// A moved branch names no entries, so the server's own sentence stands as it is.
const refusal = (body: string, keys: string[]) => {
  if (!keys.length) return `Nothing was published. ${body}`;
  const [what, them] = keys.length === 1 ? ['One entry', 'it'] : [`${keys.length} entries`, 'them'];
  return `Nothing was published. ${what} changed in the repository after you opened ${them}. Resolve ${them} to keep what you wrote, or discard your changes to take what is there now.`;
};

// Pressing again can work here, so the way out for a field with no editor yet is named.
const incomplete = (keys: string[]) =>
  keys.length === 1
    ? 'Nothing was published. One entry is not finished — open it to see what is missing. Delete it if it cannot be filled in yet.'
    : `Nothing was published. ${keys.length} entries are not finished — open them to see what is missing. Delete the ones that cannot be filled in yet.`;

// No draft is stale here, so Discard is not the way out; the files themselves are.
const adrift = (keys: string[]) =>
  keys.length === 1
    ? "Nothing was published. One entry's languages disagree about which blocks it has — the files have to agree before it can go out."
    : `Nothing was published. ${keys.length} entries have languages that disagree about which blocks they have — the files have to agree before they can go out.`;

/** The entries a refusal's paths belong to: it answers with files, and this list is of entries. */
const entriesOf = (paths: string[]) =>
  entries.filter((e) => e.files.some((f) => paths.includes(f))).map((e) => e.key);

// Linted over the selection: a page only an unselected draft would create is not there.
$effect(() => {
  void lint(selected.map((e) => e.key));
});

/** A check nobody could run is no reason to stop a publish, so the lint holds nothing back. */
async function lint(keys: string[]): Promise<CheckItem[]> {
  const request = ++asked;
  if (!keys.length) {
    checks = [];
    checksFailed = false;
    return [];
  }
  const res = await fetch('/admin/api/publish/checks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: keys }),
  }).catch(() => undefined);
  const failed = !res?.ok;
  const results = (res?.ok && ((await res.json()) as { results?: CheckItem[] }).results) || [];
  // Returning to the same selection must not make an older answer current again.
  if (asked === request) {
    checksFailed = failed;
    checks = results;
  }
  return results;
}

async function publish() {
  const going = selected.map((entry) => ({ key: entry.key, files: [...entry.files] }));
  const keys = going.map((entry) => entry.key);
  // Busy from the press, not the commit: a button live through the lint publishes the set twice.
  busy = true;
  error = '';
  unready = [];
  drifted = [];
  let res: Response | undefined;
  let checksBlocked = false;
  const outcome = await coordinateEntryPublish(async () => {
    // Linted again after reserving the open entry, so its saved revision cannot trail the commit.
    const finalChecks = await lint(keys);
    if (finalChecks.some((item) => item.severity === 'error' && keys.includes(item.entry))) {
      checksBlocked = true;
      return false;
    }
    res = await fetch('/admin/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: keys }),
    });
    if (uncertainResponse(res)) throw new TypeError('The publish response was not confirmed.');
    return res.ok;
  });
  busy = false;
  if (outcome.ok && res?.ok) {
    const { paths, commit_sha } = (await res.json()) as { paths: string[]; commit_sha?: string };
    committed = commit_sha ?? '';
    // Counted before the reload reads the list again without what just went out.
    published = going.filter((e) => e.files.some((f) => paths.includes(f))).length;
    // Selection is per publish: what is left behind starts from the defaults again.
    toggled = [];
    await onpublished(published);
    return;
  }
  if (!outcome.ok && outcome.reason === 'save') {
    error =
      'Nothing was published. Your latest changes could not be saved — check your connection and try again.';
    panel?.focus();
    return;
  }
  if (checksBlocked) {
    error =
      'Nothing was published. The checks found something in the way just now — it is listed above.';
    panel?.focus();
    return;
  }
  if (!outcome.ok && outcome.reason === 'uncertain') {
    error =
      'The publish response was lost, so the open entry is being reloaded before you continue.';
    return;
  }
  if (!outcome.ok && outcome.reason === 'reload') {
    error = 'The changes were published, but the open entry could not reload. Reload the page.';
    return;
  }
  if (!res) {
    error = 'Nothing was published. Try again.';
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
  // A conflict, drift and a moved ref are all 409; only the first two answer with JSON.
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

// Take theirs whole; choosing field by field is the three-way view.
async function discard() {
  const entry = confirming;
  if (!entry) return;
  discarding = true;
  let res: Response | undefined;
  const outcome = await coordinateEntryReplacement(entry.key, async () => {
    res = await fetch(`/admin/api/drafts/${entry.key}`, { method: 'DELETE' });
    if (uncertainResponse(res)) throw new TypeError('The discard response was not confirmed.');
    return res.ok;
  });
  discarding = false;
  confirming = undefined;
  if (!outcome.ok && outcome.reason === 'save') {
    error = 'Those changes were not discarded because the open entry could not finish saving.';
    return;
  }
  if (!outcome.ok && (outcome.reason === 'uncertain' || outcome.reason === 'reload')) {
    error = 'The discard result could not be confirmed. Reload the page before continuing.';
    return;
  }
  if (!outcome.ok) {
    if (!res) {
      error = 'Those changes may have changed remotely. Reload the page before continuing.';
      return;
    }
    error = `Those changes were not discarded (${res.status}).`;
    return;
  }
  conflicts = conflicts.filter((k) => k !== entry.key);
  // The refusal is about the entries still in it, so it is written again rather than kept.
  error = conflicts.length ? refusal('', conflicts) : '';
  ondiscarded();
}

// Read once and kept: the list does not move while the drawer is open.
async function open(entry: Entry) {
  opened = opened === entry.key ? '' : entry.key;
  if (!opened || changes[entry.key]) return;
  reading = entry.key;
  const res = await fetch(`/admin/api/diff/${entry.key}`);
  reading = '';
  if (!res.ok) {
    error = `What changed in ${named(entry)} could not be read (${res.status}).`;
    opened = '';
    return;
  }
  changes[entry.key] = (await res.json()) as (typeof changes)[string];
}

// Focus goes back to the panel rather than staying on the button just removed.
function closeResolver() {
  resolving = undefined;
  panel?.focus();
}

// The draft now sits on the file at HEAD, so the row can be published with the rest.
function resolved(entry: Entry) {
  closeResolver();
  conflicts = conflicts.filter((k) => k !== entry.key);
  error = conflicts.length ? refusal('', conflicts) : '';
  // What it changed is the merge now, not what was read before it.
  delete changes[entry.key];
  ondiscarded();
}

function toggle(entry: Entry) {
  if (busy) return;
  toggled = toggled.includes(entry.key)
    ? toggled.filter((k) => k !== entry.key)
    : [...toggled, entry.key];
}
// The store is changes of mind: all turns every hold on, none turns every ready entry off.
const selectAll = () => {
  if (!busy) toggled = held.map((e) => e.key);
};
const selectNone = () => {
  if (!busy) toggled = ready.map((e) => e.key);
};

function askDiscard(entry: Entry) {
  confirmTrigger = document.activeElement as HTMLElement;
  confirming = entry;
}
</script>

{#snippet result()}
  <p class="result-actions">
    {#if ours}<BuildPill build={ours} />{/if}
    {#if committed}
      <button class="btn-link" type="button" onclick={() => onrevert(committed)}>
        Revert this publish
      </button>
    {/if}
  </p>
{/snippet}

{#snippet change(entry: Entry)}
  <li>
    <div class="change-row" class:is-held={entry.held_by} class:is-blocked={blocked.includes(entry.key)}>
      <label class="lead" for="pending-{entry.key}">
        <span class="visually-hidden">Include {named(entry)}</span>
        <input
          type="checkbox"
          id="pending-{entry.key}"
          checked={checked(entry)}
          disabled={busy || blocked.includes(entry.key)}
          onchange={() => toggle(entry)}
        >
      </label>
      <div class="change-title">
        <span class="name">{named(entry)}</span>
        <span class="badge">{capitalise(entry.collection)}</span>
        {#if entry.locales.length}
          <span class="visually-hidden">Languages:</span>
          <span class="chips">
            {#each entry.locales as of (of)}<span class="chip">{of.toUpperCase()}</span>{/each}
          </span>
        {/if}
        {#if entry.redirects}
          <span class="badge badge-accent">+{plural(entry.redirects, 'redirects')}</span>
        {/if}
        {#if entry.held_by}
          {@const held = entry.held_by.since ? age(entry.held_by.since) : ''}
          <span class="badge badge-warn"
            >On hold · {entry.held_by.name || 'somebody'}{held ? ` · ${held}` : ''}</span
          >
        {/if}
        {#if conflicts.includes(entry.key)}
          <span class="badge badge-danger">Changed in the repository since you opened it</span>
          <button
            class="btn btn-sm"
            type="button"
            disabled={busy || discarding}
            aria-label="Resolve {named(entry)}"
            onclick={() => (resolving = entry)}
          >Resolve</button>
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
      <div class="change-actions">
        {#if conflicts.includes(entry.key)}
          <button
            class="btn btn-sm"
            type="button"
            disabled={busy || discarding}
            aria-label="Discard your changes to {named(entry)}"
            onclick={() => askDiscard(entry)}
          >Discard</button>
        {/if}
        <button
          class="btn btn-ghost btn-icon"
          type="button"
          aria-expanded={opened === entry.key}
          aria-label="What changed in {named(entry)}"
          onclick={() => open(entry)}
        >{opened === entry.key ? '▾' : '▸'}</button>
      </div>
    </div>
    {#if opened === entry.key}
      {@const shown = changes[entry.key]}
      {#if shown}
        <div class="change-diff">
          <Diff groups={shown.groups} {mediaBase} />
          {#if shown.redirects.length}
            <h4>Riding along</h4>
            <div class="diff">
              {#each shown.redirects as rule (rule.from)}
                <div class="row is-block">
                  <small>Redirect</small>
                  <code>{rule.from}</code>
                  <span aria-hidden="true">→</span>
                  <code>{rule.to}</code>
                  <span class="sub">— because you changed the web address</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="change-diff"><p class="foot-note" role="status">
          {reading === entry.key ? 'Reading what changed…' : 'Nothing to show.'}
        </p></div>
      {/if}
    {/if}
  </li>
{/snippet}

<Modal
  labelledby="pending-h"
  panelClass="drawer"
  scrimClass="is-right"
  dismissible={!busy && !discarding}
  bind:panel
  onclose={resolving ? closeResolver : onclose}
>
    <header class="drawer-head">
      <div class="head-row">
        <h2 id="pending-h">Unpublished changes</h2>
        <button
          class="btn btn-ghost btn-icon"
          type="button"
          aria-label="Close"
          disabled={busy || discarding}
          onclick={resolving ? closeResolver : onclose}
        >✕</button>
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
          <button class="btn-link" type="button" disabled={busy} aria-label="Select all the changes" onclick={selectAll}>all</button>
          <span class="sep" aria-hidden="true">·</span>
          <button class="btn-link" type="button" disabled={busy} aria-label="Select none of the changes" onclick={selectNone}>none</button>
        </div>
      {:else}
        <p class="drawer-meta">Nothing to publish</p>
      {/if}
    </header>
    <div class="drawer-body">
      {#if resolving}
        <!-- In place of the list, not over it: the rows behind it are not answers to anything. -->
        <Resolve
          entry={resolving.key}
          title={named(resolving)}
          updated={resolving.updated_at}
          onclose={closeResolver}
          onresolved={() => resolving && resolved(resolving)}
        />
      {:else if entries.length}
        <!-- A hold left behind keeps the drawer open, so the commit is also named here. -->
        {#if published}
          <div class="publish-result">
            <h3>Published {plural(published, 'changes')}</h3>
            <p>One commit is on its way; the site rebuilds in a minute or two.</p>
            {@render result()}
          </div>
        {/if}
        {#if checksFailed || groups.length || elsewhere.length}
          <section class="checks" aria-labelledby="checks-h">
            <h3 class="group-title" id="checks-h">Checks</h3>
            {#if checksFailed}
              <p class="checks-sum" role="status">
                The checks could not be run this time, so nothing on this list has been looked at.
              </p>
            {:else}
              <p class="checks-sum">
                {verdict(lines)} Checked over
                {selected.length === 1 ? 'the entry' : `the ${selected.length} entries`} you have
                selected, and again when you press Publish.
              </p>
              {#each groups as group (group.entry.key)}
                <div class="check-group">
                  <h4>{named(group.entry)} <span class="badge">{capitalise(group.entry.collection)}</span></h4>
                  <CheckLines lines={group.items} chips={group.entry.locales.length > 1} {goTo} {onclose} />
                </div>
              {/each}
              {#if elsewhere.length}
                <div class="check-group">
                  <h4>Elsewhere on the site</h4>
                  {#each elsewhere as item (item.path + item.fieldPath + item.check)}
                    <div class="notice notice-{TINT[item.severity]}">
                      <span class="sev">{SEVERITY[item.severity]}</span>
                      <span class="msg">{item.message}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            {/if}
          </section>
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
            {#if published}{@render result()}{/if}
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
            disabled={busy || discarding || Boolean(resolving) || !selected.length || errors.length > 0}
            onclick={publish}
          >
            {#if busy}Publishing…
            {:else if errors.length}Fix {plural(errors.length, 'errors')} to publish
            {:else if !selected.length}Publish
            {:else if warnings.length}Publish anyway ({plural(warnings.length, 'warnings')})
            {:else}Publish {plural(selected.length, 'changes')}{/if}
          </button>
        </div>
        <p class="foot-note">
          {#if resolving}
            Publishing waits while a conflict is open: the rest would go out in the same commit,
            and this entry is not ready to be in it.
          {:else if !ready.length}
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
</Modal>

{#if confirming}
  <Modal
    labelledby="discard-h"
    returnTo={confirmTrigger}
    dismissible={!discarding}
    onclose={() => (confirming = undefined)}
  >
      <h2 id="discard-h">Discard your changes to {named(confirming)}?</h2>
      <p>
        Your unpublished changes to this entry are thrown away and it is read from the repository
        again, with whatever was changed there. The published page is not affected.
      </p>
      <div class="actions">
        <button class="btn" type="button" disabled={discarding} onclick={() => (confirming = undefined)}>Cancel</button>
        <button class="btn btn-danger" type="button" disabled={discarding} onclick={discard}>
          {discarding ? 'Discarding…' : 'Discard changes'}
        </button>
      </div>
  </Modal>
{/if}
