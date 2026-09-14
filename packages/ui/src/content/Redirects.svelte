<script lang="ts">
import { type Pickable, readEntryDirectory } from '../entry-directory.js';
import { messageText, responseMessage, type UiMessage } from '../errors.js';
import { languageTag, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, sitePath } from '../request.js';
import Modal from '../shared/Modal.svelte';
import PagePicker from './PagePicker.svelte';

let {
  uiLocale = 'en',
  oncommitted,
}: { uiLocale?: UiLocale; oncommitted?: () => void | Promise<void> } = $props();
const options = $derived(messageOptions(uiLocale));
const errorText = (message: UiMessage) =>
  [
    messageText(message, uiLocale),
    message.detail ? m.common_technical_detail({ detail: message.detail }, options) : '',
  ]
    .filter(Boolean)
    .join(' ');

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
let rulesKnown = $state(false);
let readError = $state<UiMessage>();
let error = $state<UiMessage>();
let knownCurrent = $state(false);
let knownError = $state(false);
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
let bad = $state<{ field: 'from' | 'to'; message: UiMessage }>();
let saving = $state(false);
let dropping = $state<Rule>();
let trigger = $state<HTMLElement>();

$effect(() => {
  void load();
  void loadDirectory();
});

async function load() {
  loading = true;
  readError = undefined;
  const res = await fetch('/admin/api/redirects');
  loading = false;
  if (!res.ok) {
    readError = await responseMessage(res, 'REDIRECT_LOAD_FAILED');
    return;
  }
  rules = ((await res.json()) as { rules?: Rule[] }).rules ?? [];
  rulesKnown = true;
}

async function loadDirectory() {
  knownError = false;
  try {
    known = await readEntryDirectory();
    knownCurrent = true;
  } catch {
    knownCurrent = false;
    knownError = true;
  }
}

const reasonLabel = (reason: Rule['reason']) =>
  ({
    'slug-change': m.redirect_reason_slug_change,
    hidden: m.redirect_reason_hidden,
    deleted: m.redirect_reason_deleted,
    manual: m.redirect_reason_manual,
  })[reason]({}, options);
const when = (value: string) =>
  new Intl.DateTimeFormat(languageTag(uiLocale), {
    day: 'numeric',
    month: 'short',
  }).format(Date.parse(value));

// The whole file is on screen, so unlike the media library the search is over what is loaded.
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

// The destination is picked in the old address's language, since that is the reader sent on.
const toLocale = $derived(
  (known.locales ?? []).find(
    (l) => writing?.from === `/${l}` || writing?.from.startsWith(`/${l}/`),
  ) ??
    known.defaultLocale ??
    known.locales[0] ??
    '',
);
// A rule already pointing at the claimed address will be re-pointed, which the client should hear.
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
    await oncommitted?.();
    return;
  }
  const body = (await res.json().catch(() => ({}))) as {
    field?: string;
    message?: string;
    error?: string;
    code?: string;
    descriptor?: UiMessage;
  };
  bad =
    body.field === 'to' || body.field === 'from'
      ? {
          field: body.field,
          message: body.descriptor ?? {
            code: 'REDIRECT_SAVE_FAILED',
            status: res.status,
            ...(body.message ? { detail: body.message } : {}),
          },
        }
      : {
          field: 'from',
          message: {
            code: body.code ?? 'REDIRECT_SAVE_FAILED',
            status: res.status,
            ...(!body.code && body.error ? { detail: body.error } : {}),
          },
        };
}

/** What the live site said about one rule's old address; no verdict while it is being asked. */
type Verdict = {
  kind: 'ok' | 'wait' | 'bad' | 'unknown';
  line: string;
  code: 'unknown' | 'elsewhere' | 'bad-status' | 'working' | 'waiting' | 'page';
  status?: number;
};
const verdictLabel = (kind: Verdict['kind']) =>
  ({
    ok: m.redirect_verdict_working,
    wait: m.redirect_verdict_waiting,
    bad: m.redirect_verdict_mismatch,
    unknown: m.redirect_verdict_unknown,
  })[kind]({}, options);
const verdictText = (verdict: Verdict) => {
  if (verdict.code === 'elsewhere') return m.redirect_probe_elsewhere({}, options);
  if (verdict.code === 'bad-status')
    return m.redirect_probe_bad_status({ status: verdict.status ?? 0 }, options);
  if (verdict.code === 'working') return m.redirect_probe_working({}, options);
  if (verdict.code === 'waiting') return m.redirect_probe_waiting({}, options);
  if (verdict.code === 'page') return m.redirect_probe_page({}, options);
  return m.redirect_probe_unknown({}, options);
};
let tested = $state<{ id: string; verdict?: Verdict }>();
const trimmed = (path: string) => path.replace(/\/+$/, '');
const lands = (rule: Rule, at: string) => {
  const to = new URL(rule.to, location.origin);
  const there = new URL(at);
  return (
    there.origin === to.origin &&
    trimmed(there.pathname) === trimmed(to.pathname) &&
    there.search === to.search
  );
};

// Asked of the live site, cache bypassed: the file is only live after a publish and a build.
async function probe(rule: Rule): Promise<Verdict> {
  const unverified: Verdict = {
    kind: 'unknown',
    line: `${rule.from} → no answer`,
    code: 'unknown',
  };
  let res: Response;
  try {
    res = await fetch(rule.from, { cache: 'no-store' });
  } catch {
    return unverified;
  }
  if (res.type === 'opaque') return unverified;
  if (res.redirected) {
    const landed = new URL(res.url);
    const shown =
      landed.origin === location.origin ? `${landed.pathname}${landed.search}` : landed.href;
    if (!lands(rule, res.url))
      return {
        kind: 'bad',
        line: `${rule.from} → ${shown}`,
        code: 'elsewhere',
      };
    if (res.status >= 400)
      return {
        kind: 'bad',
        line: `${rule.from} → ${shown} → ${res.status}`,
        code: 'bad-status',
        status: res.status,
      };
    return {
      kind: 'ok',
      line: `${rule.from} → ${shown}`,
      code: 'working',
    };
  }
  if (res.status === 404)
    return {
      kind: 'wait',
      line: `${rule.from} → 404`,
      code: 'waiting',
    };
  return {
    kind: 'bad',
    line: `${rule.from} → ${res.status} (no redirect)`,
    code: 'page',
  };
}

// Busy rather than disabled: a disabled button drops the focus to the top of the page.
async function test(rule: Rule) {
  if (tested?.id === rule._id && !tested.verdict) return;
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
    error = await responseMessage(res, 'REDIRECT_DELETE_FAILED');
    return;
  }
  await load();
  await oncommitted?.();
}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && tested && (tested = undefined)} />

<main class="main main-editor">
  <header class="entry-header">
    <div class="crumbs">
      <a href={sitePath(`/admin/site`)}>{m.globals_title({}, options)}</a><span class="sep" aria-hidden="true">/</span><span
        >{m.redirect_title({}, options)}</span
      >
    </div>
    <div class="title-row"><h1>{m.redirect_title({}, options)}</h1></div>
    <p class="subline">
      {m.redirect_intro({}, options)}
    </p>
  </header>
  <div class="entry-body">
    <div class="redirects">
      {#if error}<p class="notice notice-danger" role="alert">{errorText(error)}</p>{/if}
      {#if readError}
        <div class="notice notice-danger redirects-read-error" role="alert">
          {errorText(readError)}{rulesKnown ? ` ${m.redirect_last_result({}, options)}` : ''}
          <button class="btn-link" type="button" onclick={load}>{m.common_retry({}, options)}</button>
        </div>
      {/if}
      {#if waiting}
        <div class="notice notice-info">
          {m.redirect_pending({ count: waiting }, options)}
        </div>
      {/if}
      <div class="list-toolbar">
        <div class="search field">
          <label class="visually-hidden" for="rd-q">{m.redirect_search({}, options)}</label>
          <input
            class="input"
            id="rd-q"
            type="search"
            placeholder={m.redirect_search({}, options)}
            bind:value={query}
          />
        </div>
        <div class="filters">
          <label class="visually-hidden" for="rd-reason">{m.redirect_reason({}, options)}</label>
          <select class="filter" class:is-on={reason} id="rd-reason" bind:value={reason}>
            <option value="">{m.redirect_every_reason({}, options)}</option>
            {#each ['slug-change', 'hidden', 'deleted', 'manual'] as key (key)}
              <option value={key}>{reasonLabel(key as Rule['reason'])}</option>
            {/each}
          </select>
        </div>
        {#if rules.length}
          <span class="tally"
            >{shown.length === rules.length
              ? m.redirect_rule_count({ count: rules.length }, options)
              : m.redirect_filtered_count({ shown: shown.length, count: rules.length }, options)}</span
          >
        {/if}
        <span class="spacer"></span>
        <button class="btn btn-primary" type="button" onclick={() => open()}>{m.redirect_add({}, options)}</button>
      </div>
      {#if loading && !rulesKnown}
        <p class="placeholder">{m.common_loading({}, options)}</p>
      {:else if readError && !rulesKnown}
        <p class="placeholder">{m.redirect_unavailable({}, options)}</p>
      {:else if shown.length}
        <div class="table is-redirects" role="table" aria-label={m.redirect_title({}, options)}>
          <div class="row-head" role="row">
            <div class="th" role="columnheader">{m.redirect_column_redirect({}, options)}</div>
            <div class="th" role="columnheader">{m.redirect_reason({}, options)}</div>
            <div class="th" role="columnheader">{m.redirect_column_added({}, options)}</div>
            <div class="th" role="columnheader"><span class="visually-hidden">{m.redirect_actions({}, options)}</span></div>
          </div>
          {#each shown as rule (rule._id)}
            {@const asking = tested?.id === rule._id}
            {@const verdict = asking ? tested?.verdict : undefined}
            <div class="row" class:is-managed={managed(rule)} class:has-verdict={verdict} role="row">
              <div class="td route" role="cell">
                <div class="hop">
                  <span class="from">{rule.from}</span>
                  {#if rule.pending}<span class="badge badge-accent">{m.redirect_not_published({}, options)}</span>{/if}
                </div>
                <div class="hop is-to">
                  <span class="arrow" aria-hidden="true">↳</span><span class="visually-hidden">{m.redirect_to({}, options)}</span>
                  <span class="to">{rule.to}</span>
                  <span class="badge code" class:is-temp={rule.status === 302}
                    >{rule.status === 302 ? m.redirect_temporary({}, options) : rule.status}</span
                  >
                </div>
              </div>
              <div class="td why" role="cell">
                <span class="badge">{reasonLabel(rule.reason)}</span>
                {#if rule.entry}
                  <a class="owner" href={sitePath(`/admin/c/${rule.entry}`)}>{rule.title ?? rule.entry}</a>
                {/if}
                {#if managed(rule)}
                  <span class="lock-note" id="owns-{rule._id}"
                    >{m.redirect_managed_by({ title: rule.title ?? m.redirect_the_entry({}, options) }, options)}</span
                  >
                {/if}
              </div>
              <div class="td num" role="cell" data-label={m.redirect_column_added({}, options)}>
                {when(rule.createdAt)}
              </div>
              <div class="td menu-cell" role="cell">
                <div class="row-menu">
                  <button
                    class="btn btn-ghost btn-sm btn-test"
                    type="button"
                    aria-busy={asking && !verdict ? 'true' : undefined}
                    onclick={() => test(rule)}
                    >{asking && !verdict ? m.redirect_testing({}, options) : m.redirect_test({}, options)}<span class="visually-hidden">
                      {rule.from}</span
                    ></button
                  >
                  <!-- aria-disabled, not disabled: a disabled button would skip the reason. -->
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    aria-disabled={managed(rule) ? 'true' : undefined}
                    aria-describedby={managed(rule) ? `owns-${rule._id}` : undefined}
                    onclick={() => !managed(rule) && open(rule)}
                    >{m.redirect_edit({}, options)}<span class="visually-hidden"> {rule.from}</span></button
                  >
                  <button
                    class="btn btn-ghost btn-sm btn-delete"
                    type="button"
                    aria-disabled={managed(rule) ? 'true' : undefined}
                    aria-describedby={managed(rule) ? `owns-${rule._id}` : undefined}
                    onclick={() => {
                      if (managed(rule)) return;
                      trigger = document.activeElement as HTMLElement;
                      dropping = rule;
                    }}>{m.redirect_delete({}, options)}<span class="visually-hidden"> {rule.from}</span></button
                  >
                </div>
              </div>
              <!-- The verdict sits under its row rather than floating over the next one. -->
              {#if verdict}
                <div class="td verdict-cell" role="cell" aria-colspan="4">
                  <div class="test-pop is-{verdict.kind}" role="status">
                    <p class="verdict is-{verdict.kind}">{verdictLabel(verdict.kind)}</p>
                    <p class="line">{verdict.line}</p>
                    <p>{verdictText(verdict)}</p>
                    <div class="actions">
                      <a
                        class="btn btn-ghost btn-sm open-address"
                        href={rule.from}
                        target="_blank"
                        rel="noreferrer">{m.redirect_open_old({}, options)} ↗</a
                      >
                      <button class="btn btn-sm" type="button" onclick={() => test(rule)}>{m.redirect_test_again({}, options)}</button>
                      <button class="btn btn-ghost btn-sm" type="button" onclick={() => (tested = undefined)}>{m.redirect_close({}, options)}</button>
                    </div>
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {:else if rules.length}
        <p class="placeholder">{m.redirect_no_matches({}, options)}</p>
      {:else}
        <div class="empty">
          <div>
            <h2>{m.redirect_empty_title({}, options)}</h2>
            <p>{m.redirect_empty_intro({}, options)}</p>
          </div>
        </div>
      {/if}
    </div>
  </div>
</main>

{#if writing}
  <Modal
    labelledby="rd-h"
    panelClass="dialog is-wide"
    initialFocus="#rd-from"
    returnTo={trigger}
    dismissible={!saving}
    onclose={close}
  >
      <h2 id="rd-h">{writing.id ? m.redirect_edit_title({}, options) : m.redirect_add_title({}, options)}</h2>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {#if knownError && writing.kind === 'page'}
          <div class="notice notice-danger redirect-directory-error" role="alert">
            {m.redirect_directory_failed({}, options)}
            <button class="btn-link" type="button" onclick={loadDirectory}>{m.common_retry({}, options)}</button>
          </div>
        {/if}
        <div class="field" class:is-invalid={bad?.field === 'from'}>
          <div class="label-row"><label for="rd-from">{m.redirect_old_address({}, options)}</label></div>
          <input
            class="input"
            id="rd-from"
            type="text"
            bind:value={writing.from}
            aria-invalid={bad?.field === 'from' ? 'true' : undefined}
            aria-describedby={bad?.field === 'from' ? 'rd-from-e' : 'rd-from-hint'}
          />
          {#if bad?.field === 'from'}
            <p class="error" id="rd-from-e">{bad.message.detail ?? messageText(bad.message, uiLocale)}</p>
          {:else}
            <p class="hint" id="rd-from-hint">
              {m.redirect_old_address_hint({}, options)}
            </p>
          {/if}
        </div>
        <fieldset>
          <legend>{m.redirect_send_to({}, options)}</legend>
          <label class="choice">
            <input type="radio" name="rd-kind" value="page" bind:group={writing.kind} />
            {m.redirect_page_destination({}, options)}
          </label>
          {#if writing.kind === 'page'}
            <PagePicker
              id="rd-pick"
              label="pages and entries"
              labelKind="pages-and-entries"
              labelId="rd-h"
              {uiLocale}
              locale={toLocale}
              chosen={known.entries.find((e) => e.urls[toLocale] === writing?.to)?.path}
              onpick={(entry) => {
                if (writing) writing.to = entry.urls[toLocale] ?? '';
              }}
            />
          {/if}
          <label class="choice">
            <input type="radio" name="rd-kind" value="url" bind:group={writing.kind} />
            {m.redirect_web_destination({}, options)}
          </label>
          {#if writing.kind === 'url'}
            <div class="field">
              <div class="label-row"><label for="rd-url">{m.redirect_web_address({}, options)}</label></div>
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
          <!-- A picked page is an address like any other, so the rule is shown as it will read. -->
          <p class="hint">
            {m.redirect_visitors_go_to({ destination: writing.to || '…' }, options)}
          </p>
          {#if bad?.field === 'to'}<p class="error" id="rd-to-e">{bad.message.detail ?? messageText(bad.message, uiLocale)}</p>{/if}
        </fieldset>
        <!-- A fieldset: a <label> naming no control is a label a screen reader drops. -->
        <fieldset>
          <legend>{m.redirect_permanence({}, options)}</legend>
          <label class="choice">
            <input type="radio" name="rd-code" value={301} bind:group={writing.status} />
            {m.redirect_permanent({}, options)} <span class="desc">301</span>
          </label>
          <label class="choice">
            <input type="radio" name="rd-code" value={302} bind:group={writing.status} />
            {m.redirect_temporary_choice({}, options)} <span class="desc">302</span>
          </label>
        </fieldset>
        {#if chained}
          <div class="notice notice-info">
            <b>{m.redirect_already_covered({}, options)}</b>
            {m.redirect_chain_explanation({ address: chained.from }, options)}
          </div>
        {/if}
        <div class="actions">
          <button class="btn" type="button" disabled={saving} onclick={close}>{m.common_cancel({}, options)}</button>
          <button
            class="btn btn-primary"
            type="submit"
            disabled={saving || (writing.kind === 'page' && !knownCurrent)}
          >
            {saving ? m.redirect_saving({}, options) : writing.id ? m.redirect_save({}, options) : m.redirect_add({}, options)}
          </button>
        </div>
      </form>
  </Modal>
{/if}

{#if dropping}
  <Modal
    labelledby="rd-del-h"
    describedby="rd-del-d"
    role="alertdialog"
    returnTo={trigger}
    dismissible={!saving}
    onclose={close}
  >
      <h2 id="rd-del-h">{m.redirect_delete_question({}, options)}</h2>
      <div id="rd-del-d">
        <p><code>{dropping.from}</code> → <code>{dropping.to}</code></p>
        {#if young(dropping)}
          <div class="notice notice-warn">
            {m.redirect_delete_warning({ count: months(dropping) }, options)}
          </div>
        {/if}
      </div>
      <div class="actions">
        <button class="btn" type="button" disabled={saving} onclick={close}>{m.redirect_keep({}, options)}</button>
        <button class="btn btn-danger" type="button" disabled={saving} onclick={remove}
          >{saving ? m.redirect_deleting({}, options) : m.redirect_delete_anyway({}, options)}</button
        >
      </div>
  </Modal>
{/if}
