import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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

const USAGE = 'Usage: handover <migrate [--dry-run] | db generate [--check]>';

export interface Env {
  cwd: string;
  log: (line: string) => void;
  /** Runs a bin from the site's node_modules, output straight to the terminal. */
  run: (argv: string[]) => void;
}

export async function main(argv: string[], env: Env): Promise<number> {
  const [cmd, sub] = argv;
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  try {
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
  writeFileSync(marker, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION }, null, 2)}\n`);
  env.log(`migrations/handover.json records schema version ${SCHEMA_VERSION}`);
  return 0;
}

/** The `run` for a real terminal: the bin is the site's own install, not ours. */
export function runBin(cwd: string): Env['run'] {
  return ([bin = '', ...args]) => {
    const path = join(cwd, 'node_modules/.bin', bin);
    if (!existsSync(path)) throw new Error(`${bin} is not installed here: pnpm add -D ${bin}`);
    execFileSync(path, args, { cwd, stdio: 'inherit' });
  };
}
