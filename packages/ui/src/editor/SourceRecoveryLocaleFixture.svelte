<script lang="ts">
import type { UiLocale } from '../i18n.js';
import SourceRecovery, { type SourceProblem } from './SourceRecovery.svelte';

let { problem, initialUiLocale = 'en' }: { problem: SourceProblem; initialUiLocale?: UiLocale } =
  $props();
// svelte-ignore state_referenced_locally -- the fixture owns the live preference.
let uiLocale = $state<UiLocale>(initialUiLocale);
</script>

<button data-locale-switch type="button" onclick={() => (uiLocale = uiLocale === 'en' ? 'de' : 'en')}>
  {uiLocale === 'en' ? 'Deutsch' : 'English'}
</button>
<SourceRecovery {problem} {uiLocale} />
