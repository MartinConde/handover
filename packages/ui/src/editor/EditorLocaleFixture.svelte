<script lang="ts">
import type { Field } from '@handover/core';
import type { UiLocale } from '../i18n.js';
import Editor from './Editor.svelte';

let uiLocale = $state<UiLocale>('en');
const entry = {
  fields: [{ path: ['title'], label: 'Title', type: 'text', required: true }] satisfies Field[],
  blocks: {},
  data: { title: 'Seaview Cottage' },
  pending: [] as string[],
  published: ['en'],
  problems: [] as { path: string; message: string }[],
  locales: ['en', 'de'],
  defaultLocale: 'en',
  sourceLocale: 'en',
  offered: ['en'],
  translations: {} as Record<string, Record<string, unknown>>,
  stale: [] as string[],
  drift: [],
  route: '/listings/[slug]',
  localizedSlugs: true,
  addresses: { en: '' },
};
</script>

<button data-locale-switch type="button" onclick={() => (uiLocale = 'de')}>Deutsch</button>
<Editor
  collection="listings"
  slug="seaview-cottage"
  {entry}
  preview
  {uiLocale}
  onchanged={() => {}}
/>
