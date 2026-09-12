import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '@handover/core';
import { expect, test } from 'vitest';
import { main } from './index.js';

function site(files: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'handover-cli-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  return cwd;
}

const WHOAMI = JSON.stringify({ loggedIn: true, accounts: [{ id: 'acc0unt1d', name: 'Yours' }] });
const D1_LIST = JSON.stringify([{ uuid: 'db-uuid', name: 'my-site' }]);
interface CloudState {
  database?: boolean;
  bucket?: boolean;
}

function generateMigration(cwd: string, directory = '.handover-migrations') {
  mkdirSync(join(cwd, directory, 'meta'), { recursive: true });
  writeFileSync(
    join(cwd, directory, 'meta/_journal.json'),
    JSON.stringify({ entries: [{ tag: '0000_generated' }] }),
  );
  writeFileSync(join(cwd, directory, '0000_generated.sql'), '-- generated\n');
}

async function run(argv: string[], cwd: string, ran: string[][] = [], cloud: CloudState = {}) {
  const out: string[] = [];
  const code = await main(argv, {
    cwd,
    log: (l) => out.push(l),
    run: (a) => {
      ran.push(a);
      if (a.slice(0, 3).join(' ') === 'wrangler d1 create') cloud.database = true;
      if (a.slice(0, 4).join(' ') === 'wrangler r2 bucket create') cloud.bucket = true;
      if (a[0] === 'drizzle-kit' && a[2] === '--config') generateMigration(cwd);
    },
    capture: (a) => {
      ran.push(a);
      if (a.includes('whoami')) return WHOAMI;
      if (a.includes('list')) return cloud.database ? D1_LIST : '[]';
      return '1.0.0';
    },
    probe: (a) => {
      ran.push(a);
      return cloud.bucket ? JSON.stringify({ name: 'my-site-media' }) : undefined;
    },
  });
  return { code, out: out.join('\n') };
}

const HOME = '_version: 1\ntitle: "Home"\n';
const OLD = 'title: "Mill House"\nrooms: 3\n';

test('migrate --dry-run lists every content file with its version and writes nothing', async () => {
  const cwd = site({
    'src/content/pages/en/home.yaml': HOME,
    'src/content/listings/en/mill-house.yaml': OLD,
    'src/content/redirects.yaml': '_version: 1\nrules: []\n',
  });
  const { code, out } = await run(['migrate', '--dry-run'], cwd);
  expect(code).toBe(0);
  expect(out).toBe(
    [
      'src/content/listings/en/mill-house.yaml  none → 1',
      'src/content/pages/en/home.yaml           1',
      'src/content/redirects.yaml               1',
      '3 files: 2 at version 1, 1 without a version. Dry run: 1 would be written.',
    ].join('\n'),
  );
  expect(readFileSync(join(cwd, 'src/content/listings/en/mill-house.yaml'), 'utf8')).toBe(OLD);
});

test('migrate --dry-run names an unquoted date and refuses', async () => {
  const cwd = site({ 'src/content/notes/en/one.yaml': '_version: 1\npublished: 2026-07-14\n' });
  const { code, out } = await run(['migrate', '--dry-run'], cwd);
  expect(code).toBe(1);
  expect(out.split('\n').at(-1)).toBe(
    'src/content/notes/en/one.yaml \u203a published: an unquoted date is a timestamp, not a string. Quote it: "2026-07-14"',
  );
});

test('migrate stamps the file without a version and leaves the others byte-identical', async () => {
  const cwd = site({
    'src/content/pages/en/home.yaml': HOME,
    'src/content/listings/en/mill-house.yaml': OLD,
  });
  const { code, out } = await run(['migrate'], cwd);
  expect(code).toBe(0);
  expect(out.split('\n').at(-1)).toBe(
    '2 files: 1 at version 1, 1 without a version. Wrote 1 file; commit it.',
  );
  expect(readFileSync(join(cwd, 'src/content/listings/en/mill-house.yaml'), 'utf8')).toBe(
    '_version: 1\ntitle: "Mill House"\nrooms: 3\n',
  );
  expect(readFileSync(join(cwd, 'src/content/pages/en/home.yaml'), 'utf8')).toBe(HOME);
  expect((await run(['migrate'], cwd)).out.split('\n').at(-1)).toBe(
    '2 files: 2 at version 1. Nothing to write.',
  );
});

test('migrate fails on a file newer than the package, naming it', async () => {
  const cwd = site({ 'src/content/pages/en/home.yaml': '_version: 9\ntitle: "Home"\n' });
  const { code, out } = await run(['migrate'], cwd);
  expect(code).toBe(1);
  expect(out).toContain(
    'src/content/pages/en/home.yaml: version 9 is newer than this package knows (1)',
  );
});

test('db generate runs drizzle-kit and records the schema version', async () => {
  const cwd = site({ 'migrations/0000_x.sql': '' });
  const ran: string[][] = [];
  const { code, out } = await run(['db', 'generate'], cwd, ran);
  expect(code).toBe(0);
  expect(ran).toEqual([['drizzle-kit', 'generate']]);
  expect(JSON.parse(readFileSync(join(cwd, 'migrations/handover.json'), 'utf8'))).toEqual({
    schemaVersion: SCHEMA_VERSION,
  });
  expect(out).toBe(`migrations/handover.json records schema version ${SCHEMA_VERSION}`);
});

test('db generate --check fails loudly when migrations/ is behind the package', async () => {
  const cwd = site({ 'migrations/handover.json': '{ "schemaVersion": 0 }' });
  const ran: string[][] = [];
  const { code, out } = await run(['db', 'generate', '--check'], cwd, ran);
  expect(code).toBe(1);
  expect(ran).toEqual([]);
  expect(out).toContain(`migrations/ was generated for 0`);
});

test('db generate --check passes when the marker matches', async () => {
  const cwd = site({ 'migrations/handover.json': `{ "schemaVersion": ${SCHEMA_VERSION} }` });
  const { code, out } = await run(['db', 'generate', '--check'], cwd);
  expect(code).toBe(0);
  expect(out).toBe(`migrations/ is at schema version ${SCHEMA_VERSION}`);
});

test('init creates the database and the bucket, wires them up and seeds the owner', async () => {
  const cwd = site({ 'package.json': '{ "name": "my-site" }' });
  const ran: string[][] = [];
  const { code, out } = await run(['init', 'you@example.com'], cwd, ran);

  expect(code).toBe(0);
  expect(ran.slice(0, 10)).toEqual([
    ['drizzle-kit', '--version'],
    ['wrangler', '--version'],
    ['wrangler', 'whoami', '--json'],
    ['wrangler', 'd1', 'list', '--json'],
    ['wrangler', 'd1', 'create', 'my-site'],
    ['wrangler', 'd1', 'list', '--json'],
    ['wrangler', 'r2', 'bucket', 'info', 'my-site-media', '--json'],
    ['wrangler', 'r2', 'bucket', 'create', 'my-site-media'],
    ['drizzle-kit', 'generate', '--config', '.handover-drizzle.config.ts'],
    ['wrangler', 'd1', 'migrations', 'apply', 'my-site', '--local'],
  ]);

  const config = readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8');
  expect(config).toContain('"name": "my-site"');
  expect(config).toContain('"binding": "DB"');
  expect(config).toContain('"database_name": "my-site"');
  expect(config).toContain('"database_id": "db-uuid"');
  expect(config).toContain('"R2_ACCOUNT_ID": "acc0unt1d"');
  expect(config).toContain('"R2_BUCKET": "my-site-media"');
  expect(readFileSync(join(cwd, 'drizzle.config.ts'), 'utf8')).toContain(
    "schema: './node_modules/astro-handover/dist/schema.js'",
  );
  expect(readFileSync(join(cwd, 'src/worker.ts'), 'utf8')).toContain('scheduled');
  expect(out).toContain('you@example.com is an owner');
});

test('init seeds one user row and no account row, so the first sign-in is an emailed link', async () => {
  const cwd = site({ 'package.json': '{ "name": "my-site" }' });
  const ran: string[][] = [];
  await run(['init', 'you@example.com'], cwd, ran);

  const seeds = ran.filter((a) => a[2] === 'execute');
  expect(seeds.map((a) => a.slice(0, 4))).toEqual([
    ['wrangler', 'd1', 'execute', 'my-site'],
    ['wrangler', 'd1', 'execute', 'my-site'],
  ]);
  expect(seeds.map((a) => a[4])).toEqual(['--local', '--remote']);
  expect(seeds[0]?.[6]).toMatch(
    /^INSERT INTO user \(id, name, email, email_verified, role, created_at, updated_at\) VALUES \('[0-9a-f-]{36}', 'you', 'you@example.com', 1, 'owner', 0, 0\) ON CONFLICT\(email\) DO UPDATE SET role = 'owner'$/,
  );
  expect(seeds[0]?.[6]).toBe(seeds[1]?.[6]);
  expect(ran.some((a) => a.join(' ').includes('INSERT INTO account'))).toBe(false);
});

test('init refuses a project that already has migrations/, before creating anything', async () => {
  const cwd = site({ 'package.json': '{ "name": "my-site" }', 'migrations/0000_x.sql': '' });
  const ran: string[][] = [];
  const { code, out } = await run(['init', 'you@example.com'], cwd, ran);

  expect(code).toBe(1);
  expect(ran).toEqual([]);
  expect(out).toContain('migrations/ is already here');
});

test('init leaves a wrangler config it did not write alone and prints the block to paste', async () => {
  const existing = '{ "name": "theirs" }\n';
  const cwd = site({ 'package.json': '{ "name": "my-site" }', 'wrangler.jsonc': existing });
  const cloud: CloudState = {};
  const ran: string[][] = [];
  const { code, out } = await run(['init', 'you@example.com'], cwd, ran, cloud);

  expect(code).toBe(1);
  expect(readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8')).toBe(existing);
  expect(out).toContain('wrangler.jsonc is yours');
  expect(out).toContain('"database_id": "db-uuid"');
  expect(out).toContain('npx handover init you@example.com');
  expect(ran.some((a) => a.includes('migrations'))).toBe(false);
  expect(ran.some((a) => a.includes('execute'))).toBe(false);

  writeFileSync(
    join(cwd, 'wrangler.jsonc'),
    `{ "name": "theirs", "vars": { "R2_ACCOUNT_ID": "acc0unt1d", "R2_BUCKET": "my-site-media" }, "d1_databases": [{ "binding": "DB", "database_name": "my-site", "database_id": "db-uuid" }] }\n`,
  );
  const resumed: string[][] = [];
  const result = await run(['init', 'you@example.com'], cwd, resumed, cloud);
  expect(result, result.out).toMatchObject({ code: 0 });
  expect(resumed.some((a) => a.slice(0, 4).join(' ') === 'wrangler d1 create my-site')).toBe(false);
  expect(
    resumed.some((a) => a.slice(0, 5).join(' ') === 'wrangler r2 bucket create my-site-media'),
  ).toBe(false);
});

test.each([
  [
    'a conflicting Wrangler binding',
    {
      'wrangler.jsonc':
        '{ "vars": { "R2_BUCKET": "someone-elses-media" }, "d1_databases": [{ "binding": "DB", "database_name": "someone-else", "database_id": "other" }] }',
    },
    'R2_BUCKET is someone-elses-media',
  ],
  [
    'a conflicting Drizzle output directory',
    {
      'drizzle.config.ts':
        "export default { dialect: 'sqlite', schema: './node_modules/astro-handover/dist/schema.js', out: './other-migrations' };",
    },
    'out must be "./migrations"',
  ],
])('init rejects %s before provisioning or stamping migrations', async (_name, files, message) => {
  const cwd = site({ 'package.json': '{ "name": "my-site" }', ...files });
  const ran: string[][] = [];
  const { code, out } = await run(['init', 'you@example.com'], cwd, ran);

  expect(code).toBe(1);
  expect(out).toContain(message);
  expect(ran).toEqual([
    ['drizzle-kit', '--version'],
    ['wrangler', '--version'],
  ]);
  expect(existsSync(join(cwd, '.handover-init.json'))).toBe(false);
  expect(existsSync(join(cwd, 'migrations/handover.json'))).toBe(false);
});

test('init accepts matching user-owned Wrangler and Drizzle configs without rewriting them', async () => {
  const wrangler =
    '{ "name": "custom-worker", "vars": { "R2_ACCOUNT_ID": "acc0unt1d", "R2_BUCKET": "my-site-media" }, "d1_databases": [{ "binding": "DB", "database_name": "my-site", "database_id": "db-uuid" }] }\n';
  const drizzle = [
    "import { defineConfig } from 'drizzle-kit';",
    'export default defineConfig({',
    "  dialect: 'sqlite',",
    "  schema: './node_modules/astro-handover/dist/schema.js',",
    "  out: './migrations',",
    '});',
    '',
  ].join('\n');
  const cwd = site({
    'package.json': '{ "name": "my-site" }',
    'wrangler.jsonc': wrangler,
    'drizzle.config.ts': drizzle,
  });
  const ran: string[][] = [];
  const { code } = await run(['init', 'you@example.com'], cwd, ran, {
    database: true,
    bucket: true,
  });

  expect(code).toBe(0);
  expect(readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8')).toBe(wrangler);
  expect(readFileSync(join(cwd, 'drizzle.config.ts'), 'utf8')).toBe(drizzle);
  expect(ran.some((a) => a.includes('create'))).toBe(false);
});

test('init verifies a configured database id in the selected account before creating one', async () => {
  const cwd = site({
    'package.json': '{ "name": "my-site" }',
    'wrangler.jsonc':
      '{ "vars": { "R2_ACCOUNT_ID": "acc0unt1d", "R2_BUCKET": "my-site-media" }, "d1_databases": [{ "binding": "DB", "database_name": "my-site", "database_id": "other-db" }] }\n',
  });
  const ran: string[][] = [];
  const { code, out } = await run(['init', 'you@example.com'], cwd, ran);

  expect(code).toBe(1);
  expect(out).toContain('configured D1 database other-db is not my-site in account acc0unt1d');
  expect(ran.some((argv) => argv.includes('create'))).toBe(false);
  expect(ran.some((argv) => argv.includes('migrations'))).toBe(false);
});

test.each([
  'wrangler d1 create my-site',
  'wrangler r2 bucket create my-site-media',
  'drizzle-kit generate --config .handover-drizzle.config.ts',
  'wrangler d1 migrations apply my-site --local',
  'wrangler d1 migrations apply my-site --remote',
  'wrangler d1 execute my-site --local',
  'wrangler d1 execute my-site --remote',
])('init resumes safely after interruption at %s', async (boundary) => {
  const cwd = site({ 'package.json': '{ "name": "my-site" }' });
  const calls: string[][] = [];
  const cloud: CloudState = {};
  let interrupt = true;
  const invoke = async () => {
    const out: string[] = [];
    const code = await main(['init', 'you@example.com'], {
      cwd,
      log: (line) => out.push(line),
      run: (argv) => {
        calls.push(argv);
        const command = argv.slice(0, argv[2] === 'execute' ? 5 : undefined).join(' ');
        if (argv.slice(0, 3).join(' ') === 'wrangler d1 create') cloud.database = true;
        if (argv.slice(0, 4).join(' ') === 'wrangler r2 bucket create') cloud.bucket = true;
        if (argv[0] === 'drizzle-kit' && argv[2] === '--config') {
          if (interrupt && command === boundary) {
            mkdirSync(join(cwd, '.handover-migrations/meta'), { recursive: true });
            writeFileSync(
              join(cwd, '.handover-migrations/meta/_journal.json'),
              JSON.stringify({ entries: [{ tag: '0000_missing_sql' }] }),
            );
          } else generateMigration(cwd);
        }
        if (interrupt && command === boundary) {
          interrupt = false;
          throw new Error('connection lost after the command');
        }
      },
      capture: (argv) => {
        calls.push(argv);
        if (argv.includes('whoami')) return WHOAMI;
        if (argv.includes('list')) return cloud.database ? D1_LIST : '[]';
        return '1.0.0';
      },
      probe: (argv) => {
        calls.push(argv);
        return cloud.bucket ? JSON.stringify({ name: 'my-site-media' }) : undefined;
      },
    });
    return { code, out: out.join('\n') };
  };

  const stopped = await invoke();
  expect(stopped).toMatchObject({
    code: 1,
    out: expect.stringContaining('npx handover init you@example.com'),
  });
  const resumed = await invoke();
  expect(resumed.code, resumed.out).toBe(0);
  expect(
    calls.filter((argv) => argv.slice(0, 4).join(' ') === 'wrangler d1 create my-site'),
  ).toHaveLength(1);
  expect(
    calls.filter(
      (argv) => argv.slice(0, 5).join(' ') === 'wrangler r2 bucket create my-site-media',
    ),
  ).toHaveLength(1);
  const seeds = calls.filter((argv) => argv[2] === 'execute');
  expect(new Set(seeds.map((argv) => argv[6])).size).toBe(1);
  expect(existsSync(join(cwd, '.handover-init.json'))).toBe(false);
  expect(existsSync(join(cwd, '.handover-drizzle.config.ts'))).toBe(false);
  expect(existsSync(join(cwd, '.handover-migrations'))).toBe(false);
  expect(migration(cwd)).toEqual({ schemaVersion: SCHEMA_VERSION });
});

test('init resumes after completed migrations moved into place but before their marker was stamped', async () => {
  const cwd = site({
    'package.json': '{ "name": "my-site" }',
    '.handover-init.json': `${JSON.stringify({
      version: 1,
      siteName: 'my-site',
      accountId: 'acc0unt1d',
      databaseId: 'db-uuid',
      bucketName: 'my-site-media',
      bucketReady: true,
      ownerEmail: 'you@example.com',
      ownerId: '10516ab2-5108-42a7-9bc2-3828f5a416ba',
    })}\n`,
    'wrangler.jsonc':
      '{ "vars": { "R2_ACCOUNT_ID": "acc0unt1d", "R2_BUCKET": "my-site-media" }, "d1_databases": [{ "binding": "DB", "database_name": "my-site", "database_id": "db-uuid" }] }\n',
    'drizzle.config.ts':
      "export default { dialect: 'sqlite', schema: './node_modules/astro-handover/dist/schema.js', out: './migrations' };\n",
  });
  generateMigration(cwd, 'migrations');
  const ran: string[][] = [];
  const { code } = await run(['init', 'you@example.com'], cwd, ran, {
    database: true,
    bucket: true,
  });

  expect(code).toBe(0);
  expect(ran.some((argv) => argv[0] === 'drizzle-kit' && argv[1] === 'generate')).toBe(false);
  expect(readFileSync(join(cwd, 'migrations/0000_generated.sql'), 'utf8')).toBe('-- generated\n');
  expect(migration(cwd)).toEqual({ schemaVersion: SCHEMA_VERSION });
});

function migration(cwd: string) {
  return JSON.parse(readFileSync(join(cwd, 'migrations/handover.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

test('init refuses an owner that is not an email address, before creating anything', async () => {
  const cwd = site({ 'package.json': '{ "name": "my-site" }' });
  const ran: string[][] = [];
  const { code, out } = await run(['init', "you'; DROP TABLE user; --"], cwd, ran);

  expect(code).toBe(1);
  expect(ran).toEqual([]);
  expect(out).toContain('is not an email address');
  expect(existsSync(join(cwd, 'wrangler.jsonc'))).toBe(false);
});

test('an unknown command prints usage and fails', async () => {
  const { code, out } = await run(['frobnicate'], site({}));
  expect(code).toBe(1);
  expect(out).toContain(
    'Usage: handover <init <owner-email> | migrate [--dry-run] | db generate [--check]>',
  );
});

const CONTENT_CONFIG = `import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { listing } from './content/schemas';

export const collections = {
  listings: defineCollection({
    loader: glob({ pattern: '**/*.yaml', base: './src/content/listings' }),
    schema: withReserved(listing),
  }),
  'field-notes': defineCollection({
    loader: glob({ pattern: '**/*.yaml', base: './src/content/field-notes' }),
    schema: z.object({ title: z.string() }),
  }),
  globals: defineCollection({
    loader: glob({ pattern: '**/*.yaml', base: './src/content/globals' }),
    schema: z.looseObject({}),
  }),
};
`;

test('init scaffolds a starter site whose globals key owes a file in the default language', async () => {
  const cwd = site({ 'package.json': '{ "name": "my-site" }' });
  const { code, out } = await run(['init', 'you@example.com'], cwd);

  expect(code).toBe(0);
  expect(readFileSync(join(cwd, 'cms.config.ts'), 'utf8')).toBe(
    [
      "import { defineConfig } from 'astro-handover';",
      "import { page, site } from './src/content/schemas';",
      '',
      'export default defineConfig({',
      '  // The same block is in astro.config.mjs; the build stops if the two disagree.',
      "  i18n: { locales: ['en'], defaultLocale: 'en' },",
      '  collections: {',
      "    pages: { schema: page, route: '/[slug]', load: 'page' },",
      '  },',
      '  // Site-wide content the client owns: one file per language under src/content/globals/.',
      '  globals: { site },',
      '});',
      '',
    ].join('\n'),
  );
  for (const path of [
    'src/content/schemas.ts',
    'src/content.config.ts',
    'src/blocks/registry.ts',
    'src/blocks/Hero.astro',
    'src/blocks/TextSection.astro',
    'src/layouts/Page.astro',
    'src/loaders/page.ts',
    'src/pages/[slug].astro',
    'src/content/pages/en/home.yaml',
    'src/content/globals/en/site.yaml',
  ])
    expect([path, existsSync(join(cwd, path))]).toEqual([path, true]);
  expect(out).toContain('Wrote src/content/globals/en/site.yaml');
});

test('init scaffolds a hero that resolves and positions a stored image', async () => {
  const cwd = site({ 'package.json': '{ "name": "my-site" }' });
  await run(['init', 'you@example.com'], cwd);

  const hero = readFileSync(join(cwd, 'src/blocks/Hero.astro'), 'utf8');
  expect(hero).toContain("import cms from '../../cms.config';");
  expect(hero).toMatch(
    /const media = \(key: string\) => `\$\{cms\.media\?\.publicBase}\/\$\{key}`;/,
  );
  expect(hero).toContain('const focal = block.image?.focal ?? [0.5, 0.5];');
  expect(hero).toContain('src={media(block.image.src)}');
  expect(hero).toMatch(
    /style=\{`object-position: \$\{focal\[0] \* 100}% \$\{focal\[1] \* 100}%`\}/,
  );
  expect(hero).toContain("alt={block.image.alt ?? ''}");
  expect(hero).toContain('width={block.image.width}');
  expect(hero).toContain('height={block.image.height}');
});

test('init takes the languages from astro.config.mjs rather than writing a second answer', async () => {
  const cwd = site({
    'package.json': '{ "name": "my-site" }',
    'astro.config.mjs': [
      "import { defineConfig } from 'astro/config';",
      'export default defineConfig({',
      "  i18n: { locales: ['en', 'de'], defaultLocale: 'de' },",
      '});',
      '',
    ].join('\n'),
  });
  const { code } = await run(['init', 'you@example.com'], cwd);

  expect(code).toBe(0);
  expect(readFileSync(join(cwd, 'cms.config.ts'), 'utf8')).toContain(
    "i18n: { locales: ['en', 'de'], defaultLocale: 'de' },",
  );
  // A global with no file in a language throws when that language renders, so both get one.
  expect(existsSync(join(cwd, 'src/content/globals/de/site.yaml'))).toBe(true);
  expect(existsSync(join(cwd, 'src/content/globals/en/site.yaml'))).toBe(true);
  expect(existsSync(join(cwd, 'src/content/pages/de/home.yaml'))).toBe(true);
  expect(existsSync(join(cwd, 'src/content/pages/en/home.yaml'))).toBe(false);
  expect(readFileSync(join(cwd, 'src/pages/[slug].astro'), 'utf8')).toContain("locale: 'de'");
  expect(readFileSync(join(cwd, 'src/pages/en/[slug].astro'), 'utf8')).toContain("locale: 'en'");
});

test('init reads the languages past a routing block nested in the i18n one', async () => {
  const cwd = site({
    'package.json': '{ "name": "my-site" }',
    'astro.config.mjs': [
      'export default defineConfig({',
      "  base: '/site',",
      "  i18n: { locales: ['en', 'de'], routing: { prefixDefaultLocale: true }, defaultLocale: 'de' },",
      '});',
      '',
    ].join('\n'),
  });
  await run(['init', 'you@example.com'], cwd);

  expect(readFileSync(join(cwd, 'cms.config.ts'), 'utf8')).toContain(
    "i18n: { locales: ['en', 'de'], defaultLocale: 'de', prefixDefaultLocale: true, base: '/site' },",
  );
  expect(existsSync(join(cwd, 'src/pages/[slug].astro'))).toBe(false);
  expect(readFileSync(join(cwd, 'src/pages/de/[slug].astro'), 'utf8')).toContain("locale: 'de'");
  expect(readFileSync(join(cwd, 'src/pages/en/[slug].astro'), 'utf8')).toContain("locale: 'en'");
});

test('init preserves a subpath and uses object locale paths in generated config and routes', async () => {
  const cwd = site({
    'package.json': '{ "name": "my-site" }',
    'astro.config.mjs': [
      "import { defineConfig } from 'astro/config';",
      'export default defineConfig({',
      "  base: '/site/',",
      '  i18n: {',
      "    locales: ['en', { path: 'german', codes: ['de', 'de-AT'] }],",
      "    defaultLocale: 'en',",
      '    routing: { prefixDefaultLocale: false },',
      '  },',
      '});',
      '',
    ].join('\n'),
  });
  const { code } = await run(['init', 'you@example.com'], cwd);

  expect(code).toBe(0);
  expect(readFileSync(join(cwd, 'cms.config.ts'), 'utf8')).toContain(
    "i18n: { locales: ['en', 'german'], defaultLocale: 'en', base: '/site' },",
  );
  expect(readFileSync(join(cwd, 'src/pages/[slug].astro'), 'utf8')).toContain("locale: 'en'");
  expect(readFileSync(join(cwd, 'src/pages/german/[slug].astro'), 'utf8')).toContain(
    "locale: 'german'",
  );
  expect(existsSync(join(cwd, 'src/pages/de/[slug].astro'))).toBe(false);
  expect(existsSync(join(cwd, 'src/pages/de-AT/[slug].astro'))).toBe(false);
  expect(existsSync(join(cwd, 'src/content/globals/german/site.yaml'))).toBe(true);
});

test.each([
  ["const locales = ['en', 'de'];", "i18n: { locales, defaultLocale: 'en' }", 'locales'],
  ['', "base: process.env.SITE_BASE, i18n: { locales: ['en'], defaultLocale: 'en' }", 'base'],
  [
    'const prefix = true;',
    "i18n: { locales: ['en'], defaultLocale: 'en', routing: { prefixDefaultLocale: prefix } }",
    'routing.prefixDefaultLocale',
  ],
])(
  'init stops with a manual step instead of guessing computed Astro %s settings',
  async (declaration, config, setting) => {
    const cwd = site({
      'package.json': '{ "name": "my-site" }',
      'astro.config.mjs': [
        declaration,
        'export default defineConfig({',
        `  ${config},`,
        '});',
        '',
      ].join('\n'),
    });
    const ran: string[][] = [];
    const { code, out } = await run(['init', 'you@example.com'], cwd, ran);

    expect(code).toBe(1);
    expect(out).toContain(
      `astro.config.mjs: i18n.${setting} is computed or uses an unsupported form`,
    );
    expect(out).toContain('create cms.config.ts and the page routes by hand');
    expect(ran).toEqual([
      ['drizzle-kit', '--version'],
      ['wrangler', '--version'],
    ]);
    expect(existsSync(join(cwd, 'cms.config.ts'))).toBe(false);
  },
);

test('init writes cms.config.ts from an existing content.config.ts and scaffolds nothing else', async () => {
  const cwd = site({
    'package.json': '{ "name": "my-site" }',
    'src/content.config.ts': CONTENT_CONFIG,
  });
  const { code, out } = await run(['init', 'you@example.com'], cwd);

  expect(code).toBe(0);
  expect(readFileSync(join(cwd, 'src/content.config.ts'), 'utf8')).toBe(CONTENT_CONFIG);
  const config = readFileSync(join(cwd, 'cms.config.ts'), 'utf8');
  expect(config).toContain("import { listing } from './src/content/schemas';");
  expect(config).toContain('    listings: { schema: listing },');
  expect(config).not.toContain('globals');
  expect(existsSync(join(cwd, 'src/content/schemas.ts'))).toBe(false);
  expect(existsSync(join(cwd, 'src/layouts/Page.astro'))).toBe(false);
  // The inline one cannot be imported, so it is named rather than guessed at.
  expect(out).toContain('field-notes');
  expect(out).toContain('src/content/schemas.ts');
});

test('init prints the App link and the secrets that are still owed', async () => {
  const cwd = site({ 'package.json': '{ "name": "my-site" }' });
  const { out } = await run(['init', 'you@example.com'], cwd);

  expect(out).toContain('https://github.com/settings/apps/new');
  for (const secret of [
    'BETTER_AUTH_SECRET',
    'GITHUB_APP_ID',
    'GITHUB_INSTALLATION_ID',
    'GITHUB_PRIVATE_KEY',
    'GITHUB_REPO',
    'HANDOVER_BASE_URL',
  ])
    expect(out).toContain(secret);
});

test('init scaffolds before it creates anything, so a nothing is left behind to trip over', async () => {
  const cwd = site({ 'package.json': '{ "name": "my-site" }' });
  const order: string[] = [];
  let database = false;
  let bucket = false;
  const note = (a: string[]) => {
    order.push(a.join(' '));
    if (a.slice(0, 3).join(' ') === 'wrangler d1 create') {
      order.push(`scaffolded=${existsSync(join(cwd, 'cms.config.ts'))}`);
      database = true;
    }
    if (a.slice(0, 4).join(' ') === 'wrangler r2 bucket create') bucket = true;
    if (a[0] === 'drizzle-kit' && a[2] === '--config') generateMigration(cwd);
  };
  await main(['init', 'you@example.com'], {
    cwd,
    log: () => {},
    run: note,
    capture: (a) => {
      note(a);
      if (a.includes('whoami')) return WHOAMI;
      if (a.includes('list')) return database ? D1_LIST : '[]';
      return '1.0.0';
    },
    probe: (a) => {
      note(a);
      return bucket ? JSON.stringify({ name: 'my-site-media' }) : undefined;
    },
  });
  expect(
    order.slice(
      order.indexOf('wrangler d1 create my-site'),
      2 + order.indexOf('wrangler d1 create my-site'),
    ),
  ).toEqual(['wrangler d1 create my-site', 'scaffolded=true']);
});

test.each([
  ['migrate', '--dryrun'],
  ['migrate', '--check'],
  ['migrate', 'file'],
  ['migrate', '--dry-run', '--dry-run'],
  ['db', 'generate', '--chek'],
  ['db', 'generate', '--dry-run'],
  ['db', 'generate', 'file'],
  ['init', '--unknown'],
])('invalid arguments %j never touch files or run external commands', async (...argv) => {
  const path = 'src/content/pages/en/home.yaml';
  const cwd = site({ [path]: OLD });
  const ran: string[][] = [];
  expect((await run(argv, cwd, ran)).code).toBe(1);
  expect(ran).toEqual([]);
  expect(readFileSync(join(cwd, path), 'utf8')).toBe(OLD);
  expect(existsSync(join(cwd, 'migrations'))).toBe(false);
});

test.each([['--help'], ['migrate', '--help'], ['db', 'generate', '--help'], ['init', '-h']])(
  'help %j is read-only',
  async (...argv) => {
    const cwd = site({ 'src/content/pages/en/home.yaml': OLD });
    const ran: string[][] = [];
    expect(await run(argv, cwd, ran)).toMatchObject({
      code: 0,
      out: expect.stringContaining('Usage:'),
    });
    expect(ran).toEqual([]);
    expect(readFileSync(join(cwd, 'src/content/pages/en/home.yaml'), 'utf8')).toBe(OLD);
    expect(existsSync(join(cwd, 'migrations'))).toBe(false);
  },
);
