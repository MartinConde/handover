<script lang="ts">
import { collectionName, formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, sitePath } from '../request.js';
import Modal from '../shared/Modal.svelte';
import type { Recorded, Unrecorded } from './SourceLanguagesTile.svelte';

let {
  base,
  entries,
  uiLocale = 'en',
  onclose,
  onreload,
  ondone,
}: {
  base: string;
  entries: Unrecorded[];
  uiLocale?: UiLocale;
  onclose: () => void;
  onreload: () => Promise<void>;
  ondone: (result: Recorded) => void;
} = $props();
const options = $derived(messageOptions(uiLocale));
const language = (code: string) => formatLanguageName(code, uiLocale);

type Refusal =
  | { code: 'SOURCES_CHANGED' }
  | { code: 'SOURCES_LOCKED'; names: string[] }
  | { code: 'LOST' }
  | { code: 'FAILED'; status: number };
let busy = $state(false);
let refusal = $state<Refusal>();

const bySource = $derived(
  [...new Set(entries.map((e) => e.source))].map((source) => ({
    source,
    count: entries.filter((e) => e.source === source).length,
  })),
);
// One sentence per translation language, the language it was made from and the source.
const stale = $derived.by(() => {
  const groups = new Map<string, { locale: string; from: string; source: string; count: number }>();
  for (const entry of entries)
    for (const { locale, from } of entry.stale) {
      const key = `${locale}:${from}:${entry.source}`;
      const group = groups.get(key) ?? { locale, from, source: entry.source, count: 0 };
      group.count += 1;
      groups.set(key, group);
    }
  return [...groups.values()];
});
const drafted = $derived(entries.filter((e) => e.drafts).length);

async function record(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  refusal = undefined;
  const res = await fetch('/admin/api/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  busy = false;
  if (res.ok) {
    ondone({
      entries: typeof body.entries === 'number' ? body.entries : 0,
      stale: typeof body.stale === 'number' ? body.stale : 0,
    });
    return;
  }
  // A server error can come after the commit, so only a reload can say what happened.
  if (res.status >= 500) refusal = { code: 'LOST' };
  else if (body.code === 'SOURCES_CHANGED') refusal = { code: 'SOURCES_CHANGED' };
  else if (body.code === 'SOURCES_LOCKED')
    refusal = {
      code: 'SOURCES_LOCKED',
      names: Array.isArray(body.held)
        ? body.held.map((h: { name?: unknown }) =>
            typeof h?.name === 'string' && h.name ? h.name : m.dashboard_somebody({}, options),
          )
        : [],
    };
  else refusal = { code: 'FAILED', status: res.status };
}

async function reload() {
  busy = true;
  await onreload();
  busy = false;
  refusal = undefined;
}
</script>

<Modal labelledby="sources-h" panelClass="dialog is-wide source-dialog" dismissible={!busy} {onclose}>
  <h2 id="sources-h">{m.sources_dialog_title({}, options)}</h2>
  <form onsubmit={record}>
    <p>{m.sources_dialog_intro({}, options)}</p>
    <section class="source-effects" aria-labelledby="sources-what">
      <h3 class="group-title" id="sources-what">{m.sources_what({}, options)}</h3>
      <ul>
        {#each bySource as row (row.source)}
          <li>{m.sources_as_now({ count: row.count, language: language(row.source) }, options)}</li>
        {/each}
      </ul>
    </section>
    <details class="source-list">
      <summary>{m.sources_show_entries({ count: entries.length }, options)}</summary>
      <ul class="source-files">
        {#each entries as entry (entry.key)}
          <li>
            <span class="chip" aria-hidden="true">{entry.source.toUpperCase()}</span>
            <a href={sitePath(entry.href)}>{entry.title}</a>
            <span class="desc">{collectionName(entry.collection, uiLocale)} · {entry.locales.map(language).join(', ')}</span>
          </li>
        {/each}
      </ul>
    </details>
    {#each stale as group (`${group.locale}:${group.from}:${group.source}`)}
      <div class="notice notice-warn">
        {m.sources_stale({ count: group.count, locale: language(group.locale), from: language(group.from), source: language(group.source) }, options)}
      </div>
    {/each}
    <p class="hint">
      {#if drafted}{m.sources_drafts({ count: drafted }, options)}{' '}{/if}{m.sources_one_commit({}, options)}
    </p>
    {#if !entries.length}
      <p class="notice notice-success" role="status">{m.sources_none({}, options)}</p>
    {/if}
    {#if refusal}
      <div class="notice notice-danger" role="alert">
        {#if refusal.code === 'SOURCES_CHANGED'}
          {m.sources_changed({}, options)}
        {:else if refusal.code === 'SOURCES_LOCKED'}
          {m.sources_locked({ count: refusal.names.length, names: refusal.names.join(', ') }, options)}
        {:else if refusal.code === 'LOST'}
          {m.sources_lost({}, options)}
        {:else}
          {m.sources_failed({ status: refusal.status }, options)}
        {/if}
        {#if refusal.code !== 'FAILED'}
          <button class="btn-link" type="button" disabled={busy} onclick={reload}>
            {refusal.code === 'LOST' ? m.sources_reload({}, options) : m.sources_review_again({}, options)}
          </button>
        {/if}
      </div>
    {/if}
    <div class="actions">
      <button class="btn" type="button" disabled={busy} onclick={onclose}>{m.common_cancel({}, options)}</button>
      <button class="btn btn-primary" type="submit" disabled={busy || Boolean(refusal) || !entries.length}>
        {busy ? m.sources_recording({}, options) : m.sources_record({ count: entries.length }, options)}
      </button>
    </div>
  </form>
</Modal>
