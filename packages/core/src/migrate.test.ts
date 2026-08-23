import { expect, test } from 'vitest';
import { FORMAT_VERSION } from './content.js';
import { MIGRATIONS, type MigrationStep, migrateDocument, versionOf } from './migrate.js';

const steps: MigrationStep[] = [
  { from: 1, up: (doc) => ({ ...doc, heading: doc.title }) },
  { from: 2, up: (doc) => ({ ...doc, heading: `${doc.heading}!` }) },
];

// CI lets a golden file change only when FORMAT_VERSION goes up (scripts/format-lock.sh);
// this is what makes that bump mean a step exists to carry the files already written.
test('every version below the current one has exactly one step, in order', () => {
  expect(MIGRATIONS.map((s) => s.from)).toEqual(
    Array.from({ length: FORMAT_VERSION - 1 }, (_, i) => i + 1),
  );
});

test('a missing _version reads as 1', () => {
  expect(versionOf({ title: 'Old' })).toBe(1);
  expect(versionOf({ _version: 2 })).toBe(2);
});

test('steps run in order from the file version to the target and stamp the target', () => {
  const out = migrateDocument('default', { _version: 1, title: 'Hi' }, { steps, to: 3 });
  expect(out).toEqual({ _version: 3, title: 'Hi', heading: 'Hi!' });
});

test('a file without _version starts at 1', () => {
  const out = migrateDocument('default', { title: 'Hi' }, { steps, to: 2 });
  expect(out).toEqual({ _version: 2, title: 'Hi', heading: 'Hi' });
});

test('a file already at the target is returned as it is', () => {
  const doc = { _version: 3, title: 'Hi' };
  expect(migrateDocument('default', doc, { steps, to: 3 })).toBe(doc);
});

test('a gap in the registry is an error naming the missing step', () => {
  expect(() =>
    migrateDocument('default', { _version: 1 }, { steps: steps.slice(1), to: 3 }),
  ).toThrow('no migration step from version 1');
});

test('a file newer than the package is an error', () => {
  expect(() => migrateDocument('default', { _version: 4 }, { steps, to: 3 })).toThrow(
    'version 4 is newer than this package knows (3)',
  );
});
