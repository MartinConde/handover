<script lang="ts">
import type { UiLocale } from '../i18n.js';
import Crop from './Crop.svelte';
import Focal from './Focal.svelte';
import type { MediaItem } from './upload.js';

let uiLocale = $state<UiLocale>('en');
let dialog = $state<'focal' | 'crop' | undefined>('focal');
let focalSaves = $state<[number, number][]>([]);
let made = $state<MediaItem[]>([]);

const item: MediaItem = {
  id: 'original',
  src: 'media/original.webp',
  url: 'https://cdn.example.com/original.webp',
  filename: 'Harbour original.jpg',
  width: 2400,
  height: 1600,
};
</script>

<button data-locale-switch type="button" onclick={() => (uiLocale = uiLocale === 'en' ? 'de' : 'en')}>
  {uiLocale === 'en' ? 'Deutsch' : 'English'}
</button>
<button data-open-crop type="button" onclick={() => (dialog = 'crop')}>Open crop</button>
<output data-focal-saves>{JSON.stringify(focalSaves)}</output>
<output data-made-count>{made.length}</output>

{#if dialog === 'focal'}
  <Focal
    name="Harbour original.jpg"
    url={item.url ?? ''}
    focal={[0.5, 0.5]}
    presets={[{ label: 'Homepage hero', preset: { ratio: '16:9', max: 2400 } }]}
    {uiLocale}
    onsave={(point) => {
      focalSaves = [...focalSaves, point];
      dialog = undefined;
    }}
    onclose={() => (dialog = undefined)}
  />
{:else if dialog === 'crop'}
  <Crop
    {item}
    ratios={['16:9']}
    {uiLocale}
    onmade={(copy) => (made = [...made, copy])}
    onclose={() => (dialog = undefined)}
  />
{/if}
