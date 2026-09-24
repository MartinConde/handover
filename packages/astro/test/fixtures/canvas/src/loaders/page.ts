import { getCollection, getEntry } from 'astro:content';
import type { z } from 'astro/zod';
import {
  type ContentSource,
  staticSource as createStaticSource,
  entryAt,
  globalsAt,
} from 'astro-handover';
import cms, { type page } from '../../cms.config';

export { default as Page } from '../components/FixturePage.astro';

type Page = z.infer<typeof page>;
type Source = ContentSource<{ pages: Page; globals: unknown }>;

export const staticSource: Source = createStaticSource('default', {
  getEntry: async (collection, id) => getEntry(collection, id),
  getCollection: (collection) => getCollection(collection),
});

export async function load(source: Source, { locale, slug }: { locale: string; slug: string }) {
  const entry = await entryAt('default', source, cms, 'pages', locale, slug);
  if (!entry) return undefined;
  return {
    data: entry.data,
    locale,
    globals: await globalsAt('default', source, locale, { blocks: entry.data.blocks }),
  };
}
