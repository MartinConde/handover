<script lang="ts">
import type { Drift } from '@handover/core';

let {
  collection,
  slug,
  drift,
  locales,
  onresolved,
}: {
  collection: string;
  slug: string;
  /** The blocks the entry's languages disagree about, from the entry it was opened with. */
  drift: Drift[];
  /** The languages the site declares: a block in all of them is the one that carries no mark. */
  locales: string[];
  /** The answers are in: the entry has to be read again, drift and all. */
  onresolved: () => void;
} = $props();

/** Which answer each block has been given, by its path; the index of one of its choices. */
let answers = $state<Record<string, number>>({});
let busy = $state(false);
let error = $state('');

const LANGUAGES = new Intl.DisplayNames(['en'], { type: 'language' });
const named = (locale: string) => {
  try {
    return LANGUAGES.of(locale) ?? locale;
  } catch {
    return locale;
  }
};
const list = (of: string[]) => of.map(named).join(' and ');
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One answer: the languages the block ends up in, and how that reads. */
interface Choice {
  to: string[];
  label: string;
  desc: string;
}

const missingFrom = (row: Drift) => row.expected.filter((l) => !row.in.includes(l));
const extraIn = (row: Drift) => row.in.filter((l) => !row.expected.includes(l));

// Not a fixed three: the answers come from which languages have the block against which should.
// Making the files say what the mark says, making the mark say what the files say, and — where
// a language is missing it — not having it at all, which is the alternative to translating it.
function choicesFor(row: Drift): Choice[] {
  const missing = missingFrom(row);
  const extra = extraIn(row);
  const parts = [
    ...(missing.length ? [`add it to ${list(missing)}`] : []),
    ...(extra.length ? [`remove it from ${list(extra)}`] : []),
  ];
  const everywhere = row.in.length === locales.length;
  return [
    {
      to: row.expected,
      label: capitalise(parts.join(' and ')),
      desc: missing.length
        ? 'It arrives with the values every language shares and nothing to read yet'
        : `Keeps it ${list(row.expected)} only`,
    },
    {
      to: row.in,
      label: everywhere ? 'Let it be in every language' : `Keep it in ${list(row.in)} only`,
      desc: everywhere ? 'Drops the mark that says otherwise' : 'Marks the block as theirs',
    },
    ...(missing.length
      ? [
          {
            to: [],
            label: `Remove it from ${list(row.in)}`,
            desc: 'What is written there is lost',
          },
        ]
      : []),
  ];
}

function whatOf(row: Drift): string {
  const missing = missingFrom(row);
  const extra = extraIn(row);
  if (!missing.length)
    return `This block is marked for ${list(row.expected)}, and ${list(extra)} has it as well.`;
  if (!extra.length)
    return `${list(row.in)} has this block and ${list(missing)} does not, with nothing on it to say which language it belongs to.`;
  return `This block is marked for ${list(row.expected)} and sits in ${list(row.in)} instead.`;
}

// The languages this block is about: the ones that have it and the ones that should.
const shown = (row: Drift) => locales.filter((l) => row.in.includes(l) || row.expected.includes(l));

const answered = $derived(drift.filter((row) => answers[row.path] !== undefined).length);

async function apply() {
  busy = true;
  error = '';
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
    // A 409 here is the report having moved on under the tab, which reading the entry again
    // is the answer to — the same as every other way out of this panel.
    error =
      res.status === 409
        ? 'This entry changed while you were deciding. Reload it and look again.'
        : `Those answers were not applied (${res.status}).`;
    return;
  }
  onresolved();
}
</script>

<section class="drift" aria-labelledby="drift-h">
  <header>
    <h2 id="drift-h">The languages disagree about this entry's blocks</h2>
    <p>
      Blocks are the same in every language — only the words differ. These do not line up, which
      happens when a file is edited outside the admin. Nothing is decided for you: say what each
      block should be, and publishing is open again.
    </p>
  </header>
  <div class="drift-rows">
    {#each drift as row, i (row.path)}
      <article class="block-card" aria-labelledby="drift-{i}-h">
        <header>
          <span class="label" id="drift-{i}-h">{row.type ?? 'Row'}</span>
          <span class="type">{row.path}</span>
          <span class="visually-hidden">Languages:</span>
          <span class="chips">
            {#each shown(row) as locale (locale)}
              <span class="chip" class:chip-missing={!row.in.includes(locale)}>
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
                    <p>{row.in.includes(locale) ? 'Nothing written in it' : 'Not in this language'}</p>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
          <fieldset>
            <legend>What should this block be?</legend>
            {#each choicesFor(row) as choice, j (choice.label)}
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
  {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}
  <div class="actions">
    <span class="left">{answered} of {drift.length} answered</span>
    <button
      class="btn btn-primary"
      type="button"
      disabled={busy || answered < drift.length}
      onclick={apply}
    >
      {busy ? 'Applying…' : 'Apply these answers'}
    </button>
  </div>
</section>
