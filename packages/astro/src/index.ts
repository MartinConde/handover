import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  type ContentFile,
  type ContentIndex,
  checkCollections,
  checkI18n,
  contentPathErrors,
  fieldsFrom,
  indexFrom,
  type JsonSchema,
  type Mailer,
  type Preset,
  parseEntry,
  type RichtextTier,
  redirectsText,
  refErrors,
  richtextErrors,
  schemaVersionError,
  type TitleFields,
  type Translate,
  timestampErrors,
  unsafeLinkScheme,
} from '@handover/core';
import type { AstroIntegration } from 'astro';
import { z } from 'astro/zod';
import type { ViteDevServer } from 'vite';

export type {
  AstroContent,
  ContentEntry,
  ContentSource,
  LocaleLink,
  Mailer,
  Preset,
  RichtextTier,
  Translate,
} from '@handover/core';
export {
  entryAddress,
  entryAt,
  entryUrl,
  filterLive,
  getEntryLocales,
  globalsAt,
  isLive,
  staticSource,
} from '@handover/core';

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
const imageValue = z.object({
  src: z.string().regex(/^media\//, 'image src must be a media/ key'),
  alt: z.string().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  focal: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
});
export type Image = z.infer<typeof imageValue>;

/**
 * A picture, under the field's own preset: the ratio it is shown at, the cap it is downscaled to
 * on the way in and the optional floor the picker refuses under. The two numbers are measured
 * differently — the cap is a longest side, the floor the width of the widest crop at the ratio —
 * so a field capped at 1600 can still be chosen for one that asks for 1600.
 */
export const image = (preset: Preset = {}) => imageValue.meta({ handover: 'image', ...preset });

const fileValue = z.object({
  src: z.string().regex(/^files\//, 'file src must be a files/ key'),
  // Optional because it is the translatable half: the language a file was chosen in has a name
  // for it and the others do not until somebody types one, which must not hold up a publish.
  name: z.string().optional(),
  bytes: z.number().int().nonnegative(),
  mime: z.string(),
});
export type File = z.infer<typeof fileValue>;

/** A download. `accept` widens what the picker offers; PDF alone where it is left out. */
export const file = ({ accept }: { accept?: string[] } = {}) =>
  fileValue.meta({ handover: 'file', ...(accept ? { accept } : {}) });

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
    // The one preset a platform fixes rather than a designer: 1.91:1 at 1200 is the 1200 × 630
    // every social card asks for, so the cap and the floor are the same number.
    image: image({ ratio: '1.91:1', max: 1200, min: 1200 }).optional(),
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
      /**
       * Each language may serve this collection's entries at an address of its own, the
       * optional `slug` field in its file. Empty falls back to the file name, so turning it
       * on changes no URL until somebody fills one in.
       */
      localizedSlugs?: boolean;
    }
  >;
  /** One schema per file under `src/content/globals/<locale>/`, keyed by file name. */
  globals?: Record<string, z.ZodType>;
  /**
   * Where the site's bucket is served from — the custom domain on it, no path. Content files
   * store a `media/…` key and never a url, so this is the one place a CDN move is written down.
   * The keys that sign uploads are secrets and are never here.
   */
  media?: { publicBase: string };
  /**
   * Who sends the site's mail: one of the three providers the package ships, on the credential
   * the Worker holds, or a function of your own. Without one the admin offers no test email and
   * no emailed link — the same silence as a site with no translator. `from` is config rather
   * than env in every case: an address is not a secret and the settings screen shows it.
   */
  mailer?:
    | Mailer
    | { provider: 'resend'; from: string }
    /** `host` is not a secret, so it is named here; `SMTP_USER` and `SMTP_PASS` are. */
    | { provider: 'smtp'; from: string; host: string; port?: number }
    /** Cloudflare Email Sending, through a `send_email` binding named `EMAIL`. */
    | { provider: 'cloudflare'; from: string };
  /** Required, a one-language site too: the files live in a locale folder either way. */
  i18n: {
    /** The folder names under `src/content/<collection>/`: `'en'`, `'de'`, `'pt-br'`. */
    locales: string[];
    defaultLocale: string;
    /** Whether the default locale's URLs carry its segment. Astro's `routing.prefixDefaultLocale`. */
    prefixDefaultLocale?: boolean;
    /**
     * What machine-translates a field, when it is not DeepL: given the texts and the two
     * languages, the same texts translated, in order. Without one, `DEEPL_API_KEY` is used;
     * without either, the admin offers no machine translation at all.
     */
    translate?: Translate;
  };
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
  const errors = [
    ...checkI18n('default', config.i18n),
    ...checkCollections('default', config.collections, config.globals),
  ];
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
  // Its twin: with localized slugs the site's own route reads the file's `slug`, so the schema
  // has to declare one — and leave it optional, since an empty address falls back to the name.
  for (const [name, c] of Object.entries(config.collections)) {
    if (!c.localizedSlugs) continue;
    const at = `cms.config.ts › collections.${name}.localizedSlugs: `;
    if (!c.route)
      errors.push(
        `${at}this collection has no route, so an address has nothing to be a segment of — give it a route, or drop localizedSlugs`,
      );
    const found = fieldsFrom('default', formSchema(c.schema)).find((f) => f.path[0] === 'slug');
    if (found?.type !== 'text')
      errors.push(
        `${at}this collection's schema has no optional "slug" text field — add slug: z.string().optional() to it, since the site's own route reads it`,
      );
    else if (found.required)
      errors.push(
        `${at}"slug" is required in this collection's schema — make it optional, since an empty address falls back to the file name`,
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
const VIRTUAL_LOADERS = 'virtual:handover/loaders';

/**
 * `virtual:handover/loaders`: the site's own `src/loaders/<name>.ts`, keyed by the name a
 * collection's `load` gives it. Preview renders a page by calling the loader that page's own
 * route calls, so this is the only place the package reaches into the site's `src/`.
 */
export function loadersModule(root: URL, collections: HandoverConfig['collections']): string {
  const names = [...new Set(Object.values(collections).flatMap((c) => (c.load ? [c.load] : [])))];
  const at = (name: string) => JSON.stringify(fileURLToPath(new URL(`src/loaders/${name}`, root)));
  return [
    ...names.map((name, i) => `import * as m${i} from ${at(name)};`),
    `export default { ${names.map((name, i) => `${JSON.stringify(name)}: m${i}`).join(', ')} };`,
  ].join('\n');
}

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
 * Every `.yaml` under `src/content/`, not just the two levels an entry lives at, because a
 * file anywhere else is a mistake the build should name rather than a row the list would
 * quietly be missing.
 */
export async function contentFiles(root: URL): Promise<ContentFile[]> {
  const dir = fileURLToPath(new URL('src/content/', root));
  const found = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return Promise.all(
    found
      .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
      .map(async (e) => {
        const path = `src/content/${relative(dir, join(e.parentPath, e.name)).split(sep).join('/')}`;
        return { path, contents: await readFile(new URL(path, root), 'utf8') };
      }),
  );
}

/**
 * What the build refuses about the content files themselves: a path the CMS cannot address, a
 * date the two YAML parsers disagree about, a `_ref` naming a global nothing declares, and a
 * declared global whose default-language file was never written. Astro's content sync runs before
 * `astro:build:start`, so this has to be `astro:config:done` or the loader gets there first
 * with `Expected type "string", received "object"`.
 */
export async function contentErrors(
  root: URL,
  globals: Iterable<string> = [],
  defaultLocale?: string,
): Promise<string[]> {
  const files = await contentFiles(root);
  const paths = new Set(files.map((f) => f.path));
  return [
    ...contentPathErrors('default', paths),
    ...files.flatMap((f) => [
      ...timestampErrors('default', f.path, f.contents),
      ...refErrors('default', f.path, f.contents, globals),
    ]),
    // A declared global with no file is a card in Site settings that opens nothing: the admin
    // edits the file a language has, and only the dev can write the first one.
    ...(defaultLocale === undefined
      ? []
      : [...globals]
          .map((key) => [key, `src/content/globals/${defaultLocale}/${key}.yaml`] as const)
          .filter(([, path]) => !paths.has(path))
          .map(
            ([key, path]) =>
              `cms.config.ts › globals.${key}: declared, but ${path} does not exist — write the file the default language reads, or drop the key`,
          )),
  ];
}

/**
 * The entry list needs a title for every entry and git is slow to list, so the titles are
 * read at build time instead.
 */
export async function buildIndex(root: URL, titleFields: TitleFields = {}): Promise<ContentIndex> {
  const files = await contentFiles(root);
  const errors = contentPathErrors(
    'default',
    files.map((f) => f.path),
  );
  if (errors.length) throw new Error(errors.join('\n'));
  return indexFrom('default', files, titleFields);
}

// Astro's own i18n block, as `astro:config:setup` resolves it. A locale is either the
// folder name or `{ path, codes }`, where the path is the folder and the URL segment.
type AstroI18n = {
  locales?: unknown;
  defaultLocale?: unknown;
  routing?: unknown;
};

/**
 * Where the two copies of the locale list disagree. Astro routes from its own; the CMS
 * writes files and preview paths from ours, so a drift would put a German file under a
 * folder Astro never builds — silently, until someone opens the page.
 */
function i18nErrors(cms: HandoverConfig['i18n'], astro: AstroI18n | undefined): string[] {
  const at = (key: string) => `cms.config.ts › i18n.${key}: `;
  const is = (them: unknown, key: string) => `is not astro.config.mjs's i18n.${key} ${them}`;
  if (!astro)
    return [
      `astro.config.mjs has no i18n block: cms.config.ts declares ${JSON.stringify(cms.locales)}, so astro.config.mjs needs i18n: { locales: ${JSON.stringify(cms.locales)}, defaultLocale: ${JSON.stringify(cms.defaultLocale)} }. The two must match exactly.`,
    ];
  const errors: string[] = [];
  const locales = (Array.isArray(astro.locales) ? astro.locales : []).map((l) =>
    typeof l === 'string' ? l : (l as { path?: string }).path,
  );
  if (JSON.stringify(cms.locales) !== JSON.stringify(locales))
    errors.push(
      `${at('locales')}${JSON.stringify(cms.locales)} ${is(JSON.stringify(locales), 'locales')}; the two must match exactly, in order`,
    );
  if (cms.defaultLocale !== astro.defaultLocale)
    errors.push(
      `${at('defaultLocale')}${JSON.stringify(cms.defaultLocale)} ${is(JSON.stringify(astro.defaultLocale), 'defaultLocale')}; the two must match exactly`,
    );
  const routing = astro.routing as { prefixDefaultLocale?: boolean } | 'manual' | undefined;
  const prefix = (typeof routing === 'object' ? routing.prefixDefaultLocale : false) ?? false;
  if ((cms.prefixDefaultLocale ?? false) !== prefix)
    errors.push(
      `${at('prefixDefaultLocale')}${cms.prefixDefaultLocale ?? false} ${is(prefix, 'routing.prefixDefaultLocale')}; the two must match exactly`,
    );
  return errors;
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
      'astro:config:done': async ({ config }) => {
        root = config.root;
        clientDir = config.build.client;
        const errors = await contentErrors(
          root,
          Object.keys(cms.globals ?? {}),
          cms.i18n.defaultLocale,
        );
        if (errors.length) throw new Error(`\n${errors.join('\n')}`);
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
        const drift = i18nErrors(cms.i18n, config.i18n);
        if (drift.length) throw new Error(`\n${drift.join('\n')}`);
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
        // Preview renders draft content on the client's own domain, so a site that did not ask
        // for it does not get the route at all — the flag is read here, at build, and nothing
        // downstream can turn it back on. `0` and `false` are somebody saying no.
        const flag = process.env.PREVIEW_ENABLED;
        if (flag !== undefined && !['', '0', 'false'].includes(flag))
          injectRoute({
            pattern: '/_preview/[...path]',
            entrypoint: new URL('../components/Preview.astro', import.meta.url),
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
              // The site's own `src/loaders/*.ts`, keyed by the name each collection's `load`
              // gives it: the preview route calls the page's own loader and renders the
              // component it names, which is the whole of the template convention's seam.
              {
                name: 'handover-loaders',
                resolveId: (id) => (id === VIRTUAL_LOADERS ? `\0${VIRTUAL_LOADERS}` : undefined),
                load: (id) =>
                  id === `\0${VIRTUAL_LOADERS}`
                    ? loadersModule(config.root, cms.collections)
                    : undefined,
              },
            ],
          },
        });
      },
    },
  };
}
