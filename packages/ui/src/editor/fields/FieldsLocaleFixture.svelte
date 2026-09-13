<script lang="ts">
import type { Field, WordPart } from '@handover/core';
import type { UiLocale } from '../../i18n.js';
import { createEntrySession } from '../entry-session.svelte';
import Fields from './Fields.svelte';

let {
  initialUiLocale = 'en',
  refusalUrl = 'https://www.dailymotion.com/video/x8abc',
}: { initialUiLocale?: UiLocale; refusalUrl?: string } = $props();
// svelte-ignore state_referenced_locally -- each test mount intentionally fixes its initial locale
let uiLocale = $state<UiLocale>(initialUiLocale);
let commands = $state(0);

const fields = [
  {
    path: ['address'],
    label: 'Postal address',
    type: 'group',
    required: false,
    fields: [{ path: ['street'], label: 'Street name', type: 'text', required: false }],
  },
  {
    path: ['rooms'],
    label: 'Rooms',
    type: 'array',
    required: false,
    item: [{ path: ['name'], label: 'Room name', type: 'text', required: false }],
  },
  { path: ['blocks'], label: 'Page blocks', type: 'blocks', required: false, types: ['callout'] },
  { path: ['available'], label: 'Available on', type: 'date', required: false },
  { path: ['button'], label: 'Booking link', type: 'link', required: false },
  { path: ['video'], label: 'Tour video', type: 'embed', required: false },
  { path: ['seo'], label: 'Search settings', type: 'seo', required: false },
] satisfies Field[];

const blocks = {
  callout: [{ path: ['heading'], label: 'Callout heading', type: 'text', required: false }],
} satisfies Record<string, Field[]>;

const session = createEntrySession({
  sourceLocale: 'en',
  data: {
    address: { street: 'Harbour Road' },
    rooms: [{ _id: 'room0001', name: 'Sea room' }],
    blocks: [{ _id: 'block001', _type: 'callout', heading: 'Welcome aboard' }],
    available: '2026-09-13',
    button: { type: 'url', href: 'javascript:alert(1)', label: 'Book now' },
    video: { provider: 'youtube', id: 'dQw4w9WgXcQ', title: 'House tour' },
    seo: { noindex: true },
  },
  translations: {},
  form: { fields, blocks },
});
let root = $state(session.snapshot('en'));

let translatedRoot = $state<Record<string, unknown>>({ summary: 'Deutsche Zusammenfassung' });
const changed: Record<string, WordPart[]> = {
  summary: [
    { text: 'Old summary', mark: 'del' },
    { text: 'New summary', mark: 'ins' },
  ],
};
</script>

<button data-locale-switch type="button" onclick={() => (uiLocale = uiLocale === 'en' ? 'de' : 'en')}>
  {uiLocale === 'en' ? 'Deutsch' : 'English'}
</button>
<output data-refusal-url>{refusalUrl}</output>
<output data-command-count>{commands}</output>

<Fields
  {fields}
  {blocks}
  bind:root
  locale="en"
  {uiLocale}
  {session}
  oncommand={() => (commands += 1)}
/>

<Fields
  fields={[{ path: ['summary'], label: 'Summary copy', type: 'text', required: false, i18n: 'duplicate' }]}
  bind:root={translatedRoot}
  prefix="translated"
  translating
  locale="de"
  {uiLocale}
  sourceLabel="English"
  sourceChanged={changed}
  translatedAt={new Date(2026, 8, 13, 10, 15).toISOString()}
/>
