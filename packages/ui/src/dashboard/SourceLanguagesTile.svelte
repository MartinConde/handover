<script lang="ts" module>
export type Unrecorded = {
  key: string;
  collection: string;
  title: string;
  href: string;
  source: string;
  locales: string[];
  drafts: boolean;
  stale: { locale: string; from: string }[];
};
export type Recorded = { entries: number; stale: number };
</script>

<script lang="ts">
import { messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch } from '../request.js';
import RecordSourcesDialog from './RecordSourcesDialog.svelte';

let {
  uiLocale = 'en',
  oncommitted,
}: { uiLocale?: UiLocale; oncommitted?: () => void | Promise<void> } = $props();
const options = $derived(messageOptions(uiLocale));

let base = $state('');
let entries = $state.raw<Unrecorded[]>([]);
let open = $state(false);
let recorded = $state<Recorded>();

$effect(() => {
  void load();
});

// Silent on failure: the tile is advice, and Diagnostics says the same count.
async function load() {
  const res = await fetch('/admin/api/sources');
  if (!res.ok) return;
  const body = (await res.json().catch(() => undefined)) as
    | { base?: unknown; entries?: unknown }
    | undefined;
  if (typeof body?.base !== 'string' || !Array.isArray(body.entries)) return;
  base = body.base;
  entries = body.entries as Unrecorded[];
}

async function done(result: Recorded) {
  open = false;
  recorded = result;
  entries = [];
  await oncommitted?.();
}
</script>

{#if recorded || entries.length}
  <section class="dtile span-3 sources-tile" aria-labelledby="d-src">
    <header><h2 id="d-src">{m.sources_title({}, options)}</h2></header>
    {#if recorded}
      <p class="notice notice-success" role="status">
        {m.sources_done({ count: recorded.entries }, options)}{#if recorded.stale}{' '}{m.sources_done_stale({ count: recorded.stale }, options)}{/if}
      </p>
    {:else}
      <p class="line">{m.sources_tile_line({ count: entries.length }, options)}</p>
      <div class="tile-actions">
        <button class="btn btn-primary" type="button" aria-haspopup="dialog" onclick={() => (open = true)}>
          {m.sources_review({}, options)}
        </button>
      </div>
    {/if}
  </section>
{/if}

{#if open}
  <RecordSourcesDialog {base} {entries} {uiLocale} onclose={() => (open = false)} onreload={load} ondone={done} />
{/if}
