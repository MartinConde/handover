import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const temporary = mkdtempSync(join(tmpdir(), 'handover-package-smoke-'));
const archives = join(temporary, 'archives');
const consumer = join(temporary, 'consumer');
const vendor = join(consumer, 'vendor');

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(`${result.stdout}${result.stderr}`);
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
  return result.stdout;
}

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function archiveName(packageDir) {
  const manifest = json(join(packageDir, 'package.json'));
  return `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`;
}

function pack(packageDir) {
  run('pnpm', ['pack', '--pack-destination', archives], packageDir);
  return join(archives, archiveName(packageDir));
}

function put(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

try {
  mkdirSync(archives);
  mkdirSync(vendor, { recursive: true });

  const coreArchive = pack(join(root, 'packages/core'));
  const cliArchive = pack(join(root, 'packages/cli'));
  const astroArchive = pack(join(root, 'packages/astro'));
  for (const archive of [coreArchive, cliArchive, astroArchive])
    cpSync(archive, join(vendor, basename(archive)));

  const astroFiles = run('tar', ['-tf', astroArchive], root, true).trim().split('\n');
  for (const path of [
    'package/README.md',
    'package/bin/handover.js',
    'package/components/Blocks.astro',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/ui/manifest.json',
  ])
    if (!astroFiles.includes(path))
      throw new Error(`astro-handover archive does not contain ${path}`);
  const componentTests = astroFiles.filter((path) =>
    /package\/components\/.*\.test\.ts$/.test(path),
  );
  if (componentTests.length)
    throw new Error(
      `astro-handover archive contains component tests: ${componentTests.join(', ')}`,
    );

  const astroVersion = json(join(root, 'node_modules/astro/package.json')).version;
  const nodeAdapterVersion = json(join(root, 'node_modules/@astrojs/node/package.json')).version;
  const typescriptVersion = json(join(root, 'node_modules/typescript/package.json')).version;
  put(
    join(consumer, 'package.json'),
    `${JSON.stringify(
      {
        name: 'handover-package-smoke',
        private: true,
        type: 'module',
        packageManager: json(join(root, 'package.json')).packageManager,
        scripts: { build: 'astro build', typecheck: 'tsc --noEmit' },
        dependencies: {
          '@astrojs/node': nodeAdapterVersion,
          astro: astroVersion,
          'astro-handover': `file:vendor/${archiveName(join(root, 'packages/astro'))}`,
        },
        devDependencies: { typescript: typescriptVersion },
      },
      null,
      2,
    )}\n`,
  );
  put(
    join(consumer, 'pnpm-workspace.yaml'),
    `overrides:\n  '@handover/core': file:vendor/${archiveName(join(root, 'packages/core'))}\n  '@handover/cli': file:vendor/${archiveName(join(root, 'packages/cli'))}\n`,
  );
  put(
    join(consumer, 'astro.config.mjs'),
    `import node from '@astrojs/node';
import { defineConfig } from 'astro/config';
import handover from 'astro-handover';
import cms from './cms.config.ts';

const cloudflareWorkersStub = {
  name: 'package-smoke-cloudflare-workers',
  enforce: 'pre',
  resolveId(id) {
    return id === 'cloudflare:workers' ? '\\0package-smoke-cloudflare-workers' : undefined;
  },
  load(id) {
    return id === '\\0package-smoke-cloudflare-workers' ? 'export const env = {};' : undefined;
  },
};

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  session: false,
  i18n: { locales: ['en'], defaultLocale: 'en' },
  integrations: [handover(cms)],
  vite: { plugins: [cloudflareWorkersStub] },
});
`,
  );
  put(
    join(consumer, 'cms.config.ts'),
    `import { z } from 'astro/zod';
import { blocks, defineBlock, defineConfig, type BlockRegistry } from 'astro-handover';

const text = defineBlock('text', { body: z.string() });
export const registry: BlockRegistry = { text };
export const page = z.object({ title: z.string(), blocks: blocks(() => registry) });

export default defineConfig({
  i18n: { locales: ['en'], defaultLocale: 'en' },
  collections: { pages: { schema: page } },
});
`,
  );
  put(
    join(consumer, 'src/content.config.ts'),
    `import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { page } from '../cms.config';

export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.yaml', base: './src/content/pages' }), schema: page }),
};
`,
  );
  put(join(consumer, 'src/content/pages/en/home.yaml'), 'title: Home\nblocks: []\n');
  put(
    join(consumer, 'src/components/Text.astro'),
    `---
interface Props { block: { body: string } }
const { block } = Astro.props;
---
<p>{block.body}</p>
`,
  );
  put(
    join(consumer, 'src/pages/index.astro'),
    `---
import Blocks from 'astro-handover/Blocks.astro';
import Text from '../components/Text.astro';
const blocks = [{ _id: 'welcome', _type: 'text', body: 'Installed from archives' }];
---
<Blocks {blocks} components={{ text: Text }} />
`,
  );
  put(
    join(consumer, 'verify.ts'),
    `import type { Block, HandoverConfig } from 'astro-handover';

export const block: Block = { _id: 'welcome', _type: 'text' };
export const config: HandoverConfig['i18n'] = { locales: ['en'], defaultLocale: 'en' };
`,
  );
  put(
    join(consumer, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          target: 'ES2022',
          skipLibCheck: true,
        },
        include: ['verify.ts'],
      },
      null,
      2,
    )}\n`,
  );
  const { SCHEMA_VERSION } = await import(
    pathToFileURL(join(root, 'packages/core/dist/index.js')).href
  );
  put(
    join(consumer, 'migrations/handover.json'),
    `${JSON.stringify({ schemaVersion: SCHEMA_VERSION }, null, 2)}\n`,
  );

  run('pnpm', ['install'], consumer);

  const lockfile = readFileSync(join(consumer, 'pnpm-lock.yaml'), 'utf8');
  if (lockfile.includes('link:') || lockfile.includes(root))
    throw new Error('isolated install used a workspace or checkout link');
  for (const archive of [coreArchive, cliArchive, astroArchive])
    if (!lockfile.includes(`file:vendor/${basename(archive)}`))
      throw new Error(`${basename(archive)} was not recorded as a local archive dependency`);
  const installed = realpathSync(join(consumer, 'node_modules/astro-handover'));
  if (relative(realpathSync(consumer), installed).startsWith('..'))
    throw new Error(`astro-handover resolved outside the isolated consumer: ${installed}`);

  const help = run('pnpm', ['exec', 'handover', '--help'], consumer, true);
  if (!help.includes('Usage: handover')) throw new Error('the packaged handover CLI did not run');
  run('pnpm', ['typecheck'], consumer);
  run('pnpm', ['build'], consumer);
  console.log('Packaged install, CLI, public imports, types, and Astro build passed.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
