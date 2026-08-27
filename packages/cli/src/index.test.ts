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

async function run(
  argv: string[],
  cwd: string,
  ran: string[][] = [],
  capture = (a: string[]) => (a.includes('whoami') ? WHOAMI : D1_LIST),
) {
  const out: string[] = [];
  const code = await main(argv, {
    cwd,
    log: (l) => out.push(l),
    run: (a) => void ran.push(a),
    capture: (a) => {
      ran.push(a);
      return capture(a);
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
  expect(ran.slice(0, 8)).toEqual([
    ['drizzle-kit', '--version'],
    ['wrangler', 'whoami', '--json'],
    ['wrangler', 'd1', 'create', 'my-site'],
    ['wrangler', 'r2', 'bucket', 'create', 'my-site-media'],
    ['wrangler', 'd1', 'list', '--json'],
    ['drizzle-kit', 'generate'],
    ['wrangler', 'd1', 'migrations', 'apply', 'my-site', '--local'],
    ['wrangler', 'd1', 'migrations', 'apply', 'my-site', '--remote'],
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
    /^INSERT INTO user \(id, name, email, email_verified, role, created_at, updated_at\) VALUES \('[0-9a-f-]{36}', 'you', 'you@example.com', 1, 'owner', 0, 0\)$/,
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
  const { code, out } = await run(['init', 'you@example.com'], cwd);

  expect(code).toBe(0);
  expect(readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8')).toBe(existing);
  expect(out).toContain('wrangler.jsonc is yours');
  expect(out).toContain('"database_id": "db-uuid"');
});

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
