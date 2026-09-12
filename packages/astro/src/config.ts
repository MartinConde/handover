import {
  CHECKS,
  type CheckName,
  checkCollections,
  checkI18n,
  fieldsFrom,
  type JsonSchema,
  type Mailer,
  type Preset,
  type RichtextTier,
  redirectDestinationError,
  redirectSourceError,
  richtextErrors,
  SOCIAL_CARD,
  type Translate,
  unsafeLinkScheme,
} from '@handover/core';
import { z } from 'astro/zod';

// Only the first offending construct is reported, so the editor can say what was dropped.
export const richtext = (tier: RichtextTier = 'basic') =>
  z
    .string()
    .superRefine((md, ctx) => {
      const [message] = richtextErrors('default', md, tier);
      if (message) ctx.addIssue({ code: 'custom', message });
    })
    .meta({ handover: 'richtext', tier });

// The same allow-list as a richtext link: never a scheme that runs code.
const href = z.string().superRefine((url, ctx) => {
  const scheme = unsafeLinkScheme('default', url);
  if (scheme) ctx.addIssue({ code: 'custom', message: `${scheme}: links are not allowed` });
});
const toUrl = z.object({ type: z.literal('url'), href });
const toRef = z.object({ type: z.enum(['entry', 'page']), ref: z.string() });
// An index link names the collection, and each language links its own index.
const toIndex = z.object({ type: z.literal('index'), collection: z.string() });
const linkExtras = { label: z.string().optional(), newTab: z.boolean().optional() };
export const link = z
  .discriminatedUnion('type', [toUrl.extend(linkExtras), toRef.extend(linkExtras)])
  .meta({ handover: 'link' });
export type Link = z.infer<typeof link>;

// The item owns `newTab`, so its link is the bare target.
export interface NavItem {
  _id: string;
  _locales?: string[];
  label: string;
  link: z.infer<typeof toUrl> | z.infer<typeof toRef> | z.infer<typeof toIndex>;
  newTab?: boolean;
  children?: NavItem[];
}
const navItem: z.ZodType<NavItem> = z.lazy(() =>
  z.strictObject({
    _id: z.string(),
    _locales: z.array(z.string()).optional(),
    // An empty label means the page's own title, as a row synced but not yet translated reads.
    label: z.string().default(''),
    link: z.discriminatedUnion('type', [toUrl.strict(), toRef.strict(), toIndex.strict()]),
    newTab: z.boolean().optional(),
    children: z.array(navItem).optional(),
  }),
);
export const navigation = z
  .object({
    // Walkers hard-code this shape: the recursion leaves nothing to read it from the schema.
    menus: z
      .array(z.object({ _id: z.string(), key: z.string(), items: z.array(navItem) }))
      .meta({ handover: 'menus', i18n: 'duplicate' }),
  })
  // Shown on the Site settings card; a global without a label is listed under its key.
  .meta({ label: 'Navigation', description: 'The menus the site renders' });
export type Navigation = z.infer<typeof navigation>;

export const redirects = z.object({
  rules: z.array(
    z.object({
      _id: z.string(),
      from: z.string().superRefine((value, ctx) => {
        const message = redirectSourceError(value);
        if (message) ctx.addIssue({ code: 'custom', message });
      }),
      to: z.string().superRefine((value, ctx) => {
        const message = redirectDestinationError(value);
        if (message) ctx.addIssue({ code: 'custom', message });
      }),
      status: z.union([z.literal(301), z.literal(302)]),
      reason: z.enum(['slug-change', 'hidden', 'deleted', 'manual']),
      entry: z.string().optional(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type RedirectRule = z.infer<typeof redirects>['rules'][number];

// A key under media.publicBase, never a URL: a CDN move must not touch content files.
const imageValue = z.object({
  src: z.string().regex(/^media\//, 'image src must be a media/ key'),
  alt: z.string().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  focal: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
});
export type Image = z.infer<typeof imageValue>;

/** The cap is a longest side; the floor is the width of the widest crop at the ratio. */
export const image = (preset: Preset = {}) => imageValue.meta({ handover: 'image', ...preset });

const fileValue = z.object({
  src: z.string().regex(/^files\//, 'file src must be a files/ key'),
  // Optional so a language with no name for the file yet does not hold up a publish.
  name: z.string().optional(),
  bytes: z.number().int().nonnegative(),
  mime: z.string(),
});
export type File = z.infer<typeof fileValue>;

/** A download accepts any file unless `accept` narrows the picker. */
export const file = ({ accept }: { accept?: string[] } = {}) =>
  fileValue.meta({ handover: 'file', ...(accept ? { accept } : {}) });

// Provider and id only, so no raw HTML can reach the page from a content file.
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
    image: image(SOCIAL_CARD).optional(),
    noindex: z.boolean().optional(),
    // Goes into a <link> tag, so the same allow-list as anything an editor can click.
    canonical: href.optional(),
  })
  .meta({ handover: 'seo' });
export type Seo = z.infer<typeof seo>;

/** Found by the `defaultSeo` key; untagged, so the walker draws it as an ordinary group. */
export const seoDefaults = z
  .object({
    titlePattern: z
      .string()
      .optional()
      .meta({ label: 'Default search title', description: '%s becomes the page’s own title' }),
    description: z.string().optional(),
    image: image(SOCIAL_CARD).optional().meta({ label: 'Default social image' }),
    // One account for the site, written the way X wants it read: `@name`.
    twitter: z.string().optional().meta({ i18n: 'duplicate', label: 'X (Twitter) handle' }),
  })
  .meta({ label: 'Search and sharing' });
export type SeoDefaults = z.infer<typeof seoDefaults>;

// Stored as `collection/slug`; the collection name lets the picker list the right entries.
export const reference = (collection: string) =>
  z
    .string()
    .regex(/^[^\s/]+\/[^\s/]+$/, 'reference must be collection/slug')
    .meta({ handover: 'reference', collection });

// Hand-written because TypeScript cannot infer through a recursive discriminated union.
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

// A thunk: a block that nests `blocks` refers to the registry from its own initializer.
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
      /** Each language serves entries at its file's `slug`; empty falls back to the file name. */
      localizedSlugs?: boolean;
    }
  >;
  /** One schema per file under `src/content/globals/<locale>/`, keyed by file name. */
  globals?: Record<string, z.ZodType>;
  /** The bucket's custom domain, no path: content files store a `media/…` key, never a URL. */
  media?: { publicBase: string };
  /** Without one there is no test email and no emailed link; `from` is config, not a secret. */
  mailer?:
    | Mailer
    | { provider: 'resend'; from: string }
    /** `host` is not a secret, so it is named here; `SMTP_USER` and `SMTP_PASS` are. */
    | { provider: 'smtp'; from: string; host: string; port?: number }
    /** Cloudflare Email Sending, through a `send_email` binding named `EMAIL`. */
    | { provider: 'cloudflare'; from: string };
  /** Check ids this site turns off; nothing else about a check is configurable. */
  checks?: { ignore?: readonly CheckName[] };
  /** Required, a one-language site too: the files live in a locale folder either way. */
  i18n: {
    /** The folder names under `src/content/<collection>/`: `'en'`, `'de'`, `'pt-br'`. */
    locales: string[];
    defaultLocale: string;
    /** Mirrors Astro's `routing.prefixDefaultLocale`. */
    prefixDefaultLocale?: boolean;
    /** Astro's `base`, when the whole site is served under a path: `'/site'`. */
    base?: string;
    /** Replaces DeepL; without either, the admin offers no machine translation. */
    translate?: Translate;
  };
}

// The input side, so a transform shows what the editor types; Zod cannot represent `z.date()`.
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
  // A titleField naming no text field would drop the name typed into New entry in silence.
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
  // The site's route reads the file's `slug`, so the schema must declare it, optional.
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
  // A misspelled id is a check the site believes it turned off, with nothing saying why.
  for (const id of config.checks?.ignore ?? [])
    if (!(id in CHECKS))
      errors.push(
        `cms.config.ts › checks.ignore: ${JSON.stringify(id)} is not one of the checks — ${Object.keys(CHECKS).join(', ')}`,
      );
  // Unknown mailer providers must not fall through to Resend.
  const provider =
    typeof config.mailer === 'object' ? (config.mailer.provider as string) : undefined;
  if (provider && !['resend', 'smtp', 'cloudflare'].includes(provider))
    errors.push(
      `cms.config.ts › mailer.provider: ${JSON.stringify(provider)} is not one of the providers — resend, smtp, cloudflare`,
    );
  if (errors.length) throw new Error(errors.join('\n'));
  return config;
}
