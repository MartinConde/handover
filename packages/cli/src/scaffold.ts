import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORMAT_VERSION, newId } from '@handover/core';

export interface I18n {
  locales: string[];
  defaultLocale: string;
}

const SCHEMAS = `import {
  type BlockRegistry,
  blocks,
  defineBlock,
  image,
  richtext,
  seo,
  seoDefaults,
} from 'astro-handover';
import { z } from 'astro/zod';

export const hero = defineBlock('hero', {
  heading: z.string(),
  image: image({ ratio: '16:9', max: 2400 }).optional(),
});
export const textSection = defineBlock('textSection', { body: richtext('full') });

// \`BlockType\` is keyof this plain object, so a block with a schema and no component in
// src/blocks/registry.ts fails typecheck there rather than at build.
const blockTypes = { hero, textSection };
export const registry: BlockRegistry = blockTypes;
export type BlockType = keyof typeof blockTypes;

export const page = z.object({
  title: z.string(),
  // What a search result and a shared link say about this page. Empty is the site's own
  // defaults below — see docs/seo.md.
  seo: seo.meta({ label: 'SEO' }).optional(),
  blocks: blocks(() => registry),
});

export type Page = z.infer<typeof page>;

// Site-wide content the client owns: one file per language under src/content/globals/.
export const site = z
  .object({
    name: z.string(),
    footerText: z.string(),
    // Every page falls back to these. The package finds them by this key.
    defaultSeo: seoDefaults.optional(),
  })
  .meta({ label: 'Site details', description: 'The name and footer line every page carries' });

export type Site = z.infer<typeof site>;
`;

const CONTENT_CONFIG = `import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { page } from './content/schemas';

// The entry id is the file's path — \`<locale>/<name>\` — and nothing else. Astro's default
// reads a \`slug\` out of the data and files the entry under that instead, which is where
// \`localizedSlugs\` keeps an address.
const byPath = ({ entry }: { entry: string }) => entry.replace(/\\.ya?ml$/, '');

// A plain \`z.object\` drops every key it does not declare, and the reserved ones are declared
// nowhere: without this the built data store holds no \`_status\` and a hidden entry renders.
const withReserved = <T extends z.ZodObject>(schema: T) =>
  schema.extend({
    _status: z.literal('hidden').optional(),
    _locales: z.array(z.string()).optional(),
  });

export const collections = {
  pages: defineCollection({
    loader: glob({ pattern: '**/*.yaml', base: './src/content/pages', generateId: byPath }),
    schema: withReserved(page),
  }),
  // One collection, a schema per file: each global is held to its own in \`cms.config.ts\`,
  // so what the build wants here is the file as it stands.
  globals: defineCollection({
    loader: glob({ pattern: '**/*.yaml', base: './src/content/globals', generateId: byPath }),
    schema: z.looseObject({}),
  }),
};
`;

const REGISTRY = `import type { BlockType } from '../content/schemas';
import Hero from './Hero.astro';
import TextSection from './TextSection.astro';

// A block type with a schema but no component fails typecheck here, not at build.
export const components = { hero: Hero, textSection: TextSection } satisfies Record<
  BlockType,
  unknown
>;
`;

const HERO = `---
import type { z } from 'astro/zod';
import type { hero } from '../content/schemas';

interface Props {
  block: z.infer<typeof hero>;
}

const { block } = Astro.props;
---

<section>
  <h1>{block.heading}</h1>
  {
    block.image && (
      <img
        src={block.image.src}
        alt={block.image.alt ?? ''}
        width={block.image.width}
        height={block.image.height}
      />
    )
  }
</section>
`;

const TEXT_SECTION = `---
import Markdown from 'astro-handover/Markdown.astro';
import type { z } from 'astro/zod';
import type { textSection } from '../content/schemas';

interface Props {
  block: z.infer<typeof textSection>;
}

const { block } = Astro.props;
---

<section>
  <Markdown content={block.body} />
</section>
`;

const LAYOUT = `---
import Blocks from 'astro-handover/Blocks.astro';
import Seo from 'astro-handover/Seo.astro';
import cms from '../../cms.config';
import { components } from '../blocks/registry';
import type { Page, Site } from '../content/schemas';

interface Props {
  data: Page;
  locale: string;
  /** Site-wide content, gathered by the loader: what \`_ref\` blocks are filled from. */
  globals: Record<string, unknown>;
  site: Site;
}

const { data, locale, globals, site } = Astro.props;
---

<!doctype html>
<html lang={locale}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <Seo
      seo={data.seo}
      defaults={site.defaultSeo}
      title={data.title}
      siteName={site.name}
      {locale}
      mediaBase={cms.media?.publicBase}
    />
  </head>
  <body>
    <main>
      <Blocks blocks={data.blocks} components={components} globals={globals} />
    </main>
    <footer>{site.footerText}</footer>
  </body>
</html>
`;

const LOADER = `import { type ContentSource, globalsAt, staticSource as createStaticSource } from 'astro-handover';
import { getCollection, getEntry } from 'astro:content';
import type { Page, Site } from '../content/schemas';

export { default as Page } from '../layouts/Page.astro';

type Source = ContentSource<{ pages: Page; globals: unknown }>;

export const staticSource: Source = createStaticSource('default', {
  getEntry: async (collection, id) => getEntry(collection, id),
  getCollection: (collection) => getCollection(collection),
});

// A miss is a value and not an error: the page answers 404 with it, and anything thrown here
// is a real problem rather than a page nobody wrote. Preview calls this same function with a
// source that reads the unpublished drafts.
export async function load(source: Source, { locale, slug }: { locale: string; slug: string }) {
  const entry = await source.getEntry('pages', \`\${locale}/\${slug}\`);
  if (!entry) return undefined;
  const globals = await globalsAt('default', source, locale);
  return { data: entry.data, locale, globals, site: globals.site as Site };
}
`;

// A language other than the default is served from a folder of its own, one level deeper.
const route = (locale: string, up: string) => `---
import Page from '${up}layouts/Page.astro';
import { load, staticSource } from '${up}loaders/page';

// Rendered per request, so a richtext field goes through <Markdown /> on the Worker itself.
export const prerender = false;

const { slug } = Astro.params;
const page = slug ? await load(staticSource, { locale: '${locale}', slug }) : undefined;
if (!page) return new Response('Not found', { status: 404 });
---

<Page {...page} />
`;

const HOME = () => `_version: ${FORMAT_VERSION}
title: "Home"
blocks:
  - _type: "hero"
    _id: "${newId('default')}"
    heading: "A site your client can edit"
  - _type: "textSection"
    _id: "${newId('default')}"
    body: |-
      Open /admin, change this paragraph and publish it. The edit is a commit on your
      repository and the build that follows puts it live.
`;

const SITE_YAML = `_version: ${FORMAT_VERSION}
name: "Your site"
footerText: "One line, edited once, on every page."
defaultSeo:
  titlePattern: "%s · Your site"
`;

/** The starter site, for a project that has no `content.config.ts` of its own to read. */
export function starter({ locales, defaultLocale }: I18n): Record<string, string> {
  const others = locales.filter((l) => l !== defaultLocale);
  return {
    'src/content/schemas.ts': SCHEMAS,
    'src/content.config.ts': CONTENT_CONFIG,
    'src/blocks/registry.ts': REGISTRY,
    'src/blocks/Hero.astro': HERO,
    'src/blocks/TextSection.astro': TEXT_SECTION,
    'src/layouts/Page.astro': LAYOUT,
    'src/loaders/page.ts': LOADER,
    'src/pages/[slug].astro': route(defaultLocale, '../'),
    // One route per language, each in that language's own folder.
    ...Object.fromEntries(others.map((l) => [`src/pages/${l}/[slug].astro`, route(l, '../../')])),
    [`src/content/pages/${defaultLocale}/home.yaml`]: HOME(),
    // A declared global with no file in the default language stops the build; one with no file
    // in a language throws when a page in it renders. Both, so neither happens.
    ...Object.fromEntries(locales.map((l) => [`src/content/globals/${l}/site.yaml`, SITE_YAML])),
  };
}

export interface Collection {
  /** The folder name, and the key in both config files. */
  name: string;
  /** The schema's export name in `src/content/schemas.ts`. */
  schema: string;
  /** `route`, `index` and `load` — only the starter's own collection has them here. */
  extra?: string;
}

export const cmsConfig = (i18n: I18n, collections: Collection[], globals: boolean) => {
  const imports = [...new Set([...collections.map((c) => c.schema), ...(globals ? ['site'] : [])])];
  return `import { defineConfig } from 'astro-handover';
import { ${imports.sort().join(', ')} } from './src/content/schemas';

export default defineConfig({
  // The same block is in astro.config.mjs; the build stops if the two disagree.
  i18n: { locales: [${i18n.locales.map((l) => `'${l}'`).join(', ')}], defaultLocale: '${i18n.defaultLocale}' },
  collections: {
${collections.map((c) => `    ${key(c.name)}: { schema: ${c.schema}${c.extra ?? ''} },`).join('\n')}
  },${globals ? '\n  // Site-wide content the client owns: one file per language under src/content/globals/.\n  globals: { site },' : ''}
});
`;
};

const key = (name: string) => (/^[a-z][\w$]*$/i.test(name) ? name : `'${name}'`);

const ASTRO_CONFIGS = [
  'astro.config.mjs',
  'astro.config.js',
  'astro.config.ts',
  'astro.config.mts',
];

/**
 * The languages the site already declares. Stated in two files that have to agree, and this is
 * the one that exists first — guessing `en` into the other would fail the build it just wrote.
 */
export function i18nOf(cwd: string): I18n {
  const path = ASTRO_CONFIGS.map((f) => join(cwd, f)).find((f) => existsSync(f));
  // Whole file rather than the `i18n` block: `routing: { … }` nests inside it, and stopping at
  // the first closing brace loses whichever of the two keys sits after it.
  const text = path ? readFileSync(path, 'utf8') : '';
  const listed = /locales\s*:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? '';
  const locales = [...listed.matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1] as string);
  if (!locales.length) return { locales: ['en'], defaultLocale: 'en' };
  const stated = /defaultLocale\s*:\s*['"]([\w-]+)['"]/.exec(text)?.[1];
  return {
    locales,
    defaultLocale: stated && locales.includes(stated) ? stated : (locales[0] as string),
  };
}

/**
 * The collections an existing `content.config.ts` declares, and whether each one's schema is a
 * name this command can import. An inline `z.object` is not: it is named on stdout so its owner
 * moves it into `schemas.ts`, which is where `cms.config.ts` has to read it from.
 */
export function collectionsOf(text: string): { name: string; schema?: string }[] {
  const decl = /(['"]?)([A-Za-z][\w-]*)\1\s*:\s*defineCollection\(/g;
  const starts = [...text.matchAll(decl)];
  return starts
    .map((match, i) => {
      const body = text.slice(match.index, starts[i + 1]?.index ?? text.length);
      // `schema: withReserved(listing)` and `schema: listing` are both the name; an inline
      // `z.object({…})` matches neither and comes back without one.
      const schema = /schema:\s*(?:\w+\()?\s*([A-Za-z_$][\w$]*)\s*[,)\n]/.exec(body)?.[1];
      return { name: match[2] as string, schema };
    })
    .filter((c) => c.name !== 'globals');
}

/** What is left to do once the resources exist: the App, the secrets and the one var. */
export const CHECKLIST = `Next, the GitHub App this site commits as. New GitHub App at
https://github.com/settings/apps/new — any name, webhook off, Repository permissions
"Contents: Read and write" and nothing else. Install it on this site's repository only; the
number ending its install URL is GITHUB_INSTALLATION_ID. GitHub hands you a PKCS#1 key and
Workers want PKCS#8: openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out key.pem

Then five secrets, each "npx wrangler secret put NAME", and the same names in .dev.vars for
astro dev:

  BETTER_AUTH_SECRET      signs the sessions: openssl rand -base64 32
  GITHUB_APP_ID           the App's id
  GITHUB_INSTALLATION_ID  from the install URL
  GITHUB_PRIVATE_KEY      the PKCS#8 PEM, header lines and all
  GITHUB_REPO             owner/repo of this site

One is a var and not a secret, because an origin is not private — and without it there is no
emailed sign-in link to let the owner above in. In wrangler.jsonc:

  "vars": { "HANDOVER_BASE_URL": "https://your-site.example" }

The same origin belongs in astro.config.mjs as \`site: 'https://your-site.example'\`. Without
it <Seo /> writes no canonical, no og:url and no hreflang alternates, because a relative
address is not one and the build host is whatever machine ran the build: docs/seo.md.

R2_ACCOUNT_ID and R2_BUCKET are vars for the same reason and are in the block above already.
Optional secrets turn on the feature that reads them: RESEND_API_KEY or SMTP_USER and
SMTP_PASS (email), R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (uploads), CLOUDFLARE_API_TOKEN
(build status), DEEPL_API_KEY (translation), GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
(Continue with GitHub), HANDOVER_SETTINGS_KEY (keys the owner pastes in Settings). Every one
of them is a row in docs/deploy.md, and Settings in the admin says which are missing.

The bucket needs a CORS rule and a hostname of its own before anything can be uploaded to it:
docs/media.md. The rule names the deployed site's origin, which this command cannot know.`;
