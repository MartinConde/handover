<script module lang="ts">
import { type Labels, labelIn } from '@handover/core';
import { formatLanguageList, formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';

/** One thing the checks found, named by the entry as well as by the file it is in. */
export type CheckItem = {
  check: string;
  entry: string;
  path: string;
  fieldPath: string;
  severity: 'error' | 'warn' | 'info';
  /** English; what an older server sends and what an unknown `code` falls back to. */
  message: string;
  code?: string;
  params?: Record<string, string | number | string[] | Labels>;
};
/** One line on screen: the same problem in several language files, said once. */
export type CheckLine = CheckItem & { locales: string[] };

/** The sentence in the interface language; the server's English one when the code is not known here. */
export function checkText(item: CheckItem, locale: UiLocale): string {
  const o = messageOptions(locale);
  const p = item.params ?? {};
  const text = (key: string) => String(p[key] ?? '');
  const label = labelIn(p.label, locale) ?? '';
  const language = (key: string) => formatLanguageName(text(key), locale);
  const languages = formatLanguageList(Array.isArray(p.locales) ? p.locales : [], locale);
  switch (item.code) {
    case 'source-conflict':
      return m.check_source_conflict({ languages }, o);
    case 'source-undeclared':
      return m.check_source_undeclared({ languages }, o);
    case 'source-missing':
      return m.check_source_missing({ languages }, o);
    case 'translation-stale':
      return m.check_translation_stale({ from: language('from') }, o);
    case 'translation-source-moved':
      return m.check_translation_source_moved(
        { from: language('from'), written: language('written') },
        o,
      );
    case 'hidden-long':
      return m.check_hidden_long({ title: text('title'), count: Number(p.months) }, o);
    case 'image-alt-missing':
      return m.check_image_alt_missing({ label }, o);
    case 'translation-empty':
      return m.check_translation_empty({ label, language: language('locale') }, o);
    case 'seo-title-long':
      return m.check_seo_title_long({ count: Number(p.count), limit: Number(p.limit) }, o);
    case 'seo-description-missing':
      return m.check_seo_description_missing({}, o);
    case 'seo-image-missing':
      return m.check_seo_image_missing({}, o);
    case 'link-target-missing':
      return m.check_link_target_missing({ label, ref: text('ref') }, o);
    case 'link-locale-missing':
      return m.check_link_locale_missing(
        { label, title: text('title'), language: language('locale') },
        o,
      );
    case 'link-href-missing':
      return m.check_link_href_missing({ label, href: text('href') }, o);
    case 'link-href-locale-missing':
      return m.check_link_href_locale_missing(
        { label, href: text('href'), title: text('title'), language: language('locale') },
        o,
      );
    case 'menu-target-missing':
      return m.check_menu_target_missing({ menu: text('menu'), ref: text('ref') }, o);
    case 'menu-target-hidden':
      return m.check_menu_target_hidden({ menu: text('menu'), title: text('title') }, o);
    case 'media-deleting':
      return m.check_media_deleting({ label }, o);
    case 'media-deleted':
      return m.check_media_deleted({ label, key: text('key') }, o);
    case 'media-archived':
      return m.check_media_archived({ label }, o);
    case 'media-gone':
      return m.check_media_gone({ label, key: text('key') }, o);
    case 'machine-translated':
      return m.check_machine_translated({}, o);
    default:
      return item.message;
  }
}

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
export const localeOf = (path: string) => LOCALE.exec(path)?.[1] ?? '';
// The same field in two language files is one problem, since the client's edit is one edit.
export function merged(items: CheckItem[]): CheckLine[] {
  const lines: CheckLine[] = [];
  for (const item of items) {
    const locale = localeOf(item.path);
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
    <span class="msg">{checkText(item, uiLocale)}</span>
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
