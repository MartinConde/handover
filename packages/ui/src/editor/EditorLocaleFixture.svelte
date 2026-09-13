<script lang="ts">
import type { Drift, Field } from '@handover/core';
import type { UiLocale } from '../i18n.js';
import Editor from './Editor.svelte';

let {
  initialUiLocale = 'en',
  publishState = 'clean',
  feedback = false,
}: {
  initialUiLocale?: UiLocale;
  publishState?: 'clean' | 'drift' | 'missing';
  feedback?: boolean;
} = $props();
// svelte-ignore state_referenced_locally -- each test mount intentionally fixes its initial locale
let uiLocale = $state<UiLocale>(initialUiLocale);
// svelte-ignore state_referenced_locally -- each test mount intentionally fixes its state variant
const drift: Drift[] =
  publishState === 'drift'
    ? [
        {
          path: 'blocks[_id=z9y8x7w6]',
          type: 'quote',
          in: ['de'],
          expected: ['en', 'de'],
          values: { de: ['Ein seltener Fund.'] },
        },
      ]
    : [];
// svelte-ignore state_referenced_locally -- each test mount intentionally fixes its state variant
const entry = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    ...(feedback
      ? [{ path: ['summary'], label: 'Summary', type: 'text', required: false } satisfies Field]
      : []),
  ] satisfies Field[],
  blocks: {},
  data: { title: 'Seaview Cottage', ...(feedback ? { summary: '' } : {}) },
  pending: [] as string[],
  published: ['en'],
  problems: feedback
    ? [{ path: 'summary', message: 'Required', descriptor: { code: 'FIELD_REQUIRED' } }]
    : publishState === 'missing'
      ? [{ path: 'title', message: 'Authored title requirement' }]
      : ([] as { path: string; message: string }[]),
  locales: ['en', 'de'],
  defaultLocale: 'en',
  sourceLocale: 'en',
  offered: ['en'],
  translations: {} as Record<string, Record<string, unknown>>,
  stale: [] as string[],
  drift,
  route: '/listings/[slug]',
  localizedSlugs: true,
  addresses: { en: '' },
};
</script>

<button data-locale-switch type="button" onclick={() => (uiLocale = uiLocale === 'en' ? 'de' : 'en')}>{uiLocale === 'en' ? 'Deutsch' : 'English'}</button>
<Editor
  collection="listings"
  slug="seaview-cottage"
  {entry}
  preview
  {uiLocale}
  onchanged={() => {}}
/>
