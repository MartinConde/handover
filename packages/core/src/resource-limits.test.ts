import { beforeAll, expect, test } from 'vitest';
import { migrateTestD1, newTestD1 } from './db.fixture.js';
import { openDb } from './db.js';
import {
  claimCostlyOperation,
  claimResource,
  completeCostlyOperation,
  costlyOperationResult,
  ResourceLimitError,
  releaseResource,
} from './resource-limits.js';

const mf = newTestD1();
let binding: Awaited<ReturnType<typeof mf.getD1Database>>;

beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  await migrateTestD1(binding);
});

test('an expired owner cannot complete a lease after a new owner takes it', async () => {
  const db = openDb('paid-work-fence', binding);
  const old = await claimCostlyOperation('paid-work-fence', db, 'same', 'u1', 1);
  const current = await claimCostlyOperation('paid-work-fence', db, 'same', 'u2', 5 * 60_000 + 2);
  expect(current).toMatchObject({ owner: true, token: expect.any(String) });
  await completeCostlyOperation(
    'paid-work-fence',
    db,
    'same',
    old.token as string,
    { stale: true },
    5 * 60_000 + 3,
  );
  expect(await costlyOperationResult('paid-work-fence', db, 'same')).toBeUndefined();
  await completeCostlyOperation(
    'paid-work-fence',
    db,
    'same',
    current.token as string,
    { fresh: true },
    5 * 60_000 + 4,
  );
  expect(await costlyOperationResult('paid-work-fence', db, 'same')).toEqual({ fresh: true });
});

test('duplicate paid work joins one durable operation and reads its result', async () => {
  const db = openDb('paid-work', binding);
  const first = await claimCostlyOperation('paid-work', db, 'same', 'u1', 1);
  expect(first).toMatchObject({ owner: true, token: expect.any(String) });
  expect(await claimCostlyOperation('paid-work', db, 'same', 'u1', 2)).toMatchObject({
    owner: false,
  });
  await completeCostlyOperation(
    'paid-work',
    db,
    'same',
    first.token as string,
    { translated: true },
    3,
  );
  expect(await claimCostlyOperation('paid-work', db, 'same', 'u1', 4)).toEqual({
    owner: false,
    result: { translated: true },
  });
});

test('a persistent fixed-window budget refuses work beyond its allowance', async () => {
  const db = openDb('limits', binding);
  await claimResource('limits', db, {
    subject: 'u1',
    kind: 'translation',
    cost: 6,
    limit: 10,
    now: 1,
  });
  await expect(
    claimResource('limits', db, { subject: 'u1', kind: 'translation', cost: 5, limit: 10, now: 2 }),
  ).rejects.toThrow(ResourceLimitError);
});

test('a persistent concurrency claim is exclusive until released', async () => {
  const db = openDb('claims', binding);
  const first = await claimResource('claims', db, {
    subject: 'u1',
    kind: 'translate-active',
    cost: 1,
    limit: 1,
    windowMs: 60_000,
    now: 1,
  });
  await expect(
    claimResource('claims', db, {
      subject: 'u1',
      kind: 'translate-active',
      cost: 1,
      limit: 1,
      windowMs: 60_000,
      now: 2,
    }),
  ).rejects.toThrow(ResourceLimitError);
  await releaseResource('claims', db, first);
  await expect(
    claimResource('claims', db, {
      subject: 'u1',
      kind: 'translate-active',
      cost: 1,
      limit: 1,
      windowMs: 60_000,
      now: 3,
    }),
  ).resolves.toBeDefined();
});
