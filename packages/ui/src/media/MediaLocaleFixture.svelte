<script lang="ts">
import type { UiLocale } from '../i18n.js';
import Media from './Media.svelte';

let uiLocale = $state<UiLocale>('en');
</script>

<button data-locale-switch type="button" onclick={() => (uiLocale = uiLocale === 'en' ? 'de' : 'en')}>
  {uiLocale === 'en' ? 'Deutsch' : 'English'}
</button>
<Media
  kind="images"
  label="Hero image"
  preset={{ ratio: '16:9', max: 2400, min: 800 }}
  many
  {uiLocale}
  onpick={() => {}}
  onclose={() => {}}
/>
