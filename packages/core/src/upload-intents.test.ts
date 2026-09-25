import { beforeAll, expect, test } from 'vitest';
import { migrateTestD1, newTestD1 } from './db.fixtures.js';
import { openDb } from './db.js';
import { claimUploadIntent, issueUploadIntent, markUploadStored } from './upload-intents.js';

const mf = newTestD1();
let binding: Awaited<ReturnType<typeof mf.getD1Database>>;
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  await migrateTestD1(binding);
});

test('an upload key is owned, expires, and can be consumed only once', async () => {
  const db = openDb('upload-intent', binding);
  const intent = {
    key: `uploads/12345678-1234-1234-1234-123456789abc/media/${'a'.repeat(64)}.webp`,
    userId: 'u1',
    hash: 'a'.repeat(64),
    bytes: 12,
    mime: 'image/webp',
    now: 1,
  };
  await issueUploadIntent('upload-intent', db, intent);
  await expect(
    claimUploadIntent('upload-intent', db, intent.key, 'u2', 2),
  ).resolves.toBeUndefined();
  const claimed = await claimUploadIntent('upload-intent', db, intent.key, 'u1', 2);
  expect(claimed).toMatchObject({ bytes: 12, mime: 'image/webp' });
  await expect(
    claimUploadIntent('upload-intent', db, intent.key, 'u1', 10 * 60_000),
  ).resolves.toBeUndefined();
  await markUploadStored('upload-intent', db, intent.key, 'u1');
  await expect(
    claimUploadIntent('upload-intent', db, intent.key, 'u1', 3),
  ).resolves.toBeUndefined();
});
