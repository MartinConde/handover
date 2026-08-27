import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import {
  FORMAT_VERSION,
  migrateDocument,
  parseEntry,
  SCHEMA_VERSION,
  schemaVersionError,
  stringifyEntry,
  timestampErrors,
  versionOf,
} from '@handover/core';

const USAGE = 'Usage: handover <init <owner-email> | migrate [--dry-run] | db generate [--check]>';

export interface Env {
  cwd: string;
  log: (line: string) => void;
  /** Runs a bin from the site's node_modules, output straight to the terminal. */
  run: (argv: string[]) => void;
  /** The same, but returns what it wrote to stdout. */
  capture: (argv: string[]) => string;
}

export async function main(argv: string[], env: Env): Promise<number> {
  const [cmd, sub] = argv;
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  try {
    if (cmd === 'init' && argv.length === 2 && sub) return init(env, sub);
    if (cmd === 'migrate' && argv.length <= 2) return migrate(env, flags.has('--dry-run'));
    if (cmd === 'db' && sub === 'generate' && argv.length <= 3)
      return dbGenerate(env, flags.has('--check'));
  } catch (e) {
    env.log(e instanceof Error ? e.message : String(e));
    return 1;
  }
  env.log(USAGE);
  return 1;
}

/** The bindings the site needs; also what init prints when the config file is not its own. */
const bindings = (
  name: string,
  account: string,
  database: string,
) => `  // Not secrets: an account id and a bucket name. The keys that sign an upload are.
  "vars": { "R2_ACCOUNT_ID": "${account}", "R2_BUCKET": "${name}-media" },
  "d1_databases": [
    { "binding": "DB", "database_name": "${name}", "database_id": "${database}" }
  ]`;

const wranglerJsonc = (name: string, account: string, database: string) => `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "main": "./src/worker.ts",
  "triggers": { "crons": ["*/5 * * * *"] },
  "assets": { "binding": "ASSETS", "directory": "./dist" },
${bindings(name, account, database)}
}
`;

// The site's own Worker rather than the adapter's, because Handover has jobs as well as routes.
const WORKER = `import handler from '@astrojs/cloudflare/entrypoints/server';
import { scheduled } from 'astro-handover/cron';

export default { ...handler, scheduled };
`;

const DRIZZLE = `import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './node_modules/astro-handover/dist/schema.js',
  out: './migrations',
});
`;

const CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

function init(env: Env, email: string): number {
  if (!/^[^\s'"@]+@[^\s'"@]+\.[^\s'"@]+$/.test(email))
    throw new Error(`${email} is not an email address`);
  if (existsSync(join(env.cwd, 'migrations')))
    throw new Error('migrations/ is already here, and init only ever creates it. Nothing changed.');

  // Both bins before anything is created: a database and a bucket that outlive a run that
  // died on a missing dependency are what a second `init` then trips over.
  env.capture(['drizzle-kit', '--version']);
  const name = siteName(env.cwd);
  const account = accountId(env);
  env.run(['wrangler', 'd1', 'create', name]);
  env.run(['wrangler', 'r2', 'bucket', 'create', `${name}-media`]);
  const list = JSON.parse(env.capture(['wrangler', 'd1', 'list', '--json'])) as {
    uuid: string;
    name: string;
  }[];
  const database = list.find((d) => d.name === name)?.uuid;
  if (!database) throw new Error(`wrangler lists no database called ${name}`);

  const theirs = CONFIGS.find((f) => existsSync(join(env.cwd, f)));
  if (theirs) env.log(`${theirs} is yours; add these to it:\n${bindings(name, account, database)}`);
  else put(env, 'wrangler.jsonc', wranglerJsonc(name, account, database));
  put(env, 'src/worker.ts', WORKER);
  put(env, 'drizzle.config.ts', DRIZZLE);

  dbGenerate(env, false);
  for (const where of ['--local', '--remote'])
    env.run(['wrangler', 'd1', 'migrations', 'apply', name, where]);

  // A user row and nothing else: the first sign-in is an emailed link, so there is no
  // password for this command to invent and hand over.
  const seed = `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('${randomUUID()}', '${email.split('@')[0]}', '${email}', 1, 'owner', 0, 0)`;
  for (const where of ['--local', '--remote'])
    env.run(['wrangler', 'd1', 'execute', name, where, '--command', seed]);

  env.log(
    `${email} is an owner. They sign in with an emailed link and set a password on their account page, which needs a mailer and HANDOVER_BASE_URL; a site with neither gives them a password by hand instead (docs/auth.md).`,
  );
  return 0;
}

function siteName(cwd: string): string {
  let name = basename(cwd);
  try {
    name = (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).name as string) || name;
  } catch {}
  return name
    .replace(/^@/, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .toLowerCase();
}

/** Which account the resources are created in. Guessing one is creating them in the wrong place. */
function accountId(env: Env): string {
  const accounts = (JSON.parse(env.capture(['wrangler', 'whoami', '--json'])).accounts ?? []) as {
    id: string;
    name: string;
  }[];
  const wanted = process.env.CLOUDFLARE_ACCOUNT_ID;
  const chosen = wanted ? accounts.find((a) => a.id === wanted) : accounts[0];
  if (!chosen || (!wanted && accounts.length !== 1))
    throw new Error(
      `Set CLOUDFLARE_ACCOUNT_ID to one of these and run init again:\n${accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n')}`,
    );
  return chosen.id;
}

function put(env: Env, path: string, text: string): void {
  const full = join(env.cwd, path);
  if (existsSync(full)) {
    env.log(`${path} is already here; left alone`);
    return;
  }
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
  env.log(`Wrote ${path}`);
}

function migrate(env: Env, dryRun: boolean): number {
  const root = join(env.cwd, 'src/content');
  const paths = readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
    .map((e) => `src/content/${relative(root, join(e.parentPath, e.name)).split(sep).join('/')}`)
    .sort();
  const width = Math.max(0, ...paths.map((p) => p.length));
  const files = paths.map((path) => {
    const text = readFileSync(join(env.cwd, path), 'utf8');
    const doc = parseEntry('default', text) as Record<string, unknown> | null;
    if (!doc || typeof doc !== 'object') throw new Error(`${path}: not a YAML mapping`);
    let out: Record<string, unknown>;
    try {
      out = migrateDocument('default', doc);
    } catch (e) {
      throw new Error(`${path}: ${e instanceof Error ? e.message : e}`);
    }
    const from = typeof doc._version === 'number' ? String(doc._version) : 'none';
    const change = out === doc ? from : `${from} → ${FORMAT_VERSION}`;
    env.log(`${path.padEnd(width)}  ${change}`);
    return {
      path,
      out,
      changed: out !== doc,
      missing: from === 'none',
      version: versionOf(doc),
      dates: timestampErrors('default', path, text),
    };
  });
  const changed = files.filter((f) => f.changed);
  if (!dryRun)
    for (const f of changed) writeFileSync(join(env.cwd, f.path), stringifyEntry('default', f.out));
  const counts = new Map<number, number>();
  for (const f of files.filter((f) => !f.missing))
    counts.set(f.version, (counts.get(f.version) ?? 0) + 1);
  const missing = files.filter((f) => f.missing).length;
  const summary = [...counts].sort(([a], [b]) => a - b).map(([v, n]) => `${n} at version ${v}`);
  if (missing) summary.push(`${missing} without a version`);
  const n = changed.length;
  const tail = !n
    ? 'Nothing to write.'
    : dryRun
      ? `Dry run: ${n} would be written.`
      : `Wrote ${n} file${n === 1 ? '' : 's'}; commit ${n === 1 ? 'it' : 'them'}.`;
  env.log(`${files.length} files: ${summary.join(', ')}. ${tail}`);
  // Serialising quotes every string, so a file this run rewrote has had its dates fixed.
  const dates = files.filter((f) => dryRun || !f.changed).flatMap((f) => f.dates);
  for (const line of dates) env.log(line);
  return dates.length ? 1 : 0;
}

function dbGenerate(env: Env, check: boolean): number {
  const marker = join(env.cwd, 'migrations/handover.json');
  const read = () => {
    try {
      return readFileSync(marker, 'utf8');
    } catch {
      return undefined;
    }
  };
  if (check) {
    const error = schemaVersionError(read());
    env.log(error ?? `migrations/ is at schema version ${SCHEMA_VERSION}`);
    return error ? 1 : 0;
  }
  env.run(['drizzle-kit', 'generate']);
  mkdirSync(join(marker, '..'), { recursive: true });
  writeFileSync(marker, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION }, null, 2)}\n`);
  env.log(`migrations/handover.json records schema version ${SCHEMA_VERSION}`);
  return 0;
}

/** The runners for a real terminal: the bin is the site's own install, not ours. */
export function bins(cwd: string): Pick<Env, 'run' | 'capture'> {
  const path = (bin: string) => {
    const p = join(cwd, 'node_modules/.bin', bin);
    if (!existsSync(p)) throw new Error(`${bin} is not installed here: pnpm add -D ${bin}`);
    return p;
  };
  return {
    run: ([bin = '', ...args]) => void execFileSync(path(bin), args, { cwd, stdio: 'inherit' }),
    // stderr stays on the terminal so wrangler's own progress is still visible.
    capture: ([bin = '', ...args]) =>
      execFileSync(path(bin), args, {
        cwd,
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'inherit'],
      }),
  };
}
