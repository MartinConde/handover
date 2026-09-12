import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORMAT_VERSION, newId } from '@handover/core';

export interface I18n {
  locales: string[];
  defaultLocale: string;
  prefixDefaultLocale?: boolean;
  /** Astro's normalized base path; absent when the site is served from root. */
  base?: string;
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

// \`BlockType\` is keyof this plain object.
const blockTypes = { hero, textSection };
export const registry: BlockRegistry = blockTypes;
export type BlockType = keyof typeof blockTypes;

export const page = z.object({
  title: z.string(),
  // What a search result and a shared link say about this page.
  seo: seo.meta({ label: 'SEO' }).optional(),
  blocks: blocks(() => registry),
});

export type Page = z.infer<typeof page>;

// Site-wide content the client owns: one file per language under src/content/globals/.
export const site = z
  .object({
    name: z.string(),
    footerText: z.string(),
    // The package finds these page defaults by key.
    defaultSeo: seoDefaults.optional(),
  })
  .meta({ label: 'Site details', description: 'The name and footer line every page carries' });

export type Site = z.infer<typeof site>;
`;

const CONTENT_CONFIG = `import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { page } from './content/schemas';

// The entry id is the file's path — \`<locale>/<name>\` — and nothing else.
const byPath = ({ entry }: { entry: string }) => entry.replace(/\\.ya?ml$/, '');

// A plain \`z.object\` drops every key it does not declare.
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
  // One collection, a schema per file: each global is held to its own in \`cms.config.ts\`.
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
import cms from '../../cms.config';
import type { hero } from '../content/schemas';

interface Props {
  block: z.infer<typeof hero>;
}

const { block } = Astro.props;
const media = (key: string) => \`\${cms.media?.publicBase}/\${key}\`;
const focal = block.image?.focal ?? [0.5, 0.5];
---

<section>
  <h1>{block.heading}</h1>
  {
    block.image && (
      <img
        src={media(block.image.src)}
        alt={block.image.alt ?? ''}
        width={block.image.width}
        height={block.image.height}
        style={\`object-position: \${focal[0] * 100}% \${focal[1] * 100}%\`}
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

const LOADER = `import { type ContentSource, entryAt, globalsAt, staticSource as createStaticSource } from 'astro-handover';
import { getCollection, getEntry } from 'astro:content';
import type { Page, Site } from '../content/schemas';
import cms from '../../cms.config';

export { default as Page } from '../layouts/Page.astro';

type Source = ContentSource<{ pages: Page; globals: unknown }>;

export const staticSource: Source = createStaticSource('default', {
  getEntry: async (collection, id) => getEntry(collection, id),
  getCollection: (collection) => getCollection(collection),
});

// A miss is a value and not an error: the page answers 404 with it.
export async function load(source: Source, { locale, slug }: { locale: string; slug: string }) {
  const entry = await entryAt('default', source, cms, 'pages', locale, slug);
  if (!entry) return undefined;
  const globals = await globalsAt(
    'default', source, locale,
    source.preview ? { required: ['site'], blocks: entry.data.blocks } : undefined,
  );
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
export function starter({
  locales,
  defaultLocale,
  prefixDefaultLocale = false,
}: I18n): Record<string, string> {
  const routes = Object.fromEntries(
    locales.map((locale) => {
      const prefixed = locale !== defaultLocale || prefixDefaultLocale;
      const path = prefixed ? `src/pages/${locale}/[slug].astro` : 'src/pages/[slug].astro';
      return [path, route(locale, prefixed ? '../../' : '../')];
    }),
  );
  return {
    'src/content/schemas.ts': SCHEMAS,
    'src/content.config.ts': CONTENT_CONFIG,
    'src/blocks/registry.ts': REGISTRY,
    'src/blocks/Hero.astro': HERO,
    'src/blocks/TextSection.astro': TEXT_SECTION,
    'src/layouts/Page.astro': LAYOUT,
    'src/loaders/page.ts': LOADER,
    ...routes,
    [`src/content/pages/${defaultLocale}/home.yaml`]: HOME(),
    // A global missing in any language breaks either the build or that language's pages.
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
  const routing = [
    `locales: [${i18n.locales.map((l) => `'${l}'`).join(', ')}]`,
    `defaultLocale: '${i18n.defaultLocale}'`,
    ...(i18n.prefixDefaultLocale ? ['prefixDefaultLocale: true'] : []),
    ...(i18n.base ? [`base: '${i18n.base}'`] : []),
  ];
  return `import { defineConfig } from 'astro-handover';
import { ${imports.sort().join(', ')} } from './src/content/schemas';

export default defineConfig({
  // The same block is in astro.config.mjs; the build stops if the two disagree.
  i18n: { ${routing.join(', ')} },
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

/** Blanks strings and comments while preserving offsets, so delimiters in them are harmless. */
function structure(text: string): string {
  const out = text.split('');
  let state: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' = 'code';
  for (let i = 0; i < out.length; i += 1) {
    const char = text[i] as string;
    const next = text[i + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        out[i] = out[i + 1] = ' ';
        state = 'line';
        i += 1;
      } else if (char === '/' && next === '*') {
        out[i] = out[i + 1] = ' ';
        state = 'block';
        i += 1;
      } else if (char === "'") {
        out[i] = ' ';
        state = 'single';
      } else if (char === '"') {
        out[i] = ' ';
        state = 'double';
      } else if (char === '`') {
        out[i] = ' ';
        state = 'template';
      }
      continue;
    }
    out[i] = char === '\n' ? '\n' : ' ';
    if (state === 'line' && char === '\n') state = 'code';
    else if (state === 'block' && char === '*' && next === '/') {
      out[i + 1] = ' ';
      state = 'code';
      i += 1;
    } else if (
      (state === 'single' && char === "'") ||
      (state === 'double' && char === '"') ||
      (state === 'template' && char === '`')
    ) {
      let escapes = 0;
      for (let at = i - 1; at >= 0 && text[at] === '\\'; at -= 1) escapes += 1;
      if (escapes % 2 === 0) state = 'code';
    }
  }
  return out.join('');
}

/** Reads only a direct property of an object literal. */
function property(text: string, name: string): string | undefined {
  const clean = structure(text);
  if (clean.trimStart()[0] !== '{') return undefined;
  let curly = 0;
  let square = 0;
  let paren = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i] as string;
    if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '(') paren += 1;
    else if (char === ')') paren -= 1;
    else if (curly === 1 && square === 0 && paren === 0 && /[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][\w$]*/.exec(clean.slice(i));
      const key = match?.[0] ?? '';
      let colon = i + key.length;
      while (/\s/.test(clean[colon] ?? '')) colon += 1;
      if (key !== name || clean[colon] !== ':') {
        i += Math.max(0, key.length - 1);
        continue;
      }
      let start = colon + 1;
      while (/\s/.test(text[start] ?? '')) start += 1;
      let nestedCurly = 0;
      let nestedSquare = 0;
      let nestedParen = 0;
      for (let end = start; end < clean.length; end += 1) {
        const valueChar = clean[end] as string;
        if (valueChar === '{') nestedCurly += 1;
        else if (valueChar === '[') nestedSquare += 1;
        else if (valueChar === '(') nestedParen += 1;
        else if (valueChar === '}' && nestedCurly > 0) nestedCurly -= 1;
        else if (valueChar === ']' && nestedSquare > 0) nestedSquare -= 1;
        else if (valueChar === ')' && nestedParen > 0) nestedParen -= 1;
        else if (
          (valueChar === ',' || valueChar === '}') &&
          nestedCurly === 0 &&
          nestedSquare === 0 &&
          nestedParen === 0
        )
          return text.slice(start, end).trim();
      }
    }
  }
  return undefined;
}

function items(text: string): string[] | undefined {
  const clean = structure(text);
  if (!/^\s*\[/.test(clean) || !/]\s*$/.test(clean)) return undefined;
  const start = clean.indexOf('[') + 1;
  const end = clean.lastIndexOf(']');
  const parts: string[] = [];
  let curly = 0;
  let square = 0;
  let paren = 0;
  let from = start;
  for (let i = start; i < end; i += 1) {
    const char = clean[i] as string;
    if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '(') paren += 1;
    else if (char === ')') paren -= 1;
    else if (char === ',' && curly === 0 && square === 0 && paren === 0) {
      if (text.slice(from, i).trim()) parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  if (text.slice(from, end).trim()) parts.push(text.slice(from, end).trim());
  return parts;
}

const literal = (text: string): string | undefined => {
  const match = /^(['"])([A-Za-z0-9/_-]+)\1$/.exec(text.trim());
  return match?.[2];
};

function configObject(text: string, file: string): string {
  const clean = structure(text);
  const call = /\bdefineConfig\s*\(/.exec(clean);
  const after = call ? (call.index ?? 0) + call[0].length : -1;
  let start = after;
  while (start >= 0 && /\s/.test(clean[start] ?? '')) start += 1;
  if (start < 0 || clean[start] !== '{')
    throw new Error(
      `${file}: Handover can only scaffold from a literal defineConfig({ ... }). Create cms.config.ts and the page routes by hand, then rerun init.`,
    );
  let depth = 0;
  for (let end = start; end < clean.length; end += 1) {
    if (clean[end] === '{') depth += 1;
    else if (clean[end] === '}' && --depth === 0) return text.slice(start, end + 1);
  }
  throw new Error(`${file}: the defineConfig object is not complete.`);
}

function unsupported(file: string, setting: string, example: string): never {
  throw new Error(
    `${file}: i18n.${setting} is computed or uses an unsupported form. Write it as ${example}, then rerun init; or create cms.config.ts and the page routes by hand.`,
  );
}

/** Read from astro.config rather than guessed: a wrong route model fails the build just written. */
export function i18nOf(cwd: string): I18n {
  const path = ASTRO_CONFIGS.map((f) => join(cwd, f)).find((f) => existsSync(f));
  if (!path) return { locales: ['en'], defaultLocale: 'en', prefixDefaultLocale: false };
  const file = path.split('/').at(-1) as string;
  const root = configObject(readFileSync(path, 'utf8'), file);
  const i18n = property(root, 'i18n');
  if (!i18n?.trim().startsWith('{'))
    unsupported(
      file,
      'locales',
      "a literal i18n block such as { locales: ['en'], defaultLocale: 'en' }",
    );
  const listed = property(i18n, 'locales');
  const localeItems = listed ? items(listed) : undefined;
  if (!localeItems?.length)
    unsupported(file, 'locales', "a non-empty literal array such as ['en', 'de']");
  const locales = localeItems.map((item) => {
    const plain = literal(item);
    if (plain) return plain;
    if (!item.trim().startsWith('{'))
      unsupported(file, 'locales', "strings or { path: 'name', codes: ['code'] } objects");
    const pathValue = property(item, 'path');
    const codes = property(item, 'codes');
    const codeItems = codes ? items(codes) : undefined;
    if (!pathValue || !codeItems?.length || !codeItems.every((code) => literal(code)))
      unsupported(file, 'locales', "strings or { path: 'name', codes: ['code'] } objects");
    return (
      literal(pathValue) ??
      unsupported(
        file,
        'locales',
        "objects with a literal path, such as { path: 'de', codes: ['de'] }",
      )
    );
  });
  const statedRaw = property(i18n, 'defaultLocale');
  const stated = statedRaw ? literal(statedRaw) : undefined;
  if (!stated) unsupported(file, 'defaultLocale', "a literal locale path such as 'en'");
  if (!locales.includes(stated))
    throw new Error(
      `${file}: i18n.defaultLocale '${stated}' is not one of the locale paths ${JSON.stringify(locales)}. Fix astro.config and rerun init.`,
    );
  const routing = property(i18n, 'routing');
  let prefixDefaultLocale = false;
  if (routing !== undefined) {
    if (!routing.trim().startsWith('{'))
      unsupported(file, 'routing', '{ prefixDefaultLocale: true } or omit it');
    const prefix = property(routing, 'prefixDefaultLocale');
    if (prefix !== undefined) {
      if (prefix !== 'true' && prefix !== 'false')
        unsupported(file, 'routing.prefixDefaultLocale', 'the literal true or false');
      prefixDefaultLocale = prefix === 'true';
    }
  }
  const baseRaw = property(root, 'base');
  const statedBase = baseRaw === undefined ? undefined : literal(baseRaw);
  if (baseRaw !== undefined && statedBase === undefined)
    unsupported(file, 'base', "a literal path such as '/site'");
  if (statedBase !== undefined && statedBase !== '/' && !statedBase.startsWith('/'))
    unsupported(file, 'base', "a root-relative literal path such as '/site'");
  const normalizedBase = statedBase?.replace(/\/+$/, '') || undefined;
  return {
    locales,
    defaultLocale: stated,
    prefixDefaultLocale,
    ...(normalizedBase ? { base: normalizedBase } : {}),
  };
}

/** An inline `z.object` has no name to import, so it is reported for its owner to move. */
export function collectionsOf(text: string): { name: string; schema?: string }[] {
  const decl = /(['"]?)([A-Za-z][\w-]*)\1\s*:\s*defineCollection\(/g;
  const starts = [...text.matchAll(decl)];
  return starts
    .map((match, i) => {
      const body = text.slice(match.index, starts[i + 1]?.index ?? text.length);
      // `withReserved(listing)` and bare `listing` both name it; an inline `z.object` does not.
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
