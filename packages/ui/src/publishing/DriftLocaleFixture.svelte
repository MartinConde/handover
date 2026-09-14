<script lang="ts">
import type { Drift } from '@handover/core';
import type { UiLocale } from '../i18n.js';
import DriftPanel from './Drift.svelte';

let { initialUiLocale = 'en' }: { initialUiLocale?: UiLocale } = $props();
// svelte-ignore state_referenced_locally -- the fixture owns the live preference.
let uiLocale = $state<UiLocale>(initialUiLocale);
const drift: Drift[] = [
  {
    path: 'blocks[_id=z9y8x7w6]',
    type: 'quote',
    in: ['de'],
    expected: ['en', 'de'],
    values: { de: ['Ein seltener Fund.'] },
  },
];
</script>

<button data-locale-switch type="button" onclick={() => (uiLocale = uiLocale === 'en' ? 'de' : 'en')}>
  {uiLocale === 'en' ? 'Deutsch' : 'English'}
</button>
<DriftPanel
  collection="pages"
  slug="home"
  {drift}
  locales={['en', 'de']}
  {uiLocale}
  onresolved={() => {}}
/>
