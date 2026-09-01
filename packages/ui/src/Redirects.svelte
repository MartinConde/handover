<script lang="ts">
import PagePicker, { type Pickable, readPickable } from './PagePicker.svelte';

/** One rule as `/admin/api/redirects` answers it. */
interface Rule {
  _id: string;
  from: string;
  to: string;
  status: 301 | 302;
  reason: 'slug-change' | 'hidden' | 'deleted' | 'manual';
  /** The entry that owns it, for the rules the pipeline wrote. */
  entry?: string;
  createdAt: string;
  /** What that entry is called, resolved by the server so the column reads as a page. */
  title?: string;
  /** Riding on an entry's draft: the only rules here that are not in the repository yet. */
  pending?: true;
}

let rules = $state<Rule[]>([]);
let known = $state<Pickable>({ entries: [], locales: [] });
let loading = $state(true);
let error = $state('');
let query = $state('');
let reason = $state('');
/** The rule being written; nothing when neither dialog is open. */
let writing = $state<{
  id?: string;
  from: string;
  to: string;
  status: 301 | 302;
  kind: 'page' | 'url';
}>();
let bad = $state<{ field: 'from' | 'to'; message: string }>();
let saving = $state(false);
let dropping = $state<Rule>();
let opening = $state<HTMLElement>();
let trigger: HTMLElement | undefined;

$effect(() => {
  load();
  readPickable().then((p) => (known = p));
});

$effect(() => {
  opening?.focus();
});

async function load() {
  const res = await fetch('/admin/api/redirects');
  loading = false;
  if (!res.ok) {
    error = res.status === 503 ? await res.text() : `Could not load the redirects (${res.status}).`;
    return;
  }
  error = '';
  rules = ((await res.json()) as { rules?: Rule[] }).rules ?? [];
}

const REASONS = {
  'slug-change': 'Slug change',
  hidden: 'Hidden',
  deleted: 'Deleted',
  manual: 'Manual',
} as const;
const WHEN = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

// The whole file is on screen, so the search is over what is loaded: unlike the media library
// there is no next page for a match to be hiding on.
const shown = $derived(
  rules.filter((rule) => {
    const q = query.trim().toLowerCase();
    return (
      (!reason || rule.reason === reason) &&
      (!q || rule.from.toLowerCase().includes(q) || rule.to.toLowerCase().includes(q))
    );
  }),
);
const waiting = $derived(rules.filter((rule) => rule.pending).length);

/** A hidden entry's rule is the entry's: unhiding takes it out, so this screen does not. */
const managed = (rule: Rule) => rule.reason === 'hidden';
const YEAR = 365 * 24 * 60 * 60 * 1000;
const months = (rule: Rule) =>
  Math.max(1, Math.round((Date.now() - Date.parse(rule.createdAt)) / (30.44 * 24 * 3600 * 1000)));
const young = (rule: Rule) => Date.now() - Date.parse(rule.createdAt) < YEAR;

// Which language the destination is picked in: the one the old address is under, since that is
// the reader being sent on. A path with no segment of its own is the site's default language.
const toLocale = $derived(
  (known.locales ?? []).find(
    (l) => writing?.from === `/${l}` || writing?.from.startsWith(`/${l}/`),
  ) ??
    known.defaultLocale ??
    known.locales[0] ??
    '',
);
// A rule already pointing at the address being claimed will be pointed at the new one instead,
// which the client would otherwise see change and not know why.
const chained = $derived(
  writing ? rules.find((r) => r.to === writing?.from && r._id !== writing?.id) : undefined,
);

function open(rule?: Rule) {
  trigger = (document.activeElement as HTMLElement | null) ?? undefined;
  bad = undefined;
  writing = rule
    ? {
        id: rule._id,
        from: rule.from,
        to: rule.to,
        status: rule.status,
        kind: rule.to.startsWith('/') ? 'page' : 'url',
      }
    : { from: '', to: '', status: 301, kind: 'page' };
}

function close() {
  writing = undefined;
  dropping = undefined;
  trigger?.focus();
}

async function save() {
  if (!writing) return;
  saving = true;
  const res = await fetch(
    writing.id ? `/admin/api/redirects/${writing.id}` : '/admin/api/redirects',
    {
      method: writing.id ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: writing.from, to: writing.to, status: writing.status }),
    },
  );
  saving = false;
  if (res.ok) {
    close();
    await load();
    return;
  }
  const body = (await res.json().catch(() => ({}))) as {
    field?: string;
    message?: string;
    error?: string;
  };
  bad =
    body.field === 'to' || body.field === 'from'
      ? { field: body.field, message: body.message ?? '' }
      : { field: 'from', message: body.error ?? `That was not saved (${res.status}).` };
}

/** What the live site said about one rule's old address; no verdict while it is being asked. */
type Verdict = { kind: 'ok' | 'wait' | 'bad'; line: string; text: string };
const VERDICT = { ok: 'Working', wait: 'Not there yet', bad: 'Not what this rule says' };
let tested = $state<{ id: string; verdict?: Verdict }>();
const trimmed = (path: string) => path.replace(/\/+$/, '');
const lands = (rule: Rule, at: string) => {
  const to = new URL(rule.to, location.origin);
  const there = new URL(at);
  return there.origin === to.origin && trimmed(there.pathname) === trimmed(to.pathname);
};

// Asked of the live site, from the browser: the file is not the answer, since a rule is live
// only after a publish and a build, and between the two the table is right while the site is
// not. The redirect is followed and where it ended up is the verdict — a status code alone would
// not say whether the rule ran, and the browser cache is bypassed so a rule changed today is not
// answered by the 301 it cached last week.
async function probe(rule: Rule): Promise<Verdict> {
  let res: Response;
  try {
    res = await fetch(rule.from, { cache: 'no-store' });
  } catch {
    // Following a redirect off this site is a request to another origin, which the browser
    // will not show this page. For a rule that points off the site, that is the rule working.
    return rule.to.startsWith('/')
      ? {
          kind: 'wait',
          line: `${rule.from} → no answer`,
          text: 'The site could not be reached just now. Try again in a moment.',
        }
      : {
          kind: 'ok',
          line: `${rule.from} → ${rule.to}`,
          text: 'Asked the live site just now: the old address sends visitors off this site, where this rule points.',
        };
  }
  if (res.redirected) {
    const landed = new URL(res.url);
    const shown = landed.origin === location.origin ? landed.pathname : landed.href;
    if (!lands(rule, res.url))
      return {
        kind: 'bad',
        line: `${rule.from} → ${shown}`,
        text: "The old address forwards, but somewhere else. Another rule may cover it, or the site's own routing does.",
      };
    if (res.status >= 400)
      return {
        kind: 'bad',
        line: `${rule.from} → ${shown} → ${res.status}`,
        text: `Visitors are sent where this rule says, but that page answers ${res.status}. Point the rule at a page that exists.`,
      };
    return {
      kind: 'ok',
      line: `${rule.from} → ${shown}`,
      text: 'Asked the live site just now and followed it. Visitors on the old address land where this rule points.',
    };
  }
  if (res.status === 404)
    return {
      kind: 'wait',
      line: `${rule.from} → 404`,
      text: 'This rule has not been published, or the site is still building. Try again when the build finishes.',
    };
  return {
    kind: 'bad',
    line: `${rule.from} → ${res.status} (no redirect)`,
    text: 'A real page answers at this address, so the redirect never runs. That usually means a page was added at the old address after the rule was written.',
  };
}

async function test(rule: Rule) {
  tested = { id: rule._id };
  const verdict = await probe(rule);
  if (tested?.id === rule._id) tested = { id: rule._id, verdict };
}

async function remove() {
  const rule = dropping;
  if (!rule) return;
  saving = true;
  const res = await fetch(`/admin/api/redirects/${rule._id}`, { method: 'DELETE' });
  saving = false;
  close();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    error = body.error ?? `That redirect was not deleted (${res.status}).`;
    return;
  }
  await load();
}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && tested && (tested = undefined)} />

<main class="main main-editor">
  <header class="entry-header">
    <div class="crumbs">
      <a href="/admin/site">Site settings</a><span class="sep" aria-hidden="true">/</span><span
        >Redirects</span
      >
    </div>
    <div class="title-row"><h1>Redirects</h1></div>
    <p class="subline">
      Old addresses that forward to new ones. One list for the whole site — a redirect is a path,
      not a language. A rule you add here is saved straight away and reaches visitors when the
      site has finished building.
    </p>
  </header>
  <div class="entry-body">
    <div class="redirects">
      {#if error}<p class="notice notice-danger" role="alert">{error}</p>{/if}
      {#if waiting}
        <div class="notice notice-info">
          {waiting === 1 ? 'One rule is' : `${waiting} rules are`} not live yet: {waiting === 1
            ? 'it belongs'
            : 'they belong'} to an entry with unpublished changes and {waiting === 1
            ? 'goes'
            : 'go'} out when you publish it.
        </div>
      {/if}
      <div class="list-toolbar">
        <div class="search field">
          <label class="visually-hidden" for="rd-q">Search by address</label>
          <input
            class="input"
            id="rd-q"
            type="search"
            placeholder="Search by address"
            bind:value={query}
          />
        </div>
        <div class="filters">
          <label class="visually-hidden" for="rd-reason">Reason</label>
          <select class="filter" class:is-on={reason} id="rd-reason" bind:value={reason}>
            <option value="">Every reason</option>
            {#each Object.entries(REASONS) as [key, label] (key)}
              <option value={key}>{label}</option>
            {/each}
          </select>
        </div>
        <span class="spacer"></span>
        <button class="btn btn-primary" type="button" onclick={() => open()}>Add redirect</button>
      </div>
      {#if loading}
        <p class="placeholder">Loading…</p>
      {:else if shown.length}
        <div class="table cols-7" role="table" aria-label="Redirects">
          <div class="row-head" role="row">
            <div class="th" role="columnheader">From</div>
            <div class="th" role="columnheader">To</div>
            <div class="th" role="columnheader">Code</div>
            <div class="th" role="columnheader">Reason</div>
            <div class="th" role="columnheader">Entry</div>
            <div class="th" role="columnheader">Added</div>
            <div class="th" role="columnheader"><span class="visually-hidden">Actions</span></div>
          </div>
          {#each shown as rule (rule._id)}
            {@const asking = tested?.id === rule._id}
            <div class="row" class:is-managed={managed(rule)} role="row">
              <div class="td path" role="cell" data-label="From">
                {rule.from}
                {#if rule.pending}<span class="badge badge-accent">Not published yet</span>{/if}
              </div>
              <div class="td path" role="cell" data-label="To">{rule.to}</div>
              <div class="td num" role="cell" data-label="Code">{rule.status}</div>
              <div class="td" role="cell" data-label="Reason">
                <span class="badge">{REASONS[rule.reason]}</span>
              </div>
              <div class="td entry" role="cell" data-label="Entry">
                {#if rule.entry}
                  <a href="/admin/c/{rule.entry}">{rule.title ?? rule.entry}</a>
                {:else}
                  <span class="note">—</span>
                {/if}
                {#if managed(rule)}
                  <span class="lock-note" id="owns-{rule._id}"
                    >managed by {rule.title ?? 'the entry'} — show it again to remove this</span
                  >
                {/if}
              </div>
              <div class="td num" role="cell" data-label="Added">
                {WHEN.format(Date.parse(rule.createdAt))}
              </div>
              <div class="td menu-cell" role="cell">
                <div class="row-menu">
                  <button
                    class="btn btn-sm btn-test"
                    type="button"
                    disabled={asking && !tested?.verdict}
                    onclick={() => test(rule)}
                    >{asking && !tested?.verdict ? 'Testing…' : 'Test'}<span class="visually-hidden">
                      {rule.from}</span
                    ></button
                  >
                  {#if asking && tested?.verdict}
                    <div class="popover test-pop" role="status">
                      <p class="verdict is-{tested.verdict.kind}">{VERDICT[tested.verdict.kind]}</p>
                      <p class="line">{tested.verdict.line}</p>
                      <p>{tested.verdict.text}</p>
                      <div class="actions">
                        <button class="btn btn-sm" type="button" onclick={() => test(rule)}>Test again</button>
                        <button class="btn btn-ghost btn-sm" type="button" onclick={() => (tested = undefined)}>Close</button>
                      </div>
                    </div>
                  {/if}
                  <!-- Greyed with aria-disabled rather than disabled: a disabled button takes no
                       focus, so a keyboard would walk past the reason without hearing it. -->
                  <button
                    class="btn btn-sm"
                    type="button"
                    aria-disabled={managed(rule) ? 'true' : undefined}
                    aria-describedby={managed(rule) ? `owns-${rule._id}` : undefined}
                    onclick={() => !managed(rule) && open(rule)}
                    >Edit<span class="visually-hidden"> {rule.from}</span></button
                  >
                  <button
                    class="btn btn-sm"
                    type="button"
                    aria-disabled={managed(rule) ? 'true' : undefined}
                    aria-describedby={managed(rule) ? `owns-${rule._id}` : undefined}
                    onclick={() => {
                      if (managed(rule)) return;
                      trigger = document.activeElement as HTMLElement;
                      dropping = rule;
                    }}>Delete<span class="visually-hidden"> {rule.from}</span></button
                  >
                </div>
              </div>
            </div>
          {/each}
        </div>
      {:else if rules.length}
        <p class="placeholder">Nothing here matches that.</p>
      {:else}
        <div class="empty">
          <div>
            <h2>No redirects yet</h2>
            <p>
              Renaming a page, hiding one or deleting one adds a rule here on its own, so old
              links keep working. You can also add one by hand — an address from an old brochure,
              or a shortlink for a campaign.
            </p>
          </div>
        </div>
      {/if}
    </div>
  </div>
</main>

<!-- Not aria-modal: the shell behind stays reachable, as it does on the library and on Members,
     and claiming a focus trap that is not there is worse than not claiming one. -->
{#if writing}
  <div class="scrim">
    <div class="dialog is-wide" role="dialog" aria-labelledby="rd-h">
      <h2 id="rd-h">{writing.id ? 'Edit this redirect' : 'Add a redirect'}</h2>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div class="field" class:is-invalid={bad?.field === 'from'}>
          <div class="label-row"><label for="rd-from">Old address</label></div>
          <input
            class="input"
            id="rd-from"
            type="text"
            bind:value={writing.from}
            bind:this={opening}
            aria-invalid={bad?.field === 'from' ? 'true' : undefined}
            aria-describedby={bad?.field === 'from' ? 'rd-from-e' : 'rd-from-hint'}
          />
          {#if bad?.field === 'from'}
            <p class="error" id="rd-from-e">{bad.message}</p>
          {:else}
            <p class="hint" id="rd-from-hint">
              A path on this site, starting with <code>/</code>. Visitors who ask for this get sent
              on.
            </p>
          {/if}
        </div>
        <fieldset>
          <legend>Send them to</legend>
          <label class="choice">
            <input type="radio" name="rd-kind" value="page" bind:group={writing.kind} />
            A page on this site
          </label>
          {#if writing.kind === 'page'}
            <PagePicker
              id="rd-pick"
              label="pages and entries"
              labelId="rd-h"
              locale={toLocale}
              chosen={known.entries.find((e) => e.urls[toLocale] === writing?.to)?.path}
              onpick={(entry) => {
                if (writing) writing.to = entry.urls[toLocale] ?? '';
              }}
            />
          {/if}
          <label class="choice">
            <input type="radio" name="rd-kind" value="url" bind:group={writing.kind} />
            A web address…
          </label>
          {#if writing.kind === 'url'}
            <div class="field">
              <div class="label-row"><label for="rd-url">Web address</label></div>
              <input
                class="input"
                id="rd-url"
                type="text"
                placeholder="https://example.com/brochure.pdf"
                bind:value={writing.to}
                aria-invalid={bad?.field === 'to' ? 'true' : undefined}
                aria-describedby={bad?.field === 'to' ? 'rd-to-e' : undefined}
              />
            </div>
          {/if}
          <!-- What the rule will say, whichever half was used: a picked page is an address like
               any other, and the client is about to publish it. -->
          <p class="hint">
            Visitors go to <code>{writing.to || '…'}</code>
          </p>
          {#if bad?.field === 'to'}<p class="error" id="rd-to-e">{bad.message}</p>{/if}
        </fieldset>
        <!-- A fieldset rather than the mockup's labelled group: two radios are what a legend
             is for, and a <label> naming no control is a label a screen reader drops. -->
        <fieldset>
          <legend>How permanent is this?</legend>
          <label class="choice">
            <input type="radio" name="rd-code" value={301} bind:group={writing.status} />
            It has moved for good <span class="desc">301</span>
          </label>
          <label class="choice">
            <input type="radio" name="rd-code" value={302} bind:group={writing.status} />
            Just for now <span class="desc">302</span>
          </label>
        </fieldset>
        {#if chained}
          <div class="notice notice-info">
            <b>Already covered.</b>
            <code>{chained.from}</code> is forwarded to this address, so that rule will be pointed
            straight at the new one — visitors never make two hops.
          </div>
        {/if}
        <div class="actions">
          <button class="btn" type="button" onclick={close}>Cancel</button>
          <button class="btn btn-primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : writing.id ? 'Save redirect' : 'Add redirect'}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

{#if dropping}
  <div class="scrim">
    <div class="dialog" role="alertdialog" aria-labelledby="rd-del-h" aria-describedby="rd-del-d">
      <h2 id="rd-del-h">Delete this redirect?</h2>
      <div id="rd-del-d">
        <p><code>{dropping.from}</code> → <code>{dropping.to}</code></p>
        {#if young(dropping)}
          <div class="notice notice-warn">
            This rule is {months(dropping)}
            {months(dropping) === 1 ? 'month' : 'months'} old. Search results, other people's links
            and old emails still point at the address it covers, and deleting it turns those into
            “page not found”. A year is roughly how long that traffic takes to die down.
          </div>
        {/if}
      </div>
      <div class="actions">
        <button class="btn" type="button" bind:this={opening} onclick={close}>Keep it</button>
        <button class="btn btn-danger" type="button" disabled={saving} onclick={remove}
          >{saving ? 'Deleting…' : 'Delete anyway'}</button
        >
      </div>
    </div>
  </div>
{/if}
