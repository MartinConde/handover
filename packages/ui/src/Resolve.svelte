<script lang="ts">
import type { Change, MergedChange, Question } from '@handover/core';

let {
  entry,
  title,
  updated,
  onclose,
  onresolved,
}: {
  /** `listings/mill-house` — the entry the repository moved under. */
  entry: string;
  title: string;
  /** When the draft was last typed in, which is the only date the client owns here. */
  updated: number;
  onclose: () => void;
  /** The answers are written: the draft now sits on the file at HEAD and can publish. */
  onresolved: () => void;
} = $props();

// The list it replaced is gone from the drawer, so the panel takes the focus with it.
let panel = $state<HTMLElement>();
$effect(() => panel?.focus());

let questions = $state<Question[]>([]);
let merged = $state<MergedChange[]>([]);
/** The commit the repository is at, which is what "theirs" is of. */
let head = $state('');
let answers = $state<Record<string, 'ours' | 'theirs'>>({});
let loading = $state(true);
let busy = $state(false);
let error = $state('');

// A question is one field of one language, or one every language shares: both are needed to
// tell two of them apart, and both go back with the answer.
const key = (q: { path: string; locale?: string }) => `${q.locale ?? ''} ${q.path}`;
const answered = $derived(questions.filter((q) => answers[key(q)]).length);
const plural = (n: number, what: string) => `${n} ${n === 1 ? what.replace(/s$/, '') : what}`;

$effect(() => {
  void load();
});

async function load() {
  const res = await fetch(`/admin/api/conflict/${entry}`);
  loading = false;
  if (!res.ok) {
    error = await refusal(res);
    return;
  }
  const body = (await res.json()) as {
    questions: Question[];
    merged: MergedChange[];
    head: string;
  };
  questions = body.questions;
  merged = body.merged;
  head = body.head;
}

// A conflict somebody else settled, or a repository out of reach: neither is about the answers
// on this screen, and both are the server's own sentence.
const refusal = async (res: Response) =>
  res.status === 409 || res.status === 503
    ? await res.text()
    : `Those changes could not be read (${res.status}).`;

/** Every question at once, for the client who does not want to read them. */
async function all(side: 'ours' | 'theirs') {
  for (const q of questions) answers[key(q)] = side;
  await done();
}

async function done() {
  busy = true;
  error = '';
  const res = await fetch(`/admin/api/conflict/${entry}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      answers: questions.map((q) => ({
        path: q.path,
        ...(q.locale ? { locale: q.locale } : {}),
        side: answers[key(q)],
      })),
    }),
  });
  busy = false;
  if (!res.ok) {
    error = await refusal(res);
    return;
  }
  onresolved();
}

/** What a merged change says it did, in as many words as it has. */
const said = (change: Change): string => {
  if (change.kind === 'row')
    return change.at === 'moved-up'
      ? 'moved up'
      : change.at === 'moved-down'
        ? 'moved down'
        : change.at;
  if (change.kind === 'value')
    return change.before === undefined
      ? `set to ${change.after}`
      : change.after === undefined
        ? 'cleared'
        : `${change.before} → ${change.after}`;
  return 'rewritten';
};
</script>

<!-- What this side says, with what it added marked. The words it took out are not drawn: the
     line above already names what both started from, and a deletion run against an insertion
     is unreadable in a sentence nobody has read yet. -->
{#snippet value(change: Change)}
  {#if change.kind === 'value'}{change.after ?? 'empty'}
  {:else if change.kind === 'words'}{#each change.parts.filter((p) => p.mark !== 'del') as part, i (i)}{#if part.mark === 'ins'}<ins
        >{part.text}</ins
      >{:else}{part.text}{/if}{/each}
  {:else}rewritten{/if}
{/snippet}

{#snippet side(q: Question, mine: boolean)}
  {@const change = mine ? q.ours : q.theirs}
  {@const short = change.kind === 'value'}
  <label class="choice">
    <input
      type="radio"
      name="resolve-{key(q)}"
      checked={answers[key(q)] === (mine ? 'ours' : 'theirs')}
      disabled={busy}
      onchange={() => (answers[key(q)] = mine ? 'ours' : 'theirs')}
    >
    <span class="body">
      <!-- The dash is a literal: Svelte trims the whitespace around a block and the two would
           otherwise read as one word. -->
      <b>{mine ? 'Yours' : 'Theirs'}{#if short}{' — '}{@render value(change)}{/if}</b>
      {#if !short}<span class="quote">{@render value(change)}</span>{/if}
      <small>
        {#if mine}you, {new Date(updated).toLocaleString()}
        {:else}in the repository{#if head}{' · '}commit <code>{head.slice(0, 7)}</code>{/if}
        {/if}
      </small>
    </span>
  </label>
{/snippet}

<div class="resolve" aria-labelledby="resolve-h" tabindex="-1" bind:this={panel}>
  <header>
    <h3 id="resolve-h">Resolve {title}</h3>
    <p>
      {#if loading}
        Reading what changed…
      {:else}
        Your developer changed this in the code while you were editing it.
        {#if merged.length}{plural(merged.length, 'fields')} only one of you touched
          {merged.length === 1 ? 'is' : 'are'} already merged.{/if}
        {#if questions.length}
          {plural(questions.length, 'fields')} {questions.length === 1 ? 'was' : 'were'} changed by
          both of you and {questions.length === 1 ? 'needs' : 'need'} an answer.
        {:else}
          Nothing was changed by both of you, so there is nothing to answer.
        {/if}
      {/if}
    </p>
  </header>

  {#if questions.length > 1}
    <div class="resolve-shortcuts">
      <div class="btns">
        <button class="btn btn-sm" type="button" disabled={busy} onclick={() => all('ours')}>
          Keep all mine
        </button>
        <button class="btn btn-sm" type="button" disabled={busy} onclick={() => all('theirs')}>
          Take all theirs
        </button>
      </div>
      <p class="sub">
        <strong>Keep all mine</strong> undoes the developer's change to
        {plural(questions.length, 'fields')}. <strong>Take all theirs</strong> throws away what you
        wrote in them. What is already merged is kept either way.
      </p>
    </div>
  {/if}

  {#if questions.length}
    <ul class="resolve-list">
      {#each questions as q (key(q))}
        <li class="resolve-field">
          <div class="head">
            <span class="name">{q.label}</span>
            {#if q.locale}
              <span class="visually-hidden">Language:</span><span class="chips"><span class="chip">{q.locale.toUpperCase()}</span></span>
            {:else}
              <span class="badge">Same in every language</span>
            {/if}
          </div>
          {#if q.base !== undefined}
            <p class="base">You both started from <b>{q.base}</b></p>
          {/if}
          <fieldset class="sides">
            <legend class="visually-hidden">Which {q.label} to keep</legend>
            {@render side(q, true)}
            {@render side(q, false)}
          </fieldset>
        </li>
      {/each}
    </ul>
  {/if}

  {#if merged.length}
    <details class="group">
      <summary>Merged for you <span class="count">{merged.length}</span></summary>
      <ul class="merged-list">
        {#each merged as change (key({ path: change.change.path, locale: change.locale }))}
          <li>
            <span class="name">
              {change.label}
              {#if change.locale}<span class="chip">{change.locale.toUpperCase()}</span>{/if}
            </span>
            <span class="sub">
              {said(change.change)} — only {change.side === 'ours' ? 'you' : 'the code'} changed it
            </span>
          </li>
        {/each}
      </ul>
    </details>
  {/if}

  {#if error}<div class="notice notice-danger" role="alert">{error}</div>{/if}

  <div class="actions">
    <button class="btn" type="button" disabled={busy} onclick={onclose}>Cancel</button>
    <button
      class="btn btn-primary"
      type="button"
      disabled={busy || loading || answered !== questions.length}
      onclick={() => done()}
    >
      {#if busy}Saving…
      {:else if questions.length}Done — {answered} of {questions.length} answered
      {:else}Done{/if}
    </button>
    <p class="foot-note">
      Answering {questions.length === 1 ? 'it' : 'them all'} writes a new draft over the code's
      version. Nothing is published until you press Publish.
    </p>
  </div>
</div>
