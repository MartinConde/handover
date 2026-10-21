import { execFile } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  type ContentFile,
  type ContentIndex,
  contentPathErrors,
  indexFrom,
  loadedEntry,
  modifiedFrom,
  parseEntry,
  redirectsText,
  refErrors,
  robotsText,
  type SitemapSite,
  sitemapFrom,
  sitemapIndexXml,
  sitemapXml,
  type TitleFields,
  timestampErrors,
} from '@handover/core';
import type { z } from 'astro/zod';
import { type HandoverConfig, redirects } from './config.js';
import { entryProblems } from './problems.js';

// The adapter's own hook runs after this one and appends Astro's redirects to the same file.
export async function emitRedirects(
  root: URL,
  clientDir: URL,
  slash: boolean,
  base = '',
): Promise<number> {
  const path = 'src/content/redirects.yaml';
  const source = await readFile(new URL(path, root), 'utf8').catch(() => undefined);
  if (source === undefined) return 0;
  const parsed = redirects.safeParse(parseEntry(source));
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
  await appendFile(new URL('_redirects', clientDir), redirectsText(parsed.data.rules, slash, base));
  return parsed.data.rules.length;
}

/** Static files so a crawler never wakes the Worker; a `public/robots.txt` is left as it is. */
export async function emitSitemap(
  root: URL,
  clientDir: URL,
  site: SitemapSite | undefined,
): Promise<string[]> {
  await mkdir(clientDir, { recursive: true });
  const written: string[] = [];
  // The files sit beside the pages, so under a `base` they are served under it too.
  const at = (name: string) =>
    site ? new URL(`${site.i18n.base ?? ''}/${name}`, site.base).href : undefined;
  if (site) {
    const pages = sitemapFrom(await contentFiles(root), site, await modifiedAt(root));
    for (const locale of site.i18n.locales) {
      const name = `sitemap-${locale}.xml`;
      await writeFile(new URL(name, clientDir), sitemapXml(pages[locale] ?? []));
      written.push(name);
    }
    const index = new URL('sitemap-index.xml', clientDir);
    await writeFile(index, sitemapIndexXml(written.map((name) => at(name) ?? name)));
    written.push('sitemap-index.xml');
  }
  const own = await readFile(new URL('robots.txt', clientDir), 'utf8').catch(() => undefined);
  if (own === undefined) {
    await writeFile(new URL('robots.txt', clientDir), robotsText(at('sitemap-index.xml')));
    written.push('robots.txt');
  }
  return written;
}

/** A shallow clone gives no dates rather than wrong ones: its one commit "adds" every file. */
export async function modifiedAt(root: URL): Promise<Map<string, string>> {
  const git = (...args: string[]) =>
    promisify(execFile)('git', args, {
      cwd: fileURLToPath(root),
      maxBuffer: 64 * 1024 * 1024,
    }).then((r) => r.stdout);
  const shallow = await git('rev-parse', '--is-shallow-repository').catch(() => 'true');
  if (shallow.trim() === 'true') return new Map();
  const log = await git('log', '--format=%cI', '--name-only', '--relative', '--', 'src/content');
  return modifiedFrom(log);
}

/** Every `.yaml` under `src/content/`, so a misplaced file is named by the build, not missed. */
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

const SCRIPT_TAG = /<script\b([^>]*?)(?:\/>|>([\s\S]*?)<\/script>)/g;
const JS_TYPE = /\btype=["'](?:module|text\/javascript|application\/javascript)["']/;

/** The code of each `is:inline` script in the site's `.astro` files, which Astro writes out verbatim. */
export async function inlineScripts(root: URL): Promise<string[]> {
  const dir = fileURLToPath(new URL('src/', root));
  const found = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  const files = found
    .filter((e) => e.isFile() && e.name.endsWith('.astro'))
    .map((e) => join(e.parentPath, e.name))
    .sort();
  const scripts: string[] = [];
  for (const file of files)
    for (const [, attrs = '', body] of (await readFile(file, 'utf8')).matchAll(SCRIPT_TAG)) {
      if (!body || !/\bis:inline\b/.test(attrs)) continue;
      // Content reaches a script only through these, and data or external scripts need no hash.
      if (/\b(?:src=|set:html|set:text|define:vars)/.test(attrs)) continue;
      if (/\btype=/.test(attrs) && !JS_TYPE.test(attrs)) continue;
      scripts.push(body);
    }
  return scripts;
}

const GLOBAL_FILE = /^src\/content\/globals\/[^/]+\/([^/]+)\.yaml$/;

/** Runs at `astro:config:done`: Astro's content sync would otherwise reach a bad file first. */
export async function contentErrors(
  root: URL,
  globals: Record<string, z.ZodType> = {},
  defaultLocale?: string,
): Promise<string[]> {
  const files = await contentFiles(root);
  const paths = new Set(files.map((f) => f.path));
  return [
    ...contentPathErrors(paths),
    ...files.flatMap((f) => {
      const name = GLOBAL_FILE.exec(f.path)?.[1];
      const schema = name && Object.hasOwn(globals, name) ? globals[name] : undefined;
      return [
        ...timestampErrors(f.path, f.contents),
        ...refErrors(f.path, f.contents, Object.keys(globals)),
        // Astro's own schema for globals cannot tell one file from another.
        ...(schema
          ? entryProblems(schema, loadedEntry(f.contents)).map(
              (p) => `${f.path} › ${p.path}: ${p.message}`,
            )
          : []),
      ];
    }),
    // A declared global with no file is a Site settings card that opens nothing.
    ...(defaultLocale === undefined
      ? []
      : Object.keys(globals)
          .map((key) => [key, `src/content/globals/${defaultLocale}/${key}.yaml`] as const)
          .filter(([, path]) => !paths.has(path))
          .map(
            ([key, path]) =>
              `cms.config.ts › globals.${key}: declared, but ${path} does not exist — write the file the default language reads, or drop the key`,
          )),
  ];
}

/** Titles are read at build because git is slow to list. */
export async function buildIndex(
  files: ContentFile[],
  titleFields: TitleFields = {},
): Promise<ContentIndex> {
  const errors = contentPathErrors(files.map((f) => f.path));
  if (errors.length) throw new Error(errors.join('\n'));
  return indexFrom(files, titleFields);
}

// A locale is either the folder name or `{ path, codes }`, where the path is the folder.
type AstroI18n = {
  locales?: unknown;
  defaultLocale?: unknown;
  routing?: unknown;
};

// A drift would put a German file under a folder Astro never builds, silently.
export function i18nErrors(
  cms: HandoverConfig['i18n'],
  astro: AstroI18n | undefined,
  base: unknown = '/',
): string[] {
  const at = (key: string) => `cms.config.ts › i18n.${key}: `;
  const is = (them: unknown, key: string) => `is not astro.config.mjs's i18n.${key} ${them}`;
  // Astro spells its base with or without the slash by `trailingSlash`; ours is written bare.
  const theirs = String(base ?? '/').replace(/\/+$/, '') || '/';
  const errors: string[] = [];
  if ((cms.base ?? '/') !== theirs)
    errors.push(
      `${at('base')}${cms.base === undefined ? 'none' : JSON.stringify(cms.base)} is not astro.config.mjs's base ${JSON.stringify(theirs)}; the two must match exactly`,
    );
  if (!astro)
    return [
      ...errors,
      `astro.config.mjs has no i18n block: cms.config.ts declares ${JSON.stringify(cms.locales)}, so astro.config.mjs needs i18n: { locales: ${JSON.stringify(cms.locales)}, defaultLocale: ${JSON.stringify(cms.defaultLocale)} }. The two must match exactly.`,
    ];
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
