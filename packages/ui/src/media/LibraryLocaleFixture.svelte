<script lang="ts">
import type { UiLocale } from '../i18n.js';
import Library from './Library.svelte';

let uiLocale = $state<UiLocale>('en');
</script>

<button data-locale-switch type="button" onclick={() => (uiLocale = uiLocale === 'en' ? 'de' : 'en')}>
  {uiLocale === 'en' ? 'Deutsch' : 'English'}
</button>
<Library base="https://cdn.example.com" {uiLocale} />
