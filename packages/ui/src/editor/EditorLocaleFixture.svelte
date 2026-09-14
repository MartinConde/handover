<script lang="ts">
import type { Drift, Field } from '@handover/core';
import type { UiLocale } from '../i18n.js';
import Editor from './Editor.svelte';

let {
  initialUiLocale = 'en',
  publishState = 'clean',
  feedback = false,
  scalarFeedback = false,
  targetOffered = false,
  translator = false,
  pending = false,
  restored,
}: {
  initialUiLocale?: UiLocale;
  publishState?: 'clean' | 'drift' | 'missing';
  feedback?: boolean;
  scalarFeedback?: boolean;
  targetOffered?: boolean;
  translator?: boolean;
  pending?: boolean;
  restored?: string;
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
    ...(scalarFeedback
      ? ([
          { path: ['count'], label: 'Count', type: 'number', required: true },
          { path: ['featured'], label: 'Featured', type: 'boolean', required: true },
          { path: ['availableFrom'], label: 'Available from', type: 'date', required: true },
          {
            path: ['status'],
            label: 'Status',
            type: 'select',
            required: true,
            options: ['one', 'two', 'three', 'four', 'five', 'six'],
          },
          { path: ['note'], label: 'Note', type: 'text', required: false },
        ] satisfies Field[])
      : []),
  ] satisfies Field[],
  blocks: {},
  data: {
    title: 'Seaview Cottage',
    ...(feedback ? { summary: '' } : {}),
    ...(scalarFeedback
      ? { count: 0, featured: true, availableFrom: 'wrong', status: '', note: '' }
      : {}),
  },
  pending: pending ? ['en'] : ([] as string[]),
  published: ['en'],
  problems: scalarFeedback
    ? [
        { path: 'title', message: 'Required', descriptor: { code: 'FIELD_REQUIRED' } },
        {
          path: 'count',
          message: 'Too small: expected number to be >1.5',
          descriptor: { code: 'FIELD_NUMBER_TOO_SMALL', inclusive: false, limit: 1.5 },
        },
        {
          path: 'featured',
          message: 'Invalid input: expected boolean, received string',
          descriptor: { code: 'FIELD_EXPECTED_BOOLEAN' },
        },
        {
          path: 'availableFrom',
          message: 'Invalid ISO date',
          descriptor: { code: 'FIELD_INVALID_DATE' },
        },
        {
          path: 'status',
          message: 'Invalid option',
          descriptor: { code: 'FIELD_INVALID_SELECTION' },
        },
        { path: 'note', message: 'Use the newsroom wording' },
      ]
    : feedback
      ? [{ path: 'summary', message: 'Required', descriptor: { code: 'FIELD_REQUIRED' } }]
      : publishState === 'missing'
        ? [{ path: 'title', message: 'Authored title requirement' }]
        : ([] as { path: string; message: string }[]),
  locales: ['en', 'de'],
  defaultLocale: 'en',
  sourceLocale: 'en',
  offered: targetOffered ? ['en', 'de'] : ['en'],
  translations: {} as Record<string, Record<string, unknown>>,
  stale: [] as string[],
  drift,
  translator,
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
  {restored}
  {uiLocale}
  onchanged={() => {}}
/>
