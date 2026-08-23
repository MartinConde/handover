import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ContentIndex,
  checkCollections,
  contentPathErrors,
  fieldsFrom,
  indexFrom,
  type JsonSchema,
  parseEntry,
  type RichtextTier,
  redirectsText,
  richtextErrors,
  schemaVersionError,
  type TitleFields,
  unsafeLinkScheme,
} from '@handover/core';
import type { AstroIntegration } from 'astro';
import { z } from 'astro/zod';
import type { ViteDevServer } from 'vite';

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
// Same allow-list as a richtext link: the target of anything an editor can click is
// http, https, mailto, tel or a path on this site, never a scheme that runs code.
const href = z.string().superRefine((url, ctx) => {
  const scheme = unsafeLinkScheme('default', url);
  if (scheme) ctx.addIssue({ code: 'custom', message: `${scheme}: links are not allowed` });
});
const toUrl = z.object({ type: z.literal('url'), href });
const toRef = z.object({ type: z.enum(['entry', 'page']), ref: z.string() });
const linkExtras = { label: z.string().optional(), newTab: z.boolean().optional() };
export const link = z
  .discriminatedUnion('type', [toUrl.extend(linkExtras), toRef.extend(linkExtras)])
  .meta({ handover: 'link' });
export type Link = z.infer<typeof link>;

// The `navigation` global: menus by key, items nesting through `children`. The item owns
// `newTab`, so its link is the bare target.
export interface NavItem {
  _id: string;
  _locales?: string[];
  label: string;
  link: z.infer<typeof toUrl> | z.infer<typeof toRef>;
  newTab?: boolean;
  children?: NavItem[];
}
const navItem: z.ZodType<NavItem> = z.lazy(() =>
  z.strictObject({
    _id: z.string(),
    _locales: z.array(z.string()).optional(),
    label: z.string(),
    link: z.discriminatedUnion('type', [toUrl.strict(), toRef.strict()]),
    newTab: z.boolean().optional(),
    children: z.array(navItem).optional(),
  }),
);
export const navigation = z.object({
  menus: z.array(z.object({ _id: z.string(), key: z.string(), items: z.array(navItem) })),
});
export type Navigation = z.infer<typeof navigation>;

// `src/content/redirects.yaml`; the build emits it as `_redirects`, see emitRedirects.
export const redirects = z.object({
  rules: z.array(
    z.object({
      _id: z.string(),
      from: z.string().regex(/^\//, 'a path starting with "/"'),
      to: z.string().regex(/^(\/|https?:\/\/)/, 'a path or an absolute URL'),
      status: z.literal(301),
      reason: z.enum(['slug-change', 'hidden', 'deleted', 'manual']),
      entry: z.string().optional(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type RedirectRule = z.infer<typeof redirects>['rules'][number];

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
  collections: Record<
    string,
    {
      schema: z.ZodType;
      /** Detail page, `[slug]` is the filename: `'/blog/[slug]'`. */
      route?: string;
      /** The listing page, a fixed path: `'/blog'`. */
      index?: string;
      /** Loader name, `'post'` for `src/loaders/post.ts`. */
      load?: string;
      /** The field the entry list shows, when it is not `title`: `'name'`. */
      titleField?: string;
    }
  >;
  /** One schema per file under `src/content/globals/<locale>/`, keyed by file name. */
  globals?: Record<string, z.ZodType>;
}

// What the form is generated from. The input side, so a transform shows the value the
// editor types; `z.date()` is named a date because Zod cannot represent it itself.
export function formSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema._zod.def.type === 'date')
        Object.assign(jsonSchema, { type: 'string', format: 'date' });
    },
  }) as JsonSchema;
}

export function defineConfig(config: HandoverConfig): HandoverConfig {
  const errors = checkCollections('default', config.collections, config.globals);
  // The one config key that has to agree with a schema, and this is the only place holding
  // both: a titleField naming nothing would drop the name typed into New entry in silence.
  for (const [name, c] of Object.entries(config.collections)) {
    if (!c.titleField) continue;
    const found = fieldsFrom('default', formSchema(c.schema)).find(
      (f) => f.path[0] === c.titleField,
    );
    if (found?.type !== 'text')
      errors.push(
        `cms.config.ts › collections.${name}.titleField: ${JSON.stringify(c.titleField)} is not a text field of this collection's schema`,
      );
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return config;
}

export const NO_ADAPTER_MESSAGE =
  'astro-handover needs an SSR adapter: add `adapter: cloudflare()` from `@astrojs/cloudflare` to astro.config.';

const VIRTUAL_CONFIG = 'virtual:handover/config';
const VIRTUAL_UI = 'virtual:handover/ui';
const VIRTUAL_INDEX = 'virtual:handover/index';

// The pre-built SPA (packages/ui → dist/ui) is inlined into the Worker bundle because a
// Worker has no filesystem and the site's own build config must not know about it.
export async function uiAssetsModule(dir: string): Promise<string> {
  const names = (await readdir(dir)).filter((n) => /\.(js|css)$/.test(n)).sort();
  const files = await Promise.all(
    names.map(async (n) => [n, await readFile(join(dir, n), 'utf8')]),
  );
  return `export default ${JSON.stringify(Object.fromEntries(files))};`;
}

// Workers Static Assets serves `_redirects` from the client output; the Cloudflare adapter's
// own hook runs after this one and appends Astro's config redirects to the same file.
export async function emitRedirects(root: URL, clientDir: URL): Promise<number> {
  const path = 'src/content/redirects.yaml';
  const source = await readFile(new URL(path, root), 'utf8').catch(() => undefined);
  if (source === undefined) return 0;
  const parsed = redirects.safeParse(parseEntry('default', source));
  if (!parsed.success) {
    const at = (p: PropertyKey[]) =>
      p
        .map((k, i) => (typeof k === 'number' ? `[${k}]` : i ? `.${String(k)}` : String(k)))
        .join('');
    throw new Error(
      parsed.error.issues.map((i) => `${path} › ${at(i.path)}: ${i.message}`).join('\n'),
    );
  }
  await mkdir(clientDir, { recursive: true });
  await appendFile(new URL('_redirects', clientDir), redirectsText('default', parsed.data.rules));
  return parsed.data.rules.length;
}

/**
 * The entry list needs a title for every entry and git is slow to list, so the titles are
 * read at build time instead. Every `.yaml` under `src/content/` is walked, not just the
 * two levels an entry lives at, because a file anywhere else is a mistake the build should
 * name rather than a row the list would quietly be missing.
 */
export async function buildIndex(root: URL, titleFields: TitleFields = {}): Promise<ContentIndex> {
  const base = new URL('src/content/', root);
  const dir = fileURLToPath(base);
  const found = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  const paths = found
    .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
    .map((e) => `src/content/${relative(dir, join(e.parentPath, e.name)).split(sep).join('/')}`);
  const errors = contentPathErrors('default', paths);
  if (errors.length) throw new Error(errors.join('\n'));
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      contents: await readFile(new URL(path, root), 'utf8'),
    })),
  );
  return indexFrom('default', files, titleFields);
}

/**
 * The site's own `cms.config.ts`, imported by `astro.config.mjs` and passed in. The Worker
 * gets the same file through `virtual:handover/config`; this copy is for the build, which
 * cannot execute TypeScript and needs to know which field each collection lists by.
 */
export default function handover(cms: HandoverConfig): AstroIntegration {
  const titleFields = Object.fromEntries(
    Object.entries(cms.collections).flatMap(([name, c]) =>
      c.titleField ? [[name, c.titleField]] : [],
    ),
  );
  let root: URL;
  let clientDir: URL;
  return {
    name: 'astro-handover',
    hooks: {
      'astro:config:done': ({ config }) => {
        root = config.root;
        clientDir = config.build.client;
      },
      // Deploy applies migrations/ before the new code is live, so a migrations/ that is
      // behind the package's tables is caught here, not by the first query.
      'astro:build:start': async () => {
        const marker = await readFile(new URL('migrations/handover.json', root), 'utf8').catch(
          () => undefined,
        );
        const error = schemaVersionError(marker);
        if (error) throw new Error(error);
      },
      'astro:build:done': async ({ logger }) => {
        const n = await emitRedirects(root, clientDir);
        if (n) logger.info(`Wrote ${n} redirect${n === 1 ? '' : 's'} to _redirects`);
      },
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
        const contentDir = fileURLToPath(new URL('src/content/', config.root));
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'handover-config',
                resolveId: (id) => (id === VIRTUAL_CONFIG ? cmsConfig : undefined),
              },
              // The index goes into the Worker bundle rather than the static assets: served
              // as an asset it would be a public list of every entry's title, hidden ones
              // included. Rebuilt on a content change so the dev server does not go stale.
              {
                name: 'handover-index',
                resolveId: (id) => (id === VIRTUAL_INDEX ? `\0${VIRTUAL_INDEX}` : undefined),
                load: async (id) =>
                  id === `\0${VIRTUAL_INDEX}`
                    ? `export default JSON.parse(${JSON.stringify(JSON.stringify(await buildIndex(config.root, titleFields)))});`
                    : undefined,
                configureServer(server: ViteDevServer) {
                  server.watcher.on('all', (_event, file) => {
                    if (!file.includes(contentDir)) return;
                    const mod = server.moduleGraph.getModuleById(`\0${VIRTUAL_INDEX}`);
                    if (mod) server.moduleGraph.invalidateModule(mod);
                  });
                },
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
