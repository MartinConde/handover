import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

async function run(argv: string[], cwd: string, ran: string[][] = []) {
  const out: string[] = [];
  const code = await main(argv, { cwd, log: (l) => out.push(l), run: (a) => void ran.push(a) });
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

test('an unknown command prints usage and fails', async () => {
  const { code, out } = await run(['frobnicate'], site({}));
  expect(code).toBe(1);
  expect(out).toContain('Usage: handover <migrate [--dry-run] | db generate [--check]>');
});
