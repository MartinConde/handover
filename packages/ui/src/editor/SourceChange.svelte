<script lang="ts">
import { changeSource, type Field } from '@handover/core';
import { messageText, type UiMessage } from '../errors.js';
import { formatLanguageList, formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import Modal from '../shared/Modal.svelte';
import { requiredFieldProblems } from './required-fields';

type Data = Record<string, unknown>;
let {
  locales,
  source,
  files,
  offered,
  stale,
  fields,
  blocks,
  uiLocale = 'en',
  sending = false,
  failure,
  returnTo,
  onconfirm,
  onclose,
  onreload,
}: {
  /** The site's languages, in the order it declares them. */
  locales: string[];
  source: string;
  /** Every language with a file, as the editor holds it now. */
  files: Record<string, Data>;
  offered: string[];
  /** The translations already marked as needing a look against the source. */
  stale: string[];
  fields: readonly Field[];
  blocks: Record<string, Field[]>;
  uiLocale?: UiLocale;
  sending?: boolean;
  failure?: UiMessage;
  returnTo?: HTMLElement;
  onconfirm: (locale: string) => void;
  onclose: () => void;
  onreload: () => void;
} = $props();
const options = $derived(messageOptions(uiLocale));
const named = (locale: string) => formatLanguageName(locale, uiLocale);
const listed = (of: string[]) => formatLanguageList(of, uiLocale);

type Mark = { sourceLocale: string };
const markOf = (data: Data | undefined): Mark | undefined => {
  const mark = data?._i18n as Record<string, unknown> | undefined;
  return mark &&
    ['sourceLocale', 'sourceBlob', 'sourceHash', 'translatedAt'].every(
      (key) => typeof mark[key] === 'string',
    )
    ? (mark as Mark)
    : undefined;
};

/** What the server would write for each candidate, from the same core transition. */
type Plan = { problems: number; files: Record<string, Data> };
let plans = $state<Record<string, Plan>>({});
$effect(() => {
  const at = new Date().toISOString();
  const form = { fields: [...fields], blocks };
  let current = true;
  Promise.all(
    locales
      .filter((to) => to !== source && to in files && offered.includes(to))
      .map(async (to) => {
        const changed = await changeSource('default', form, files, { from: source, to, at });
        const problems = Object.keys(requiredFieldProblems(fields, changed[to], blocks)).length;
        return [to, { problems, files: changed }] as const;
      }),
  ).then((done) => {
    if (current) plans = Object.fromEntries(done);
  });
  return () => {
    current = false;
  };
});

const rows = $derived(
  locales
    .filter((to) => to !== source)
    .map((to) => {
      const mark = markOf(files[to]);
      const problems = plans[to]?.problems ?? 0;
      const why = !offered.includes(to)
        ? m.source_change_off({}, options)
        : !(to in files)
          ? m.source_change_no_file({}, options)
          : problems
            ? m.source_change_problems({ count: problems }, options)
            : undefined;
      const desc =
        why ??
        (!mark
          ? m.source_change_unmarked({ language: named(source) }, options)
          : mark.sourceLocale !== source
            ? m.source_change_from_other({ language: named(mark.sourceLocale) }, options)
            : stale.includes(to)
              ? m.source_change_behind({ language: named(source) }, options)
              : m.source_change_up_to_date({ language: named(source) }, options));
      return { to, desc, disabled: why !== undefined };
    }),
);
// svelte-ignore state_referenced_locally -- the first language that can be chosen starts chosen
let chosen = $state(rows.find((row) => !row.disabled)?.to);
$effect(() => {
  if (chosen && rows.find((row) => row.to === chosen)?.disabled)
    chosen = rows.find((row) => !row.disabled)?.to;
});

const filled = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== '' &&
  !(Array.isArray(value) && value.length === 0) &&
  !(typeof value === 'object' && Object.keys(value).length === 0);

const effects = $derived.by(() => {
  const plan = chosen ? plans[chosen] : undefined;
  if (!chosen || !plan) return undefined;
  const to = chosen;
  const others = locales.filter((of) => of !== to && of in files);
  const upToDate = others.filter((of) => markOf(plan.files[of])?.sourceLocale === to);
  const marked = others.filter((of) => !upToDate.includes(of) && markOf(plan.files[of]));
  const behind = marked.filter((of) => stale.includes(of));
  const nowStale = marked.filter((of) => !behind.includes(of));
  const unmarked = others.filter((of) => !markOf(plan.files[of]));
  const also = upToDate.filter((of) => of !== source);
  const sourceOnly = fields
    .filter((f) => f.i18n === false && filled(files[source]?.[f.path[0] ?? '']))
    .map((f) => f.label);
  return {
    upToDate: upToDate.includes(source),
    also,
    behind,
    nowStale,
    unmarked,
    sourceOnly,
    // Nothing records that the two match: say so before somebody confirms.
    warn: !upToDate.includes(source)
      ? markOf(files[to])?.sourceLocale === source
        ? m.source_change_warn_behind({ target: named(to), source: named(source) }, options)
        : m.source_change_warn_unmarked({ target: named(to), source: named(source) }, options)
      : undefined,
  };
});

// A lost answer or a failed reload leaves nothing safe to do here but read the entry again.
const reloadOnly = $derived(
  failure?.code === 'SOURCE_CHANGE_RESPONSE_LOST' ||
    failure?.code === 'SOURCE_CHANGE_RELOAD_FAILED',
);
const refused = $derived(failure?.code === 'ENTRY_SOURCE_REVISION' || reloadOnly);

function submit(event: SubmitEvent) {
  event.preventDefault();
  if (chosen) onconfirm(chosen);
}
</script>

<Modal
  labelledby="source-change-h"
  panelClass="dialog is-wide source-dialog"
  initialFocus="input[name='source-change-to']:checked"
  {returnTo}
  dismissible={!sending && !reloadOnly}
  {onclose}
>
  <h2 id="source-change-h">{m.source_change_title({}, options)}</h2>
  <form onsubmit={submit}>
    <p>{m.source_change_intro({}, options)} <strong>{named(source)}</strong> {m.source_change_is_now({}, options)}</p>
    <fieldset disabled={sending || reloadOnly}>
      <legend>{m.source_change_legend({}, options)}</legend>
      {#each rows as row (row.to)}
        <label class="choice" for="source-change-{row.to}">
          <input type="radio" id="source-change-{row.to}" name="source-change-to" value={row.to} disabled={row.disabled} bind:group={chosen} />
          <span class="chip" aria-hidden="true">{row.to.toUpperCase()}</span>
          <span>{named(row.to)}</span>
          <span class="desc">{row.desc}</span>
        </label>
      {/each}
    </fieldset>
    {#if effects?.warn}
      <div class="notice notice-warn">{effects.warn}</div>
    {/if}
    {#if failure}
      <div class="notice notice-danger" role="alert">
        {messageText(failure, uiLocale)}
        {#if refused}
          <button class="btn-link" type="button" onclick={onreload}>{m.source_change_reload({}, options)}</button>
        {/if}
      </div>
    {/if}
    {#if chosen && effects}
      <section class="source-effects" aria-labelledby="source-change-what">
        <h3 class="group-title" id="source-change-what">{m.source_change_what({}, options)}</h3>
        <ul>
          <li>{m.source_change_becomes({ language: named(chosen) }, options)}</li>
          {#if effects.upToDate}
            <li>
              {m.source_change_old_up_to_date({ source: named(source), language: named(chosen) }, options)}
              {#if effects.also.length}{m.source_change_so_does({ count: effects.also.length, languages: listed(effects.also) }, options)}{/if}
            </li>
          {/if}
          {#if effects.behind.length}
            <li>{m.source_change_still_behind({ count: effects.behind.length, languages: listed(effects.behind), source: named(source), language: named(chosen) }, options)}</li>
          {/if}
          {#if effects.nowStale.length}
            <li>{m.source_change_now_stale({ count: effects.nowStale.length, languages: listed(effects.nowStale), language: named(chosen) }, options)}</li>
          {/if}
          {#if effects.unmarked.length}
            <li>{m.source_change_unrecorded({ count: effects.unmarked.length, languages: listed(effects.unmarked), language: named(chosen) }, options)}</li>
          {/if}
          {#if effects.sourceOnly.length}
            <li>{m.source_change_source_only({ count: effects.sourceOnly.length, fields: effects.sourceOnly.join(', '), source: named(source), language: named(chosen) }, options)}</li>
          {/if}
          <li>{m.source_change_machine({}, options)}</li>
        </ul>
      </section>
    {/if}
    <p class="hint">{m.source_change_hint({}, options)}</p>
    {#if !reloadOnly}
      <div class="actions">
        <button class="btn" type="button" disabled={sending} onclick={onclose}>{m.common_cancel({}, options)}</button>
        <button class="btn btn-primary" type="submit" disabled={sending || refused || !chosen || !effects}>
          {sending ? m.source_change_sending({}, options) : m.source_change_confirm({ language: chosen ? named(chosen) : '' }, options)}
        </button>
      </div>
    {/if}
  </form>
</Modal>
