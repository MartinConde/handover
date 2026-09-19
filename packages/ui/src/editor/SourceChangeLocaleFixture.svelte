<script lang="ts">
import type { ComponentProps } from 'svelte';
import type { UiLocale } from '../i18n.js';
import SourceChange from './SourceChange.svelte';

let {
  initialUiLocale = 'en',
  ...rest
}: Omit<ComponentProps<typeof SourceChange>, 'uiLocale'> & { initialUiLocale?: UiLocale } =
  $props();
// svelte-ignore state_referenced_locally -- the fixture owns the live preference.
let uiLocale = $state<UiLocale>(initialUiLocale);
</script>

<button data-locale-switch type="button" onclick={() => (uiLocale = uiLocale === 'en' ? 'de' : 'en')}>
  {uiLocale === 'en' ? 'Deutsch' : 'English'}
</button>
<SourceChange {...rest} {uiLocale} />
