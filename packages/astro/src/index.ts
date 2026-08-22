import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RichtextTier, richtextErrors } from '@handover/core';
import type { AstroIntegration } from 'astro';
import { z } from 'astro/zod';

export type { AstroContent, ContentEntry, ContentSource, RichtextTier } from '@handover/core';
export { filterLive, isLive, staticSource } from '@handover/core';

// Markdown, validated against the tier's construct list; the first offending construct
// is the message so the editor can say what was dropped.
export const richtext = (tier: RichtextTier = 'basic') =>
  z
    .string()
    .superRefine((md, ctx) => {
      const [message] = richtextErrors('default', md, tier);
      if (message) ctx.addIssue({ code: 'custom', message });
    })
    .meta({ handover: 'richtext', tier });

// `.meta({ handover })` is how core's schema walker recognises a shape it does not own.
const linkExtras = { label: z.string().optional(), newTab: z.boolean().optional() };
export const link = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('url'), href: z.string(), ...linkExtras }),
    z.object({ type: z.enum(['entry', 'page']), ref: z.string(), ...linkExtras }),
  ])
  .meta({ handover: 'link' });
export type Link = z.infer<typeof link>;

// Media is stored as a key under media.publicBase, never a URL: a CDN move must not
// touch content files.
export const image = z
  .object({
    src: z.string().regex(/^media\//, 'image src must be a media/ key'),
    alt: z.string().optional(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    focal: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
  })
  .meta({ handover: 'image' });
export type Image = z.infer<typeof image>;

export const file = z
  .object({
    src: z.string().regex(/^files\//, 'file src must be a files/ key'),
    name: z.string(),
    bytes: z.number().int().nonnegative(),
    mime: z.string(),
  })
  .meta({ handover: 'file' });
export type File = z.infer<typeof file>;

// Provider + id only; the iframe src is built from a template at render, so no raw HTML
// can reach the page from a content file.
export const embed = z
  .strictObject({
    provider: z.enum(['youtube', 'vimeo', 'google-maps']),
    id: z
      .string()
      .min(1)
      .regex(/^[^<>]+$/, 'embed id must not contain markup'),
    title: z.string().optional(),
    start: z.number().int().nonnegative().optional(),
  })
  .meta({ handover: 'embed' });
export type Embed = z.infer<typeof embed>;

export const seo = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    image: image.optional(),
    noindex: z.boolean().optional(),
    canonical: z.string().optional(),
  })
  .meta({ handover: 'seo' });
export type Seo = z.infer<typeof seo>;

// Stored as `collection/slug`; the collection name lets the picker list the right entries.
export const reference = (collection: string) =>
  z
    .string()
    .regex(/^[^\s/]+\/[^\s/]+$/, 'reference must be collection/slug')
    .meta({ handover: 'reference', collection });

// A block as stored. TypeScript cannot infer through a recursive discriminated union, so
// the union is annotated with this hand-written type and the registered schemas narrow it.
export interface Block {
  _type: string;
  _id: string;
  _label?: string;
  _ref?: string;
  [field: string]: unknown;
}
export type BlockRegistry = Record<string, z.ZodType<Block>>;

export function defineBlock<T extends string, F extends z.ZodRawShape>(type: T, fields: F) {
  return z.object({
    _type: z.literal(type),
    _id: z.string(),
    _label: z.string().optional(),
    _ref: z.string().optional(),
    ...fields,
  });
}

// The registry is a thunk because a block that nests `blocks` refers to the registry from
// inside its own initializer. A `_ref` block carries no fields of its own: its content
// is filled from the global at build time.
export function blocks(registry: () => BlockRegistry): z.ZodType<Block[]> {
  const ref = z.object({
    _type: z.string(),
    _id: z.string(),
    _label: z.string().optional(),
    _ref: z.string().regex(/^globals\/[^\s/]+$/, '_ref must be globals/<key>'),
  });
  const block = z.lazy(() =>
    z.union([
      ref.refine((b) => b._type in registry(), 'unregistered block type'),
      z.union(Object.values(registry())),
    ]),
  );
  return z.array(block).meta({
    handover: 'blocks',
    get types() {
      return Object.keys(registry());
    },
  });
}

export interface HandoverConfig {
  collections: Record<string, { schema: z.ZodType }>;
}

export function defineConfig(config: HandoverConfig): HandoverConfig {
  return config;
}

export const NO_ADAPTER_MESSAGE =
  'astro-handover needs an SSR adapter: add `adapter: cloudflare()` from `@astrojs/cloudflare` to astro.config.';

const VIRTUAL_CONFIG = 'virtual:handover/config';
const VIRTUAL_UI = 'virtual:handover/ui';

// The pre-built SPA (packages/ui → dist/ui) is inlined into the Worker bundle because a
// Worker has no filesystem and the site's own build config must not know about it.
export async function uiAssetsModule(dir: string): Promise<string> {
  const names = (await readdir(dir)).filter((n) => /\.(js|css)$/.test(n)).sort();
  const files = await Promise.all(
    names.map(async (n) => [n, await readFile(join(dir, n), 'utf8')]),
  );
  return `export default ${JSON.stringify(Object.fromEntries(files))};`;
}

export default function handover(): AstroIntegration {
  return {
    name: 'astro-handover',
    hooks: {
      'astro:config:setup': ({ config, logger, injectRoute, addMiddleware, updateConfig }) => {
        if (!config.adapter) throw new Error(NO_ADAPTER_MESSAGE);
        logger.info('astro-handover integration loaded');

        injectRoute({
          pattern: '/admin/[...path]',
          entrypoint: new URL('./routes/admin.js', import.meta.url),
          prerender: false,
        });
        injectRoute({
          pattern: '/admin/api/[...path]',
          entrypoint: new URL('./routes/api.js', import.meta.url),
          prerender: false,
        });
        addMiddleware({ order: 'pre', entrypoint: new URL('./middleware.js', import.meta.url) });

        // The site's own cms.config.ts, so the Worker holds the real Zod objects.
        const cmsConfig = fileURLToPath(new URL('./cms.config.ts', config.root));
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'handover-config',
                resolveId: (id) => (id === VIRTUAL_CONFIG ? cmsConfig : undefined),
              },
              {
                name: 'handover-ui',
                resolveId: (id) => (id === VIRTUAL_UI ? `\0${VIRTUAL_UI}` : undefined),
                load: (id) =>
                  id === `\0${VIRTUAL_UI}`
                    ? uiAssetsModule(fileURLToPath(new URL('./ui/', import.meta.url)))
                    : undefined,
              },
            ],
          },
        });
      },
    },
  };
}
