<script lang="ts">
import { formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import { missing, type OwedRow, offered, owes, partial, stale } from '../owed.js';
import * as m from '../paraglide/messages.js';

let {
  entry,
  locales,
  uiLocale = 'en',
}: {
  entry: OwedRow;
  /** The site's languages in its own order. */
  locales: string[];
  uiLocale?: UiLocale;
} = $props();
const options = $derived(messageOptions(uiLocale));

// Above four languages a chip each stops reading at a glance, so a row counts and names the owed.
const compact = $derived(locales.length > 4);
const owedIn = (row: OwedRow) => locales.filter((l) => owes(row, l, 'owed'));
const counted = (row: OwedRow) => {
  const offer = locales.filter((l) => offered(row, l));
  return { created: offer.filter((l) => row.locales[l]).length, offered: offer.length };
};
const summary = (row: OwedRow) =>
  m.entry_list_files_created(
    {
      ...counted(row),
      languages: locales
        .map((l) =>
          m.entry_list_language_state(
            { language: formatLanguageName(l, uiLocale), state: chipTitle(row, l) },
            options,
          ),
        )
        .join('; '),
    },
    options,
  );
const chipTitle = (row: OwedRow, locale: string) =>
  !offered(row, locale)
    ? m.entry_list_chip_off({}, options)
    : !row.locales[locale]
      ? m.entry_list_chip_missing({}, options)
      : row.stale?.includes(locale)
        ? m.entry_list_chip_stale({}, options)
        : partial(row, locale)
          ? m.entry_list_chip_partial(
              {
                written: row.partial?.[locale]?.[0] ?? 0,
                count: row.partial?.[locale]?.[1] ?? 0,
              },
              options,
            )
          : m.entry_list_chip_written({}, options);
// One mark per language, stale before partly written, as the editor's switcher has it.
const chipClass = (row: OwedRow, locale: string) =>
  missing(row, locale)
    ? 'chip-missing'
    : stale(row, locale)
      ? 'chip-stale'
      : partial(row, locale)
        ? 'chip-partial'
        : undefined;
</script>

{#if compact}
  {@const words = summary(entry)}
  {@const owed = owedIn(entry)}
  {@const count = counted(entry)}
  <span class="visually-hidden">{m.entry_list_languages({}, options)} {words}</span>
  <span class="chips" aria-hidden="true" title={words}>
    <span class="chip chip-count">{count.created}/{count.offered}</span>
    {#each owed.slice(0, 3) as locale (locale)}
      <span class={['chip', chipClass(entry, locale)]}>{locale.toUpperCase()}</span>
    {/each}
    {#if owed.length > 3}<span class="chip chip-count">+{owed.length - 3}</span>{/if}
  </span>
{:else}
  <span class="visually-hidden">{m.entry_list_languages({}, options)}</span>
  <span class="chips">
    {#each locales as locale (locale)}
      <span
        class={['chip', offered(entry, locale) ? chipClass(entry, locale) : 'chip-disabled']}
        title="{locale}: {chipTitle(entry, locale)}"
      >{locale.toUpperCase()}</span>
    {/each}
  </span>
{/if}
