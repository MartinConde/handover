import { expect, test } from 'vitest';
import { SCHEMA_VERSION, schemaVersionError } from './db.js';

test('a marker at the package version passes', () => {
  expect(schemaVersionError(`{ "schemaVersion": ${SCHEMA_VERSION} }`)).toBeUndefined();
});

test('no marker at all names the command to run', () => {
  expect(schemaVersionError(undefined)).toBe(
    `migrations/ has no handover.json: run \`npx handover db generate\` and commit migrations/`,
  );
});

test('a marker behind the package fails naming both versions', () => {
  expect(schemaVersionError('{ "schemaVersion": 0 }')).toBe(
    `astro-handover's tables are at schema version ${SCHEMA_VERSION} but migrations/ was generated for 0: run \`npx handover db generate\` and commit migrations/`,
  );
});

test('a marker ahead of the package fails too', () => {
  expect(schemaVersionError(`{ "schemaVersion": ${SCHEMA_VERSION + 1} }`)).toBe(
    `migrations/ was generated for schema version ${SCHEMA_VERSION + 1} but astro-handover's tables are at ${SCHEMA_VERSION}: the package is older than the migrations`,
  );
});
