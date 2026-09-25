<script lang="ts">
import type { DiffGroup, Labels } from '@handover/core';
import { onDestroy } from 'svelte';
import { messageLine, responseMessage, type UiMessage } from '../errors.js';
import { collectionName, formatFieldTime, messageOptions, type UiLocale } from '../i18n.js';
import { coordinateEntryPublish, coordinateEntryReplacement } from '../navigate';
import * as m from '../paraglide/messages.js';
import { request as fetch, uncertainResponse } from '../request.js';
import Modal from '../shared/Modal.svelte';
import BuildPill, { type Build } from '../shell/BuildPill.svelte';
import CheckLines, {
  type CheckItem,
  type CheckLine,
  merged,
  severityLabel,
  TINT,
  verdict,
  WORST,
} from './CheckLines.svelte';
import Diff from './Diff.svelte';
import Resolve from './Resolve.svelte';

export type PendingEntry = {
  /** `listings/mill-house` — what a publish is of, since the languages go out together. */
  key: string;
  title: string;
  labels?: Labels;
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
  uiLocale = 'en',
  onclose: closed,
  onpublished,
  onrevert,
  ondiscarded,
}: {
  entries: PendingEntry[];
  /** The language a check found in several files opens. */
  defaultLocale?: string;
  /** Where a stored media key is served from, for a replaced picture's thumbnails. */
  mediaBase?: string;
  /** The shell's build status, repeated here beside the commit it is of. */
  build?: Build | null;
  uiLocale?: UiLocale;
  onclose: () => void;
  onpublished: (count: number) => void | Promise<void>;
  /** Undo the commit this drawer just made; the shell owns the confirmation. */
  onrevert: (commitSha: string) => void;
  /** A draft was discarded or overwritten, so the entry must be reread wherever it is open. */
  ondiscarded: () => void;
} = $props();
const options = $derived(messageOptions(uiLocale));

let panel = $state<HTMLElement>();
let closing = $state(false);
let exitAnimation: Animation | undefined;
let destroyed = false;

function onclose() {
  if (closing) return;
  if (!panel?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    closed();
    return;
  }
  closing = true;
  // Keep the native modal and focus boundary alive until the drawer has left the screen.
  panel.inert = true;
  exitAnimation = panel.animate(
    [
      { transform: 'translateX(0)', opacity: 1 },
      { transform: 'translateX(32px)', opacity: 0 },
    ],
    { duration: 200, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' },
  );
  const finish = () => {
    if (!destroyed) closed();
  };
  void exitAnimation.finished.then(finish, finish);
}

onDestroy(() => {
  destroyed = true;
  exitAnimation?.cancel();
});

let busy = $state(false);
let error = $state<UiMessage>();
const errorText = $derived(error ? messageLine(error, uiLocale) : '');
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
let confirming = $state<PendingEntry>();
let confirmTrigger = $state<HTMLElement>();
let discarding = $state(false);
/** The entry whose three-way view is open, which takes the place of the list while it is. */
let resolving = $state<PendingEntry>();
/** The entry whose changes are being read, and what came back per entry. */
let opened = $state('');
let changes = $state<
  Record<string, { groups: DiffGroup[]; redirects: { from: string; to: string }[] }>
>({});
let reading = $state('');
// Only the changes of mind are stored: a stored selection could not drop a refused row.
let toggled = $state<string[]>([]);

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const midnight = (at: number) => new Date(at).setHours(0, 0, 0, 0);
const holdAge = (since: number) => {
  const days = Math.round((midnight(Date.now()) - midnight(since)) / 86_400_000);
  return days < 1 ? '' : m.pending_day_count({ count: days }, options);
};
// Only this drawer's commit gets the pill, or a publish elsewhere would show its build here.
const ours = $derived(build && committed && build.commit_sha === committed ? build : undefined);
const named = (entry: PendingEntry) => entry.labels?.[uiLocale] ?? entry.title;

const blocked = $derived([...conflicts, ...unready, ...drifted]);
const checked = (entry: PendingEntry) =>
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
      m.pending_collection_count(
        {
          count: entries.filter((e) => e.collection === c).length,
          collection: collectionName(c, uiLocale),
          singular: collectionName(c, uiLocale, 'singular'),
        },
        options,
      ),
    ),
    ...(rules ? [`+${m.pending_redirect_count({ count: rules }, options)}`] : []),
  ].join(' · '),
);

const refusal = (keys: string[]): UiMessage => ({ code: 'PUBLISH_CONFLICT', count: keys.length });

// Pressing again can work here, so the way out for a field with no editor yet is named.
const incomplete = (keys: string[]): UiMessage => ({
  code: 'PUBLISH_INCOMPLETE',
  count: keys.length,
});

// No draft is stale here, so Discard is not the way out; the files themselves are.
const adrift = (keys: string[]): UiMessage => ({ code: 'PUBLISH_DRIFT', count: keys.length });

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
  error = undefined;
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
    error = { code: 'PUBLISH_SAVE_FAILED' };
    panel?.focus();
    return;
  }
  if (checksBlocked) {
    error = { code: 'PUBLISH_CHECKS_BLOCKED' };
    panel?.focus();
    return;
  }
  if (!outcome.ok && outcome.reason === 'uncertain') {
    error = { code: 'PUBLISH_RESPONSE_LOST' };
    return;
  }
  if (!outcome.ok && outcome.reason === 'reload') {
    error = { code: 'PUBLISH_RELOAD_FAILED' };
    return;
  }
  if (!res) {
    error = { code: 'PUBLISH_FAILED' };
    return;
  }
  if (res.status === 422) {
    unready = entriesOf(((await res.json()) as { paths: string[] }).paths);
    error = incomplete(unready);
    return;
  }
  if (res.status !== 409) {
    error = await responseMessage(res, 'PUBLISH_FAILED');
    return;
  }
  // A conflict, drift and a moved ref are all 409; only the first two answer with JSON.
  const body = await res.text();
  const parsed = JSON.parse(body.startsWith('{') ? body : '{}') as {
    code?: string;
    error?: string;
    paths?: string[];
    reason?: string;
  };
  if (parsed.reason === 'drift') {
    drifted = entriesOf(parsed.paths ?? []);
    error = adrift(drifted);
    return;
  }
  // Settled in the repository, not by Discard, so no row offers it.
  if (parsed.code === 'PUBLISH_SOURCE_UNRESOLVED') {
    error = { code: parsed.code, count: entriesOf(parsed.paths ?? []).length };
    return;
  }
  conflicts = entriesOf(parsed.paths ?? []);
  error = conflicts.length
    ? refusal(conflicts)
    : {
        code: parsed.code ?? res.headers.get('x-handover-error-code') ?? 'PUBLISH_REF_MOVED',
        status: res.status,
        ...(!parsed.code && !res.headers.has('x-handover-error-code') && body
          ? { detail: parsed.error ?? body }
          : {}),
      };
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
    error = { code: 'PENDING_DISCARD_SAVE_FAILED' };
    return;
  }
  if (!outcome.ok && (outcome.reason === 'uncertain' || outcome.reason === 'reload')) {
    error = { code: 'PENDING_DISCARD_UNCONFIRMED' };
    return;
  }
  if (!outcome.ok) {
    if (!res) {
      error = { code: 'PENDING_DISCARD_REMOTE_CHANGED' };
      return;
    }
    error = { code: 'PENDING_DISCARD_FAILED', status: res.status };
    return;
  }
  conflicts = conflicts.filter((k) => k !== entry.key);
  // The refusal is about the entries still in it, so it is written again rather than kept.
  error = conflicts.length ? refusal(conflicts) : undefined;
  ondiscarded();
}

// Read once and kept: the list does not move while the drawer is open.
async function open(entry: PendingEntry) {
  opened = opened === entry.key ? '' : entry.key;
  if (!opened || changes[entry.key]) return;
  reading = entry.key;
  const res = await fetch(`/admin/api/diff/${entry.key}`);
  reading = '';
  if (!res.ok) {
    error = { code: 'PENDING_DIFF_FAILED', status: res.status, page: named(entry) };
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
function resolved(entry: PendingEntry) {
  closeResolver();
  conflicts = conflicts.filter((k) => k !== entry.key);
  error = conflicts.length ? refusal(conflicts) : undefined;
  // What it changed is the merge now, not what was read before it.
  delete changes[entry.key];
  ondiscarded();
}

function toggle(entry: PendingEntry) {
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

function askDiscard(entry: PendingEntry) {
  confirmTrigger = document.activeElement as HTMLElement;
  confirming = entry;
}
</script>

{#snippet result()}
  <p class="result-actions">
    {#if ours}<BuildPill build={ours} {uiLocale} />{/if}
    {#if committed}
      <button class="btn-link" type="button" onclick={() => onrevert(committed)}>
        {m.pending_revert({}, options)}
      </button>
    {/if}
  </p>
{/snippet}

{#snippet change(entry: PendingEntry)}
  <li>
    <div class={['change-row', { 'is-held': entry.held_by, 'is-blocked': blocked.includes(entry.key) }]}>
      <label class="lead" for="pending-{entry.key}">
        <span class="visually-hidden">{m.pending_include({ title: named(entry) }, options)}</span>
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
        <span class="badge">{capitalise(collectionName(entry.collection, uiLocale))}</span>
        {#if entry.locales.length}
          <span class="visually-hidden">{m.check_languages({}, options)}</span>
          <span class="chips">
            {#each entry.locales as of (of)}<span class="chip">{of.toUpperCase()}</span>{/each}
          </span>
        {/if}
        {#if entry.redirects}
          <span class="badge badge-accent">+{m.pending_redirect_count({ count: entry.redirects }, options)}</span>
        {/if}
        {#if entry.held_by}
          {@const held = entry.held_by.since ? holdAge(entry.held_by.since) : ''}
          <span class="badge badge-warn"
            >{held
              ? m.pending_on_hold_by_age({ name: entry.held_by.name || m.pending_somebody({}, options), age: held }, options)
              : m.pending_on_hold_by({ name: entry.held_by.name || m.pending_somebody({}, options) }, options)}</span
          >
        {/if}
        {#if conflicts.includes(entry.key)}
          <span class="badge badge-danger">{m.pending_changed_repository({}, options)}</span>
          <button
            class="btn btn-sm"
            type="button"
            disabled={busy || discarding}
            aria-label={m.pending_resolve_entry({ title: named(entry) }, options)}
            onclick={() => (resolving = entry)}
          >{m.pending_resolve({}, options)}</button>
        {:else if unready.includes(entry.key)}
          <span class="badge badge-danger">{m.pending_not_ready({}, options)}</span>
        {:else if drifted.includes(entry.key)}
          <span class="badge badge-danger">{m.pending_languages_disagree({}, options)}</span>
        {/if}
      </div>
      <div class="change-sub">
        {m.pending_file_count({ count: entry.files.length }, options)}
        <span class="sep" aria-hidden="true">·</span>
        {m.pending_edited({ date: formatFieldTime(entry.updated_at, uiLocale) }, options)}
      </div>
      <div class="change-actions">
        {#if conflicts.includes(entry.key)}
          <button
            class="btn btn-sm"
            type="button"
            disabled={busy || discarding}
            aria-label={m.pending_discard_entry({ title: named(entry) }, options)}
            onclick={() => askDiscard(entry)}
          >{m.pending_discard({}, options)}</button>
        {/if}
        <button
          class="btn btn-ghost btn-icon"
          type="button"
          aria-expanded={opened === entry.key}
          aria-label={m.pending_what_changed({ title: named(entry) }, options)}
          onclick={() => open(entry)}
        >{opened === entry.key ? '▾' : '▸'}</button>
      </div>
    </div>
    {#if opened === entry.key}
      {@const shown = changes[entry.key]}
      {#if shown}
        <div class="change-diff">
          <Diff groups={shown.groups} {mediaBase} {uiLocale} />
          {#if shown.redirects.length}
            <h4>{m.pending_riding_along({}, options)}</h4>
            <div class="diff">
              {#each shown.redirects as rule (rule.from)}
                <div class="row is-block">
                  <small>{m.pending_redirect({}, options)}</small>
                  <code>{rule.from}</code>
                  <span aria-hidden="true">→</span>
                  <code>{rule.to}</code>
                  <span class="sub">{m.pending_redirect_reason({}, options)}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="change-diff"><p class="foot-note" role="status">
          {reading === entry.key
            ? m.pending_reading_changes({}, options)
            : m.pending_nothing_to_show({}, options)}
        </p></div>
      {/if}
    {/if}
  </li>
{/snippet}

<Modal
  labelledby="pending-h"
  panelClass="drawer"
  scrimClass={closing ? 'is-right pending-scrim is-closing' : 'is-right pending-scrim'}
  dismissible={!busy && !discarding && !closing}
  bind:panel
  onclose={resolving ? closeResolver : onclose}
>
    <header class="drawer-head">
      <div class="head-row">
        <h2 id="pending-h">{m.pending_title({}, options)}</h2>
        <button
          class="btn btn-ghost btn-icon"
          type="button"
          aria-label={m.pending_close({}, options)}
          disabled={busy || discarding}
          onclick={resolving ? closeResolver : onclose}
        >✕</button>
      </div>
      {#if entries.length}
        <p class="drawer-meta">
          <span class="count">{m.pending_change_count({ count: entries.length }, options)}</span>
          <span class="sep" aria-hidden="true">·</span> {m.pending_selected_count({ count: selected.length }, options)}
          {#if conflicts.length}
            <span class="sep" aria-hidden="true">·</span> {m.pending_conflict_count({ count: conflicts.length }, options)}
          {/if}
          {#if held.length}
            <span class="sep" aria-hidden="true">·</span>
            {m.pending_hold_count({ count: held.filter((e) => !checked(e)).length }, options)}
          {/if}
        </p>
        <p class="drawer-meta is-summary">{summary}</p>
        <div class="drawer-tools">
          <span>{m.pending_select({}, options)}</span>
          <button class="btn-link" type="button" disabled={busy} aria-label={m.pending_select_all_label({}, options)} onclick={selectAll}>{m.pending_all({}, options)}</button>
          <span class="sep" aria-hidden="true">·</span>
          <button class="btn-link" type="button" disabled={busy} aria-label={m.pending_select_none_label({}, options)} onclick={selectNone}>{m.pending_none({}, options)}</button>
        </div>
      {:else}
        <p class="drawer-meta">{m.pending_nothing_to_publish({}, options)}</p>
      {/if}
    </header>
    <div class="drawer-body">
      {#if resolving}
        <!-- In place of the list, not over it: the rows behind it are not answers to anything. -->
        <Resolve
          entry={resolving.key}
          title={named(resolving)}
          updated={resolving.updated_at}
          {uiLocale}
          onclose={closeResolver}
          onresolved={() => resolving && resolved(resolving)}
        />
      {:else if entries.length}
        <!-- A hold left behind keeps the drawer open, so the commit is also named here. -->
        {#if published}
          <div class="publish-result">
            <h3>{m.pending_published_count({ count: published }, options)}</h3>
            <p>{m.pending_commit_on_way({}, options)}</p>
            {@render result()}
          </div>
        {/if}
        <ul class="change-list">
          {#each ready as entry (entry.key)}{@render change(entry)}{/each}
        </ul>
        {#if checksFailed || groups.length || elsewhere.length}
          <section class="checks" aria-labelledby="checks-h">
            <h3 class="group-title" id="checks-h">{m.pending_checks({}, options)}</h3>
            {#if checksFailed}
              <p class="checks-sum" role="status">
                {m.pending_checks_failed({}, options)}
              </p>
            {:else}
              <p class="checks-sum">
                {m.pending_checks_summary(
                  { verdict: verdict(lines, uiLocale), count: selected.length },
                  options,
                )}
              </p>
              {#each groups as group (group.entry.key)}
                <div class="check-group">
                  <h4>{named(group.entry)} <span class="badge">{capitalise(collectionName(group.entry.collection, uiLocale))}</span></h4>
                  <CheckLines lines={group.items} chips={group.entry.locales.length > 1} {uiLocale} {goTo} {onclose} />
                </div>
              {/each}
              {#if elsewhere.length}
                <div class="check-group">
                  <h4>{m.pending_elsewhere({}, options)}</h4>
                  {#each elsewhere as item (item.path + item.fieldPath + item.check)}
                    <div class="notice notice-{TINT[item.severity]}">
                      <span class="sev">{severityLabel(item.severity, uiLocale)}</span>
                      <span class="msg">{item.message}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            {/if}
          </section>
        {/if}
        {#if held.length}
          <div class="change-group">
            <h3 class="group-title">{published ? m.pending_still_on_hold({}, options) : m.pending_on_hold({}, options)}</h3>
            <ul class="change-list">
              {#each held as entry (entry.key)}{@render change(entry)}{/each}
            </ul>
            {#if held.some(checked)}
              <div class="notice notice-warn">
                {m.pending_hold_release_warning({}, options)}
              </div>
            {:else}
              <p class="foot-note">
                {m.pending_hold_guidance({}, options)}
              </p>
            {/if}
          </div>
        {/if}
      {:else}
        <div class="empty">
          <div>
            <h2>{published ? m.pending_published_count({ count: published }, options) : m.pending_everything_published({}, options)}</h2>
            <p>
              {published
                ? m.pending_commit_on_way({}, options)
                : m.pending_every_edit_published({}, options)}
            </p>
            {#if published}{@render result()}{/if}
          </div>
        </div>
      {/if}
    </div>
    {#if entries.length}
      <footer class="drawer-foot">
        {#if error}<div class="notice notice-danger" role="alert">{errorText}</div>{/if}
        {#if busy}<div class="notice notice-info" role="status">{m.pending_publishing_count({ count: selected.length }, options)}</div>{/if}
        <div class="foot-row">
          <button
            class="btn btn-primary"
            type="button"
            disabled={busy || discarding || Boolean(resolving) || !selected.length || errors.length > 0}
            onclick={publish}
          >
            {#if busy}{m.pending_publishing({}, options)}
            {:else if errors.length}{m.pending_fix_errors({ count: errors.length }, options)}
            {:else if !selected.length}{m.pending_publish({}, options)}
            {:else if warnings.length}{m.pending_publish_anyway({ count: warnings.length }, options)}
            {:else}{m.pending_publish_count({ count: selected.length }, options)}{/if}
          </button>
        </div>
        <p class="foot-note">
          {#if resolving}
            {m.pending_waits_for_conflict({}, options)}
          {:else if !ready.length}
            {m.pending_everything_on_hold({}, options)}
          {:else if !selected.length && ready.every((e) => blocked.includes(e.key))}
            {m.pending_everything_blocked({}, options)}
          {:else if !selected.length}
            {m.pending_nothing_selected({}, options)}
          {:else if blocked.length}
            {m.pending_some_blocked({}, options)}
          {:else}
            {m.pending_publish_explanation({}, options)}
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
      <h2 id="discard-h">{m.pending_discard_question({ title: named(confirming) }, options)}</h2>
      <p>
        {m.pending_discard_explanation({}, options)}
      </p>
      <div class="actions">
        <button class="btn" type="button" disabled={discarding} onclick={() => (confirming = undefined)}>{m.common_cancel({}, options)}</button>
        <button class="btn btn-danger" type="button" disabled={discarding} onclick={discard}>
          {discarding ? m.pending_discarding({}, options) : m.pending_discard_changes({}, options)}
        </button>
      </div>
  </Modal>
{/if}
