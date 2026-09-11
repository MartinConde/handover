import { z } from 'astro/zod';
import {
  type BlockRegistry,
  blocks,
  defineBlock,
  defineConfig,
  link,
  richtext,
} from 'astro-handover';

const repeated = defineBlock('repeated', { heading: z.string() });
const promo = defineBlock('promo', { heading: z.string() });
const columns = defineBlock('columns', {
  columns: z.array(z.object({ _id: z.string(), blocks: blocks(() => registry) })),
});

export const registry: BlockRegistry = { repeated, promo, columns };
export const page = z.object({
  title: z.string(),
  summary: richtext().optional(),
  body: richtext('full').optional(),
  button: link.optional(),
  // Deliberately unrefined here: the browser fixture exercises a code-edited value that the
  // editor-facing basic rich-text field must preserve without activating TipTap.
  legacy: z.string().optional(),
  blocks: blocks(() => registry),
});
export const sharedPromo = z.object({ heading: z.string() });

export default defineConfig({
  i18n: { locales: ['en', 'de'], defaultLocale: 'en' },
  collections: {
    pages: { schema: page, route: '/[slug]', load: 'page' },
  },
  globals: { 'shared-promo': sharedPromo },
});
