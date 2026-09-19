<script lang="ts">
import { formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';

/** The body of the 409 an entry answers when its files do not settle its source language. */
export interface SourceProblem {
  code: 'ENTRY_SOURCE_CONFLICT' | 'ENTRY_SOURCE_UNDECLARED' | 'ENTRY_SOURCE_MISSING';
  marks: Record<string, string>;
  files: string[];
  offered: string[];
}

let { problem, uiLocale = 'en' }: { problem: SourceProblem; uiLocale?: UiLocale } = $props();
const options = $derived(messageOptions(uiLocale));
const named = (locale: string) => formatLanguageName(locale, uiLocale);
// Undeclared and missing name one language in every marked file; that is the one to talk about.
const language = $derived(named(Object.values(problem.marks)[0] ?? ''));
const text = $derived(
  problem.code === 'ENTRY_SOURCE_CONFLICT'
    ? {
        blocked: m.source_recovery_conflict_blocked({}, options),
        title: m.source_recovery_conflict_title({}, options),
        intro: m.source_recovery_conflict_intro({}, options),
      }
    : problem.code === 'ENTRY_SOURCE_UNDECLARED'
      ? {
          blocked: m.source_recovery_undeclared_blocked({}, options),
          title: m.source_recovery_undeclared_title({}, options),
          intro: m.source_recovery_undeclared_intro({ language }, options),
        }
      : {
          blocked: m.source_recovery_missing_blocked({}, options),
          title: m.source_recovery_missing_title({}, options),
          intro: m.source_recovery_missing_intro({ language }, options),
        },
);
</script>

<div class="lock-banner is-drift" role="status">{text.blocked}</div>
<div class="entry-body">
  <section class="drift source-recovery" aria-labelledby="source-recovery-h">
    <header>
      <h2 id="source-recovery-h">{text.title}</h2>
      <p>{text.intro}</p>
    </header>
    <ul class="source-files" aria-label={m.source_recovery_files({}, options)}>
      {#each problem.files as locale (locale)}
        {@const mark = problem.marks[locale]}
        <li>
          <span class={['chip', { 'chip-missing': !mark }]} aria-hidden="true">{locale.toUpperCase()}</span>
          <span>{mark
              ? m.source_recovery_file_says({ file: named(locale), language: named(mark) }, options)
              : m.source_recovery_file_silent({ file: named(locale) }, options)}</span>
        </li>
      {/each}
    </ul>
    <p class="hint">{m.source_recovery_hint_before({}, options)} <code>_source</code> {m.source_recovery_hint_after({}, options)}</p>
  </section>
</div>
