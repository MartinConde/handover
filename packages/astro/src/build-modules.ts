import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { uiBuildConfig } from '@handover/ui/build.js';
import type { InlineConfig, Plugin } from 'vite';
import type { HandoverConfig } from './config.js';

/** The one place the package reads the site's `src/`: preview calls the page's own loader. */
export function loadersModule(root: URL, collections: HandoverConfig['collections']): string {
  const names = [...new Set(Object.values(collections).flatMap((c) => (c.load ? [c.load] : [])))];
  const at = (name: string) => JSON.stringify(fileURLToPath(new URL(`src/loaders/${name}`, root)));
  return [
    ...names.map((name, i) => `import * as m${i} from ${at(name)};`),
    `export default { ${names.map((name, i) => `${JSON.stringify(name)}: m${i}`).join(', ')} };`,
  ].join('\n');
}

type Screens = NonNullable<NonNullable<HandoverConfig['admin']>['screens']>;

/** The site's own screens by key, for the admin build that compiles them into the shell. */
export function screensModule(root: URL, screens: Screens): string {
  const entries = Object.entries(screens);
  const at = (component: string) => JSON.stringify(fileURLToPath(new URL(component, root)));
  return [
    ...entries.map(([, screen], i) => `import s${i} from ${at(screen.component)};`),
    `export default { ${entries.map(([key], i) => `${JSON.stringify(key)}: s${i}`).join(', ')} };`,
  ].join('\n');
}

/** The shipped bundle, or the site's own rebuild of it when the site declares screens. */
export function uiDir(root: URL, screens: Screens | undefined): URL {
  return screens && Object.keys(screens).length
    ? new URL('.astro/handover/ui/', root)
    : new URL('./ui/', import.meta.url);
}

// Two copies compile two runtimes into one document, and a screen mounts against the wrong one.
const oneSvelte: Plugin = {
  name: 'handover-one-svelte',
  generateBundle(_options, bundle) {
    const roots = new Set<string>();
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue;
      for (const id of chunk.moduleIds) {
        const root = /^(.*[/\\]node_modules[/\\]svelte)[/\\]/.exec(id)?.[1];
        if (root) roots.add(root);
      }
    }
    if (roots.size > 1)
      throw new Error(
        `the admin build found ${roots.size} copies of svelte and can compile only one:\n${[...roots].join('\n')}\nList svelte in the site's own dependencies so every import resolves to it.`,
      );
  },
};

// Node refuses `uiBuildConfig` (TypeScript in node_modules), so Vite's runner reads it.
export async function uiBuildOptions(root: URL, screens: Screens): Promise<InlineConfig> {
  const { runnerImport } = await import('vite');
  const { module } = await runnerImport<{ uiBuildConfig: typeof uiBuildConfig }>(
    fileURLToPath(import.meta.resolve('@handover/ui/build.ts')),
  );
  const options = module.uiBuildConfig({
    outDir: fileURLToPath(uiDir(root, screens)),
    screens: screensModule(root, screens),
  });
  return { ...options, configFile: false, plugins: [...(options.plugins ?? []), oneSvelte] };
}

interface UiBuildChunk {
  file: string;
  name?: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}

interface UiBuildManifest {
  [source: string]: UiBuildChunk;
}

async function uiAssetNames(dir: string, at = ''): Promise<string[]> {
  const names: string[] = [];
  for (const item of await readdir(join(dir, at), { withFileTypes: true })) {
    const name = at ? `${at}/${item.name}` : item.name;
    if (item.isDirectory()) {
      if (name !== '.vite') names.push(...(await uiAssetNames(dir, name)));
    } else if (/\.(js|css)$/.test(name)) names.push(name);
  }
  return names;
}

// Inlined into the Worker bundle: a Worker has no filesystem. Keep every JS/CSS output available
// to the asset route, but expose entry closures separately so a document loads only its own entry.
export async function uiAssetsModule(dir: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(dir, 'manifest.json'), 'utf8'),
  ) as UiBuildManifest;
  const names = (await uiAssetNames(dir)).sort();
  const files = await Promise.all(
    names.map(async (n) => [n, await readFile(join(dir, n), 'utf8')]),
  );
  const contents = Object.fromEntries(files) as Record<string, string>;

  for (const [source, chunk] of Object.entries(manifest)) {
    if (/\.(js|css)$/.test(chunk.file) && contents[chunk.file] === undefined)
      throw new Error(`UI manifest output is missing ${chunk.file} (${source})`);
    for (const css of chunk.css ?? [])
      if (contents[css] === undefined)
        throw new Error(`UI manifest stylesheet is missing ${css} (${source})`);
    for (const imported of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])])
      if (!manifest[imported])
        throw new Error(`UI manifest import is missing ${imported} (${source})`);
  }

  const stylesFor = (source: string, seen = new Set<string>()): string[] => {
    if (seen.has(source)) return [];
    seen.add(source);
    const chunk = manifest[source];
    if (!chunk) return [];
    return [
      ...(chunk.css ?? []),
      ...(chunk.imports ?? []).flatMap((imported) => stylesFor(imported, seen)),
    ];
  };
  const entries = Object.fromEntries(
    Object.entries(manifest)
      .filter(([, chunk]) => chunk.isEntry && chunk.name)
      .map(([source, chunk]) => [
        chunk.name as string,
        { script: chunk.file, styles: [...new Set(stylesFor(source))] },
      ]),
  );
  return `export default ${JSON.stringify({ entries, files: contents })};`;
}
