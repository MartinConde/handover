<script module lang="ts">
import { messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';

/** One thing the checks found, named by the entry as well as by the file it is in. */
export type CheckItem = {
  check: string;
  entry: string;
  path: string;
  fieldPath: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
};
/** One line on screen: the same problem in several language files, said once. */
export type CheckLine = CheckItem & { locales: string[] };

export const WORST = { error: 0, warn: 1, info: 2 };
export const TINT = { error: 'danger', warn: 'warn', info: 'info' };

export const severityLabel = (severity: CheckLine['severity'], locale: UiLocale) => {
  const options = messageOptions(locale);
  return {
    error: m.check_severity_error,
    warn: m.check_severity_warning,
    info: m.check_severity_note,
  }[severity]({}, options);
};

const LOCALE = /^src\/content\/[^/]+\/([^/]+)\//;
// The same field in two language files is one problem, since the client's edit is one edit.
export function merged(items: CheckItem[]): CheckLine[] {
  const lines: CheckLine[] = [];
  for (const item of items) {
    const locale = LOCALE.exec(item.path)?.[1] ?? '';
    const same = lines.find(
      (l) => l.check === item.check && l.fieldPath === item.fieldPath && l.message === item.message,
    );
    if (same) same.locales.push(locale);
    else lines.push({ ...item, locales: [locale] });
  }
  return lines.sort((a, b) => WORST[a.severity] - WORST[b.severity]);
}

// Only an error stops a publish; the worst word present is also what the button says.
export function verdict(lines: CheckLine[], locale: UiLocale): string {
  const options = messageOptions(locale);
  if (!lines.length) return m.check_nothing_found({}, options);
  const count = (of: CheckLine['severity']) => {
    const n = lines.filter((l) => l.severity === of).length;
    if (!n) return '';
    return {
      error: m.check_error_count,
      warn: m.check_warning_count,
      info: m.check_note_count,
    }[of]({ count: n }, options);
  };
  const counted = [count('error'), count('warn'), count('info')].filter(Boolean).join(' · ');
  return lines.some((l) => l.severity === 'error')
    ? m.check_verdict_error({ counted }, options)
    : lines.some((l) => l.severity === 'warn')
      ? m.check_verdict_warning({ counted }, options)
      : m.check_verdict_clear({ counted }, options);
}
</script>

<script lang="ts">
import { sitePath } from '../request.js';

let {
  lines,
  chips = false,
  uiLocale = 'en',
  goTo,
  onclose,
}: {
  lines: CheckLine[];
  /** Whether a line says which languages it is about — only worth saying where there are two. */
  chips?: boolean;
  uiLocale?: UiLocale;
  /** Where a line's field is edited; without it no line offers Go to field. */
  goTo?: (line: CheckLine) => string;
  onclose?: () => void;
} = $props();

const notes = $derived(lines.filter((line) => line.severity === 'info'));
</script>

{#snippet line(item: CheckLine)}
  <div class="notice notice-{TINT[item.severity]}">
    <span class="sev">{severityLabel(item.severity, uiLocale)}</span>
    {#if chips}
      <span class="visually-hidden">{m.check_languages({}, messageOptions(uiLocale))}</span>
      <span class="chips">
        {#each item.locales as of (of)}<span class="chip">{of.toUpperCase()}</span>{/each}
      </span>
    {/if}
    <span class="msg">{item.message}</span>
    <!-- The machine-translation note is not about a mistake, so it has nowhere to go. -->
    {#if goTo && item.fieldPath && item.check !== 'translation-machine'}
      <a class="btn-link" href={sitePath(goTo(item))} onclick={onclose}>{m.check_go_to_field({}, messageOptions(uiLocale))}</a>
    {/if}
  </div>
{/snippet}

{#each lines.filter((item) => item.severity !== 'info') as item (item.path + item.fieldPath + item.check)}
  {@render line(item)}
{/each}
<!-- Notes fold away so what stops or changes a publish stays in view. -->
{#if notes.length}
  <details class="check-notes">
    <summary>{m.check_note_count({ count: notes.length }, messageOptions(uiLocale))}</summary>
    {#each notes as item (item.path + item.fieldPath + item.check)}
      {@render line(item)}
    {/each}
  </details>
{/if}
