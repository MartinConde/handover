<script module lang="ts">
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
export const SEVERITY = { error: 'Error', warn: 'Warning', info: 'Note' };
export const TINT = { error: 'danger', warn: 'warn', info: 'info' };
export const plural = (n: number, what: string) =>
  `${n} ${n === 1 ? what.replace(/s$/, '') : what}`;

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
export function verdict(lines: CheckLine[]): string {
  if (!lines.length) return 'Nothing found.';
  const count = (of: CheckLine['severity'], what: string) => {
    const n = lines.filter((l) => l.severity === of).length;
    return n ? plural(n, what) : '';
  };
  const counted = [count('error', 'errors'), count('warn', 'warnings'), count('info', 'notes')]
    .filter(Boolean)
    .join(' · ');
  return lines.some((l) => l.severity === 'error')
    ? `${counted}. The error has to go first.`
    : lines.some((l) => l.severity === 'warn')
      ? `${counted}. Warnings never stop a publish.`
      : `${counted} — nothing is in the way.`;
}
</script>

<script lang="ts">
import { sitePath } from './request.js';

let {
  lines,
  chips = false,
  goTo,
  onclose,
}: {
  lines: CheckLine[];
  /** Whether a line says which languages it is about — only worth saying where there are two. */
  chips?: boolean;
  /** Where a line's field is edited; without it no line offers Go to field. */
  goTo?: (line: CheckLine) => string;
  onclose?: () => void;
} = $props();

const notes = $derived(lines.filter((line) => line.severity === 'info'));
</script>

{#snippet line(item: CheckLine)}
  <div class="notice notice-{TINT[item.severity]}">
    <span class="sev">{SEVERITY[item.severity]}</span>
    {#if chips}
      <span class="visually-hidden">Languages:</span>
      <span class="chips">
        {#each item.locales as of (of)}<span class="chip">{of.toUpperCase()}</span>{/each}
      </span>
    {/if}
    <span class="msg">{item.message}</span>
    <!-- The machine-translation note is not about a mistake, so it has nowhere to go. -->
    {#if goTo && item.fieldPath && item.check !== 'translation-machine'}
      <a class="btn-link" href={sitePath(goTo(item))} onclick={onclose}>Go to field</a>
    {/if}
  </div>
{/snippet}

{#each lines.filter((item) => item.severity !== 'info') as item (item.path + item.fieldPath + item.check)}
  {@render line(item)}
{/each}
<!-- Notes fold away so what stops or changes a publish stays in view. -->
{#if notes.length}
  <details class="check-notes">
    <summary>{plural(notes.length, 'notes')}</summary>
    {#each notes as item (item.path + item.fieldPath + item.check)}
      {@render line(item)}
    {/each}
  </details>
{/if}
