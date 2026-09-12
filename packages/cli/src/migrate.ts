import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
import type { Env } from './index.js';

export function writeMigrationMarker(env: Env, marker: Record<string, unknown>): void {
  const path = join(env.cwd, 'migrations/handover.json');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(marker, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

export function migrate(env: Env, dryRun: boolean): number {
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

export function dbGenerate(env: Env, check: boolean): number {
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
  writeMigrationMarker(env, { schemaVersion: SCHEMA_VERSION });
  env.log(`migrations/handover.json records schema version ${SCHEMA_VERSION}`);
  return 0;
}
