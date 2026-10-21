<script lang="ts">
import type { Field } from '@handover/core';
import { untrack } from 'svelte';
import type { UiLocale } from '../i18n.js';
import { createEntrySession } from './entry-session.svelte';
import Translation from './Translation.svelte';

let { initialUiLocale = 'en' }: { initialUiLocale?: UiLocale } = $props();
// The fixture owns the live preference.
let uiLocale = $state<UiLocale>(untrack(() => initialUiLocale));
const fields = [
  { path: ['title'], label: 'Title', type: 'text', required: false },
] satisfies Field[];
const session = createEntrySession({
  sourceLocale: 'en',
  data: { title: 'Harbour house' },
  translations: { de: { title: 'Haus am Hafen', _machine: ['title'] } },
  revisions: { en: 'source-1', de: 'target-1' },
  form: { fields, blocks: {} },
});
session.configureAutosave(async () => true);
</script>

<button data-locale-switch type="button" onclick={() => (uiLocale = uiLocale === 'en' ? 'de' : 'en')}>
  {uiLocale === 'en' ? 'Deutsch' : 'English'}
</button>
<Translation
  collection="listings"
  slug="harbour-house"
  locale="de"
  {session}
  {fields}
  blocks={{}}
  bind:data={session.snapshots.de!}
  source="en"
  stale
  translator
  {uiLocale}
/>
