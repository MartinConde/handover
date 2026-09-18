<script lang="ts">
import type { Drift } from '@handover/core';
import { formatLanguageList, formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch } from '../request.js';

let {
  collection,
  slug,
  drift,
  locales,
  uiLocale = 'en',
  onresolved,
}: {
  collection: string;
  slug: string;
  /** The blocks the entry's languages disagree about, from the entry it was opened with. */
  drift: Drift[];
  /** The languages the site declares: a block in all of them is the one that carries no mark. */
  locales: string[];
  uiLocale?: UiLocale;
  /** The answers are in: the entry has to be read again, drift and all. */
  onresolved: () => void;
} = $props();
const options = $derived(messageOptions(uiLocale));

/** Which answer each block has been given, by its path; the index of one of its choices. */
let answers = $state<Record<string, number>>({});
let busy = $state(false);
let error = $state<{ kind: 'changed' } | { kind: 'failed'; status: number }>();

const named = (locale: string) => formatLanguageName(locale, uiLocale);
const list = (of: string[]) => formatLanguageList(of, uiLocale);

/** One answer: the languages the block ends up in, and how that reads. */
interface Choice {
  to: string[];
  label: string;
  desc: string;
}

const missingFrom = (row: Drift) => row.expected.filter((l) => !row.in.includes(l));
const extraIn = (row: Drift) => row.in.filter((l) => !row.expected.includes(l));

// Not a fixed three: the choices come from which languages have the block against which should.
function choicesFor(row: Drift): Choice[] {
  const missing = missingFrom(row);
  const extra = extraIn(row);
  const expectedChoice = missing.length
    ? extra.length
      ? m.drift_add_remove({ add: list(missing), remove: list(extra) }, options)
      : m.drift_add({ languages: list(missing) }, options)
    : m.drift_remove({ languages: list(extra) }, options);
  const everywhere = row.in.length === locales.length;
  return [
    {
      to: row.expected,
      label: expectedChoice,
      desc: missing.length
        ? m.drift_added_desc({}, options)
        : m.drift_keep_only({ languages: list(row.expected) }, options),
    },
    {
      to: row.in,
      label: everywhere
        ? m.drift_everywhere({}, options)
        : m.drift_keep_only({ languages: list(row.in) }, options),
      desc: everywhere
        ? m.drift_drop_mark_desc({}, options)
        : m.drift_mark_ownership_desc({}, options),
    },
    ...(missing.length
      ? [
          {
            to: [],
            label: m.drift_remove({ languages: list(row.in) }, options),
            desc: m.drift_removed_desc({}, options),
          },
        ]
      : []),
  ];
}

function whatOf(row: Drift): string {
  const missing = missingFrom(row);
  const extra = extraIn(row);
  if (!missing.length)
    return m.drift_marked_extra({ expected: list(row.expected), extra: list(extra) }, options);
  if (!extra.length)
    return m.drift_unmarked_missing({ present: list(row.in), missing: list(missing) }, options);
  return m.drift_marked_misaligned(
    { expected: list(row.expected), present: list(row.in) },
    options,
  );
}

// The languages this block is about: the ones that have it and the ones that should.
const shown = (row: Drift) => locales.filter((l) => row.in.includes(l) || row.expected.includes(l));

const answered = $derived(drift.filter((row) => answers[row.path] !== undefined).length);

async function apply() {
  busy = true;
  error = undefined;
  const res = await fetch(`/admin/api/drift/${collection}/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      choices: drift.map((row) => ({
        path: row.path,
        locales: choicesFor(row)[answers[row.path] ?? 0]?.to ?? [],
      })),
    }),
  });
  busy = false;
  if (!res.ok) {
    // A 409 is the report having moved on under the tab; reading the entry again is the answer.
    error = res.status === 409 ? { kind: 'changed' } : { kind: 'failed', status: res.status };
    return;
  }
  onresolved();
}
</script>

<section class="drift" aria-labelledby="drift-h">
  <header>
    <h2 id="drift-h">{m.drift_title({}, options)}</h2>
    <p>{m.drift_intro({}, options)}</p>
  </header>
  <div class="drift-rows">
    {#each drift as row, i (row.path)}
      <article class="block-card" aria-labelledby="drift-{i}-h">
        <header>
          <span class="label" id="drift-{i}-h">{row.type ?? m.drift_row({}, options)}</span>
          <span class="type">{row.path}</span>
          <span class="visually-hidden">{m.drift_languages({}, options)}</span>
          <span class="chips">
            {#each shown(row) as locale (locale)}
              <span class={['chip', { 'chip-missing': !row.in.includes(locale) }]}>
                {locale.toUpperCase()}
              </span>
            {/each}
          </span>
        </header>
        <div class="body">
          <p class="what">{whatOf(row)}</p>
          <div class="drift-cols">
            {#each shown(row) as locale (locale)}
              <div>
                <p class="col-title">{named(locale)}</p>
                <div class="readonly">
                  {#each row.values[locale] ?? [] as words, w (w)}
                    <p>{words}</p>
                  {:else}
                    <p>{row.in.includes(locale) ? m.drift_nothing_written({}, options) : m.drift_not_in_language({}, options)}</p>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
          <fieldset>
            <legend>{m.drift_question({}, options)}</legend>
            {#each choicesFor(row) as choice, j (j)}
              <label class="choice" for="drift-{i}-{j}">
                <input
                  type="radio"
                  id="drift-{i}-{j}"
                  name="drift-{i}"
                  checked={answers[row.path] === j}
                  onchange={() => (answers[row.path] = j)}
                />
                <span>{choice.label}</span>
                <span class="desc">{choice.desc}</span>
              </label>
            {/each}
          </fieldset>
        </div>
      </article>
    {/each}
  </div>
  {#if error}<div class="notice notice-danger" role="alert">{error.kind === 'changed' ? m.drift_changed({}, options) : m.drift_apply_failed({ status: error.status }, options)}</div>{/if}
  <div class="actions">
    <span class="left">{m.drift_answered({ answered, total: drift.length }, options)}</span>
    <button
      class="btn btn-primary"
      type="button"
      disabled={busy || answered < drift.length}
      onclick={apply}
    >
      {busy ? m.drift_applying({}, options) : m.drift_apply({}, options)}
    </button>
  </div>
</section>
