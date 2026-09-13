<script lang="ts">
import type { UiLocale } from '../i18n.js';
import { isUiLocale, messageOptions } from '../i18n.js';
import * as m from '../paraglide/messages.js';

let {
  locale,
  disabled = false,
  onlocale,
}: {
  locale: UiLocale;
  disabled?: boolean;
  onlocale: (locale: UiLocale) => void | Promise<void>;
} = $props();

const choose = async (event: Event) => {
  const select = event.currentTarget as HTMLSelectElement;
  const value = select.value;
  if (isUiLocale(value)) await onlocale(value);
  select.value = locale;
};
</script>

<label class="language-control">
  <span>{m.account_interface_language({}, messageOptions(locale))}</span>
  <select
    class="input"
    value={locale}
    {disabled}
    aria-label={m.account_interface_language({}, messageOptions(locale))}
    onchange={choose}
  >
    <option value="en">{m.account_language_english({}, messageOptions(locale))}</option>
    <option value="de">{m.account_language_german({}, messageOptions(locale))}</option>
  </select>
</label>

<style>
  .language-control { display: grid; gap: .35rem; }
  .language-control > span { font-size: .8rem; font-weight: 650; }
  :global(.auth-page) .language-control { width: min(220px, 100%); margin: 0 0 var(--s-3) auto; }
  :global(.menu) .language-control { padding: var(--s-2) var(--s-3); }
</style>
