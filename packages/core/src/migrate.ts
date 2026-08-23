import { FORMAT_VERSION } from './content.js';

export interface MigrationStep {
  /** The `_version` this step upgrades from; it writes `from + 1`. */
  from: number;
  up(doc: Record<string, unknown>): Record<string, unknown>;
}

/** One step per format version bump, in order. Empty while the format is at 1. */
export const MIGRATIONS: MigrationStep[] = [];

export function versionOf(doc: Record<string, unknown>): number {
  return typeof doc._version === 'number' ? doc._version : 1;
}

// A second run is a no-op because each step only sees files at its `from` version, so no
// step has to be idempotent on its own.
export function migrateDocument(
  _siteId: string,
  doc: Record<string, unknown>,
  { steps = MIGRATIONS, to = FORMAT_VERSION }: { steps?: MigrationStep[]; to?: number } = {},
): Record<string, unknown> {
  let version = versionOf(doc);
  if (version > to) throw new Error(`version ${version} is newer than this package knows (${to})`);
  if (version === to && doc._version === to) return doc;
  let out = doc;
  while (version < to) {
    const step = steps.find((s) => s.from === version);
    if (!step) throw new Error(`no migration step from version ${version}`);
    out = step.up(out);
    version += 1;
  }
  return { ...out, _version: to };
}
