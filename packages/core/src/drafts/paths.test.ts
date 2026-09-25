import type { Miniflare } from 'miniflare';
import { beforeAll, expect, test } from 'vitest';
import {
  draftDb,
  FILE,
  git,
  LISTING_DE,
  migrateTestD1,
  newTestD1,
  PATH,
  VALUES,
} from '../db.fixture.js';
import {
  beginOperation,
  finalizeOperation,
  markOperationCommitted,
} from '../publishing/operations.js';
import * as tables from '../tables.js';
import { drafts } from '../tables.js';
import { createDraft, loadDraft } from './drafts.js';

const mf = newTestD1();
let binding: Awaited<ReturnType<Miniflare['getD1Database']>>;
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  await migrateTestD1(binding);
});
const fresh = draftDb(() => binding);

test('rename reservations exclude creations in every destination locale and release on request', async () => {
  const { reservePaths, releasePaths } = await import('./paths.js');
  const db = await fresh();
  const paths = [PATH, LISTING_DE];
  const owner = await beginOperation('default', db, {
    retryKey: 'rename-reservation',
    kind: 'entry-rename',
    paths,
    baseSha: 'base',
  });
  const reservation = await reservePaths('default', db, paths, owner.id);
  for (const path of paths)
    await expect(createDraft('default', db, git, path, { title: 'Taken' })).rejects.toThrow();
  expect(await db.select().from(drafts)).toEqual([]);
  await releasePaths('default', db, reservation);
  await createDraft('default', db, git, PATH, { title: 'Allowed' });
  const other = await beginOperation('default', db, {
    retryKey: 'other-rename-reservation',
    kind: 'entry-rename',
    paths,
    baseSha: 'base',
  });
  await expect(reservePaths('default', db, paths, other.id)).rejects.toThrow();
  expect(await db.select().from(tables.pathReservations)).toEqual([]);
  expect((await loadDraft('default', db, PATH))?.contents).toContain('Allowed');
});

test('a rename retry rejoins its operation claim and an old token cannot cross a new claim', async () => {
  const { recordRenames } = await import('./committed.js');
  const { releaseOperationPaths, reservePaths, releasePaths } = await import('./paths.js');
  const db = await fresh();
  const destination = 'src/content/listings/en/recovered.yaml';
  await createDraft('default', db, git, PATH, VALUES);
  const originalOwner = await beginOperation('default', db, {
    retryKey: 'rename-original',
    kind: 'entry-rename',
    paths: [PATH, destination],
    baseSha: 'base',
  });
  const replacementOwner = await beginOperation('default', db, {
    retryKey: 'rename-replacement',
    kind: 'entry-rename',
    paths: [PATH, destination],
    baseSha: 'base',
  });
  const original = await reservePaths('default', db, [destination], originalOwner.id);
  expect(await reservePaths('default', db, [destination], originalOwner.id)).toEqual(original);
  await releasePaths('default', db, original);
  const replacement = await reservePaths('default', db, [destination], replacementOwner.id);

  await expect(
    recordRenames(
      'default',
      db,
      [{ from: PATH, to: destination, contents: FILE }],
      'commit-old',
      undefined,
      original,
    ),
  ).rejects.toThrow();
  expect(await loadDraft('default', db, PATH)).toBeDefined();
  expect(await loadDraft('default', db, destination)).toBeUndefined();
  expect(await db.select().from(tables.pathReservations)).toEqual([
    expect.objectContaining({
      operationId: replacementOwner.id,
      path: destination,
      token: replacement.token,
    }),
  ]);

  await markOperationCommitted('default', db, replacementOwner.id, 'commit-replacement', {});
  await finalizeOperation('default', db, replacementOwner.id);
  await createDraft('default', db, git, destination, { title: 'New owner' });
  expect(await loadDraft('default', db, destination)).toBeDefined();
  await releaseOperationPaths('default', db, replacementOwner.id);
  expect(await db.select().from(tables.pathReservations)).toEqual([]);
});
